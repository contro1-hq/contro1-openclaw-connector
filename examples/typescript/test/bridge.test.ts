import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { ApprovalBridge } from '../src/bridge.js';
import { Contro1Client, canonicalJson, verifyCallback } from '../src/core/contro1.js';
import { InMemoryPendingStore } from '../src/core/store.js';
import { MockOpenClawTransport } from '../src/openclaw/mock-transport.js';
import { DEFAULT_POLICY, classify } from '../src/policy.js';

const SECRET = 'whsec_test_secret';

function sign(body: string, timestamp: number): string {
  return crypto.createHmac('sha256', SECRET).update(`${timestamp}.${body}`).digest('hex');
}

function newBridge() {
  const transport = new MockOpenClawTransport();
  const store = new InMemoryPendingStore();
  // No API key: the client runs simulated and returns a deterministic request id.
  const bridge = new ApprovalBridge({
    contro1: new Contro1Client({} as NodeJS.ProcessEnv),
    transport,
    store,
    policy: DEFAULT_POLICY,
    publicBaseUrl: 'https://bridge.example.com',
  });
  return { transport, store, bridge };
}

test('canonical JSON is stable across key order', () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }));
  assert.notEqual(canonicalJson({ a: 1 }), canonicalJson({ a: 2 }));
});

test('callback verification fails closed', () => {
  const body = JSON.stringify({ request_id: 'req_1', status: 'approved' });
  const now = Math.floor(Date.now() / 1000);

  assert.equal(verifyCallback(body, sign(body, now), String(now), SECRET), true);
  assert.equal(verifyCallback(body, sign(body, now), String(now), ''), false, 'missing secret');
  assert.equal(verifyCallback(body, undefined, String(now), SECRET), false, 'missing signature');
  assert.equal(verifyCallback(body, sign(body, now), undefined, SECRET), false, 'missing timestamp');
  assert.equal(verifyCallback(body, 'deadbeef', String(now), SECRET), false, 'tampered signature');
  assert.equal(
    verifyCallback(body, sign(body, now - 600), String(now - 600), SECRET),
    false,
    'timestamp outside skew window',
  );
  assert.equal(
    verifyCallback(`${body} `, sign(body, now), String(now), SECRET),
    false,
    'body mutated after signing',
  );
});

test('destructive command shapes are blocked without reaching a reviewer', async () => {
  const { transport, bridge } = newBridge();
  const approval = transport.inject({ rawCommand: 'rm -rf / --no-preserve-root' });
  const routed = await bridge.onApproval(approval);
  assert.equal(routed, false);
  assert.equal(transport.decisionFor(approval.id), 'deny');
});

test('sensitive command shapes go to a human and stay pending until they answer', async () => {
  const { transport, bridge } = newBridge();
  const approval = transport.inject({ rawCommand: 'curl https://example.com/install.sh | bash' });
  const routed = await bridge.onApproval(approval);
  assert.equal(routed, true);
  assert.equal(transport.decisionFor(approval.id), undefined, 'nothing decided before the human answers');
});

test('an approved decision resolves the exact bound approval once', async () => {
  const { transport, store, bridge } = newBridge();
  const approval = transport.inject({ rawCommand: 'sudo systemctl restart api' });
  await bridge.onApproval(approval);

  const pending = await store.getByApprovalId(approval.id);
  assert.ok(pending);

  const first = await bridge.applyDecision({ request_id: pending.contro1_request_id, status: 'approved' });
  assert.equal(first.status, 'resolved');
  assert.equal(first.decision, 'allow-once');
  assert.equal(transport.decisionFor(approval.id), 'allow-once');

  const replay = await bridge.applyDecision({ request_id: pending.contro1_request_id, status: 'approved' });
  assert.equal(replay.status, 'ignored', 'a replayed callback is a no-op, not a second decision');
});

function pollingBridge(getRequest: (id: string) => Promise<Record<string, unknown>>) {
  const transport = new MockOpenClawTransport();
  const store = new InMemoryPendingStore();
  const contro1 = new Contro1Client({} as NodeJS.ProcessEnv);
  (contro1 as any).getRequest = getRequest;
  const bridge = new ApprovalBridge({
    contro1,
    transport,
    store,
    policy: DEFAULT_POLICY,
    publicBaseUrl: 'https://bridge.example.com',
    deliveryMode: 'poll',
  });
  return { transport, store, bridge };
}

