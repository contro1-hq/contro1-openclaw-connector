import fs from 'node:fs';
import express from 'express';
import dotenv from 'dotenv';
import { Contro1Client, verifyCallback } from './core/contro1.js';
import { InMemoryPendingStore } from './core/store.js';
import { ApprovalBridge } from './bridge.js';
import { loadPolicy } from './policy.js';
import { OpenClawTransport } from './openclaw/types.js';
import { OpenClawCliTransport } from './openclaw/cli-transport.js';
import { OpenClawGatewayTransport } from './openclaw/gateway-transport.js';
import { MockOpenClawTransport } from './openclaw/mock-transport.js';

dotenv.config();

const port = Number(process.env.LISTENER_PORT || '8092');
const publicBaseUrl = (process.env.PUBLIC_BASE_URL || `http://localhost:${port}`).replace(/\/$/, '');
const webhookSecret = process.env.CONTRO1_WEBHOOK_SECRET || '';
const callbackMaxSkewSeconds = Number(process.env.CALLBACK_MAX_SKEW_SECONDS || '300');
const pollIntervalMs = Number(process.env.OPENCLAW_POLL_INTERVAL_MS || '3000');
const transportName = (process.env.OPENCLAW_TRANSPORT || 'cli').toLowerCase();
const allowAlways = (process.env.CONTRO1_GRANT_ALLOW_ALWAYS || 'false').toLowerCase() === 'true';

const policy = loadPolicy(process.env.CONTRO1_POLICY_FILE ? fs.readFileSync(process.env.CONTRO1_POLICY_FILE, 'utf8') : null);

const mockTransport = new MockOpenClawTransport();

function buildTransport(): OpenClawTransport {
  if (transportName === 'mock') return mockTransport;
  if (transportName === 'gateway') {
    return new OpenClawGatewayTransport({
      url: process.env.OPENCLAW_GATEWAY_URL || '',
      token: process.env.OPENCLAW_GATEWAY_TOKEN || '',
    });
  }
  return new OpenClawCliTransport({
    binary: process.env.OPENCLAW_BINARY,
    gatewayUrl: process.env.OPENCLAW_GATEWAY_URL,
    gatewayToken: process.env.OPENCLAW_GATEWAY_TOKEN,
  });
}

const transport = buildTransport();
const store = new InMemoryPendingStore();
const bridge = new ApprovalBridge({
  contro1: new Contro1Client(),
  transport,
  store,
  policy,
  publicBaseUrl,
  allowAlways,
});

const app = express();
app.use(
  express.json({
    // The signature covers the raw bytes. Keep them: verifying against a
    // re-serialized object will fail on any key ordering or whitespace change.
    verify: (req, _res, buffer) => {
      (req as express.Request & { rawBody?: string }).rawBody = buffer.toString('utf8');
    },
  }),
);

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, transport: transport.name, public_base_url: publicBaseUrl });
});

/**
 * Cooperative self-logging endpoint for the OpenClaw agent.
 *
 * The contro1-openclaw-agent skill teaches the assistant to POST here after
 * each autonomous action, so the background work it does when nobody is
 * watching still lands in a durable Contro1 audit trail. This is additive
 * evidence, not a gate: enforcement lives in the approval path, which does not
 * trust the agent to call anything.
 */
app.post('/agent/audit', async (req, res, next) => {
  try {
    const body = req.body || {};
    if (!body.action || !body.summary) {
      res.status(400).json({ error: 'action and summary are required' });
      return;
    }
    await bridge.logAutonomousAction(body);
    res.json({ logged: true });
  } catch (error) {
    next(error);
  }
});

/**
 * Contro1 posts the reviewer's decision here, signed.
 *
 * Everything before the signature check is untrusted input. A bad signature, a
 * stale timestamp, an unknown request id, or an action that has changed since
 * the reviewer saw it all end the same way: the command does not run.
 */
app.post('/contro1/callback', async (req, res, next) => {
  try {
    const rawBody = (req as express.Request & { rawBody?: string }).rawBody || '';
    const valid = verifyCallback(
      rawBody,
      req.headers['x-centcom-signature'],
      req.headers['x-centcom-timestamp'],
      webhookSecret,
      callbackMaxSkewSeconds,
    );
    if (!valid) {
      res.status(401).json({ error: 'invalid_signature' });
      return;
    }

    const outcome = await bridge.applyDecision(req.body || {});
    if (outcome.status === 'unknown_request') {
      res.status(404).json(outcome);
      return;
    }
    if (outcome.status === 'binding_mismatch') {
      res.status(409).json(outcome);
      return;
    }
    res.json(outcome);
  } catch (error) {
    next(error);
  }
});

/**
 * Mock-mode helper: inject a pending approval as if OpenClaw had raised one.
 * Only mounted when OPENCLAW_TRANSPORT=mock, so it cannot exist in a real
 * deployment.
 */
if (transportName === 'mock') {
  app.post('/mock/approvals', async (req, res, next) => {
    try {
      const approval = mockTransport.inject(req.body || {});
      const routed = await bridge.onApproval(approval);
      res.json({ injected: approval, routed_to_human: routed });
    } catch (error) {
      next(error);
    }
  });

  app.get('/mock/approvals/:id/decision', (req, res) => {
    res.json({ id: req.params.id, decision: mockTransport.decisionFor(req.params.id) || null });
  });
}

app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(error);
  res.status(500).json({ error: error.message });
});

app.listen(port, () => {
  console.log(`Contro1 OpenClaw approval bridge listening on :${port}`);
  console.log(`transport=${transport.name} callback=${publicBaseUrl}/contro1/callback`);
  if (!webhookSecret) {
    console.warn('CONTRO1_WEBHOOK_SECRET is not set. Every callback will be rejected, which is the correct failure mode.');
  }
});

// Poll OpenClaw for approvals nobody has routed yet. The mock transport is
// driven by POST /mock/approvals instead, so it does not need a timer.
if (transportName !== 'mock') {
  const tick = async () => {
    try {
      const result = await bridge.sync();
      if (result.created > 0) console.log(`Routed ${result.created} new OpenClaw approval(s) to Contro1.`);
    } catch (error) {
      console.error('OpenClaw poll failed:', (error as Error).message);
    }
  };
  setInterval(tick, pollIntervalMs).unref();
  void tick();
}

// Drop pending entries well past OpenClaw's 30-minute expiry so a long-running
// process does not accumulate state for approvals that can no longer be acted on.
setInterval(() => void store.sweep(60 * 60 * 1000), 5 * 60 * 1000).unref();
