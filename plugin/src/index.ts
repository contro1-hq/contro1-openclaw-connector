import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import { classifyToolCall, loadToolPolicy } from './policy.js';

/**
 * Contro1 Approvals - a thin OpenClaw plugin.
 *
 * Its only job is COVERAGE: turn any sensitive tool call (send an email, buy
 * something in the browser, delete a file, deploy) into a human approval, using
 * OpenClaw's own `before_tool_call` + `requireApproval` gate. It does not talk
 * to Contro1, holds no API keys, and makes no network calls. That keeps its
 * in-process footprint tiny - important, because OpenClaw plugins run inside the
 * gateway and are not sandboxed.
 *
 * GOVERNANCE stays out-of-process. When this plugin returns `requireApproval`,
 * OpenClaw raises a plugin approval that the external Contro1 bridge picks up
 * from `openclaw approvals pending` and routes to the right human, with role
 * routing, quorum, SLA, and signed evidence. The credential-bearing work lives
 * only in that bridge.
 *
 * Enable plugin approval forwarding so the bridge sees these:
 *   approvals.plugin.enabled = true
 */
const policy = loadToolPolicy(process.env.CONTRO1_TOOL_POLICY || null);

export default definePluginEntry({
  id: 'contro1-approvals',
  name: 'Contro1 Approvals',
  register(api) {
    api.on('before_tool_call', async (event) => {
      const verdict = classifyToolCall(event.toolName, event.params || {}, policy);
      if (verdict.decision !== 'require_approval') return; // let benign calls run

      return {
        requireApproval: {
          title: truncate(`Approve ${event.toolName}`, 80),
          // Keep the description factual and free of secrets - it renders on chat surfaces.
          description: truncate(verdict.reason, 512),
          severity: verdict.severity,
          allowedDecisions: verdict.allowAlways
            ? ['allow-once', 'allow-always', 'deny']
            : ['allow-once', 'deny'],
          timeoutMs: 120_000,
        },
      };
    });
  },
});

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