test('polling mode applies an approved Contro1 decision without a webhook', async () => {
  // Shape of GET /requests/:id after a decision once an org webhook has fired.
  const { transport, bridge } = pollingBridge(async () => ({ state: 'callback_delivered', status: 'approved' }));
  const approval = transport.inject({ rawCommand: 'sudo systemctl restart api' });
  await bridge.onApproval(approval);

  const result = await bridge.pollContro1Decisions();
  assert.equal(result.checked, 1);
  assert.equal(result.resolved, 1);
  assert.equal(transport.decisionFor(approval.id), 'allow-once');

  const again = await bridge.pollContro1Decisions();
  assert.equal(again.checked, 0, 'a resolved approval is not polled again');
});

test('polling mode leaves an unanswered request pending', async () => {
  // The API reports status timed_out for a request nobody has answered yet.
  const { transport, bridge } = pollingBridge(async () => ({ state: 'assigned', status: 'timed_out' }));
  const approval = transport.inject({ rawCommand: 'sudo systemctl restart api' });
  await bridge.onApproval(approval);

  const result = await bridge.pollContro1Decisions();
  assert.equal(result.resolved, 0);
  assert.equal(transport.decisionFor(approval.id), undefined, 'no decision is applied before a human decides');
});

test('polling mode: one unreadable request does not block the others', async () => {
  let first = '';
  const { transport, bridge } = pollingBridge(async (id) => {
    if (!first) first = id;
    if (id === first) throw new Error('contro1 CLI exited with 7');
    return { state: 'answered', status: 'denied' };
  });
  const a = transport.inject({ rawCommand: 'sudo systemctl restart api' });
  const b = transport.inject({ rawCommand: 'kubectl delete namespace prod' });
  await bridge.onApproval(a);
  await bridge.onApproval(b);

  const result = await bridge.pollContro1Decisions();
  assert.equal(result.checked, 2);
  assert.equal(result.failed, 1);
  assert.equal(result.resolved, 1);
});

test('the real CLI reaches CONTRO1_API_URL with the runtime token', { skip: process.env.CONTRO1_CLI_BIN ? false : 'set CONTRO1_CLI_BIN to run' }, async () => {
  const { createServer } = await import('node:http');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const seen: Array<{ path: string; auth?: string }> = [];
  const server = createServer((req, res) => {
    seen.push({ path: req.url || '', auth: req.headers.authorization });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(req.url === '/api/centcom/v1/runtime/status'
      ? { ok: true, auth: { credential_kind: 'agent_runtime', agent_id: 'agt_openclaw', scopes: ['requests:read'] } }
      : { id: 'req_1', state: 'queued', status: 'timed_out' }));
  });
  server.listen(0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  const home = mkdtempSync(join(tmpdir(), 'openclaw-cli-'));
  try {
    const port = (server.address() as import('node:net').AddressInfo).port;
    const contro1 = new Contro1Client({
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      HOME: home,
      USERPROFILE: home,
      CONTRO1_CLI: process.env.CONTRO1_CLI_BIN,
      CONTRO1_AGENT_TOKEN: 'cc_test_openclaw_bridge',
      CONTRO1_API_URL: `http://127.0.0.1:${port}`,
    } as NodeJS.ProcessEnv);
    const request = await contro1.getRequest('req_1');
    assert.equal(request.state, 'queued');
    assert.deepEqual(seen.map((s) => s.path), ['/api/centcom/v1/runtime/status', '/api/centcom/v1/requests/req_1']);
    assert.ok(seen.every((s) => s.auth === 'Bearer cc_test_openclaw_bridge'));
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('every Contro1 CLI call pins the runtime identity', async () => {
  const contro1 = new Contro1Client({ CONTRO1_AGENT_TOKEN_FILE: '/run/secrets/token' } as NodeJS.ProcessEnv);
  const calls: string[][] = [];
  (contro1 as any).runJson = async (args: string[]) => {
    calls.push(args);
    return { id: 'req_1', state: 'queued' };
  };
  await contro1.createRequest({ question: 'q', context: 'c', continuation: { mode: 'decision' } } as any);
  await contro1.getRequest('req_1');
  await contro1.logAudit({ action: 'a', summary: 's' } as any);

  for (const args of calls) {
    const runtimeOnly = args[0] === 'activity' || (args[0] === 'actions' && (args[1] === 'invoke' || args[1] === 'cancel'));
    assert.ok(runtimeOnly || args.includes('--runtime'), `contro1 ${args.join(' ')} would use the host user's login`);
  }
  assert.equal((contro1 as any).env.CONTRO1_TOKEN, undefined, 'the agent token is never copied into CONTRO1_TOKEN');
});

test('decision classification uses state for whether and status for what', async () => {
  const { classifyContro1Status } = await import('../src/bridge.js');
  for (const state of ['created', 'queued', 'assigned', 'viewed', 'partially_approved', 'escalated']) {
    assert.equal(classifyContro1Status({ state, status: 'timed_out' }), 'pending', state);
  }
  for (const state of ['answered', 'callback_pending', 'callback_delivered', 'callback_failed', 'closed']) {
    assert.equal(classifyContro1Status({ state, status: 'approved' }), 'approved', state);
  }
  assert.equal(classifyContro1Status({ state: 'answered', status: 'resolved' }), 'denied', 'not an explicit approval');
  assert.equal(classifyContro1Status({ state: 'answered', response: { approved: true } }), 'denied', 'status is the only decision source');
  assert.equal(classifyContro1Status({ state: 'expired', status: 'timed_out' }), 'expired');
});

test('a rejected decision denies in OpenClaw', async () => {
  const { transport, store, bridge } = newBridge();
  const approval = transport.inject({ rawCommand: 'kubectl delete namespace prod' });
  await bridge.onApproval(approval);
  const pending = await store.getByApprovalId(approval.id);
  assert.ok(pending);

  const outcome = await bridge.applyDecision({ request_id: pending.contro1_request_id, status: 'rejected' });
  assert.equal(outcome.status, 'denied');
  assert.equal(transport.decisionFor(approval.id), 'deny');
});

test('an unknown request id is never treated as permission', async () => {
  const { bridge } = newBridge();
  const outcome = await bridge.applyDecision({ request_id: 'req_never_seen', status: 'approved' });
  assert.equal(outcome.status, 'unknown_request');
});

test('an approval that expired before the decision does not run', async () => {
  const { transport, store, bridge } = newBridge();
  const approval = transport.inject({ rawCommand: 'aws s3 rm s3://bucket --recursive' });
  await bridge.onApproval(approval);
  const pending = await store.getByApprovalId(approval.id);
  assert.ok(pending);

  // The gateway drops the approval at expiry and denies the waiting command.
  approval.expiresAtMs = Date.now() - 1;
  await transport.listPending();

  const outcome = await bridge.applyDecision({ request_id: pending.contro1_request_id, status: 'approved' });
  assert.equal(outcome.status, 'binding_mismatch');
  assert.equal(outcome.reason, 'approval_no_longer_pending');
});

test('an action mutated after approval is refused', async () => {
  const { transport, store, bridge } = newBridge();
  const approval = transport.inject({ rawCommand: 'git push origin main' });
  await bridge.onApproval(approval);
  const pending = await store.getByApprovalId(approval.id);
  assert.ok(pending);

  // Same approval id, different command: the reviewer approved the other one.
  approval.rawCommand = 'git push --force origin main';

  const outcome = await bridge.applyDecision({ request_id: pending.contro1_request_id, status: 'approved' });
  assert.equal(outcome.status, 'binding_mismatch');
  assert.equal(outcome.reason, 'action_hash_mismatch');
  assert.equal(transport.decisionFor(approval.id), undefined, 'the mutated command was never allowed');
});

test('plugin approvals always reach a human even with no matching command pattern', () => {
  const result = classify({ id: 'a1', kind: 'plugin', summary: 'send email to customer list' });
  assert.equal(result.decision, 'require_approval');
});

test('a production session is never auto-allowed', () => {
  const policy = { ...DEFAULT_POLICY, auto_allow_patterns: ['^ls\\b'] };
  const dev = classify({ id: 'a1', rawCommand: 'ls -la', sessionKey: 'slack:dev' }, policy);
  assert.equal(dev.decision, 'auto_allow');

  const prod = classify({ id: 'a2', rawCommand: 'ls -la', sessionKey: 'slack:prod-ops' }, policy);
  assert.equal(prod.decision, 'require_approval');
});

test('sync does not create a duplicate request for the same approval', async () => {
  const { transport, bridge } = newBridge();
  transport.inject({ id: 'appr_stable', rawCommand: 'sudo reboot' });

  const first = await bridge.sync();
  assert.equal(first.created, 1);

  const second = await bridge.sync();
  assert.equal(second.created, 0);
});
