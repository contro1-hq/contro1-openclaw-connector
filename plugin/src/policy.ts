/**
* Classify one OpenClaw tool call.
*
* A `before_tool_call` hook fires for EVERY tool the model selects, including
* benign reads. So unlike the exec bridge - where OpenClaw already decided to
* stop - the default here MUST be "allow", or the assistant would pause on
* every step and become unusable. Only tool calls that match a sensitive
* pattern are turned into an approval.
*
* The classifier looks only at machine-observed inputs: the tool name and the
* arguments the model passed. It never reads any free-text the model wrote
* about its own intent.
*/

export type ToolVerdict =
  | { decision: 'allow' }
| { decision: 'require_approval'; severity: 'warning' | 'critical'; reason: string; allowAlways: boolean };

export type ToolPolicyConfig = {
  /** Regex sources matched against the tool name that always need a human. */
  sensitiveToolPatterns?: string[];
  /** Regex sources; a match promotes the call to critical (no standing trust). */
  criticalToolPatterns?: string[];
  /** Regex sources matched against the tool name that are always allowed, even if a sensitive pattern also matches. */
  allowToolPatterns?: string[];
  /** Regex sources; a match here overrides allowToolPatterns, even for get/list/read-shaped names. */
  sensitiveReadOverridePatterns?: string[];
  /** Param keys whose presence signals money movement or an external recipient. */
  sensitiveParamKeys?: string[];
};

export const DEFAULT_TOOL_POLICY: Required<ToolPolicyConfig> = {
  // Actions that leave the machine, spend, deploy, or destroy.
  sensitiveToolPatterns: [
    'send|email|mail|message|post|reply|dm|sms|whatsapp|telegram|slack',
    'buy|purchase|checkout|order|cart|pay|payment|invoice|charge|transfer|withdraw|refund',
    'deploy|release|publish|ship|rollout',
    'delete|remove|destroy|drop|truncate|wipe|rm\\b',
    'exec|shell|run_command|system\\.run|terminal',
    'browser.*(submit|purchase|checkout|login|fill)',
    'credential|secret|token|api_key|password|ssh',
    'grant|revoke|permission|role|access',
    ],
  // A subset that should never get a standing "allow-always".
  criticalToolPatterns: [
    'buy|purchase|checkout|pay|payment|transfer|withdraw|charge',
    'delete|destroy|drop|truncate|wipe',
    'deploy|release|publish|rollout',
    'credential|secret|token|api_key|password',
    ],
  // Reads and drafts that are safe even if a broad pattern matches (e.g. "read_message").
  allowToolPatterns: [
    '^(get|list|read|search|fetch|view|show|find|lookup|preview|draft)\\b',
    '^(get|list|read|search|fetch|view|show|find|lookup)_',
    ],
  // Reads that touch a secret store still need a human, even though their name
  // also looks like a safe "get_*/read_*" call (e.g. "read_credentials",
  // "get_secret", "fetch_api_key"). Without this override, allowToolPatterns
  // would short-circuit to "allow" before the credential/secret pattern below
  // is ever checked.
  sensitiveReadOverridePatterns: ['credential|secret|token|api_key|password|ssh|vault|keychain|keyring'],
  sensitiveParamKeys: ['amount', 'total', 'price', 'to', 'recipient', 'account', 'destination', 'quantity'],
};

export function loadToolPolicy(raw?: string | null): Required<ToolPolicyConfig> {
  if (!raw) return DEFAULT_TOOL_POLICY;
  const parsed = JSON.parse(raw) as ToolPolicyConfig;
  return { ...DEFAULT_TOOL_POLICY, ...parsed };
}

function anyMatch(patterns: string[], text: string): string | null {
  for (const source of patterns) {
    try {
      if (new RegExp(source, 'i').test(text)) return source;
    } catch {
      // Ignore an invalid operator-supplied pattern rather than crash the gateway.
    }
  }
  return null;
}

export function classifyToolCall(
  toolName: string,
  params: Record<string, unknown>,
  policy: Required<ToolPolicyConfig> = DEFAULT_TOOL_POLICY,
  ): ToolVerdict {
  const name = String(toolName || '');

// Explicit reads/drafts win: never pause them, even if a broad verb matches -
// unless the read targets a credential/secret store, which must still pause.
const sensitiveRead = anyMatch(policy.sensitiveReadOverridePatterns, name);
  if (!sensitiveRead && anyMatch(policy.allowToolPatterns, name)) return { decision: 'allow' };

const bySensitiveName = anyMatch(policy.sensitiveToolPatterns, name);
  const byParam = policy.sensitiveParamKeys.some((key) => key in params) ? 'sensitive-param' : null;

if (!bySensitiveName && !byParam) return { decision: 'allow' };

const critical = anyMatch(policy.criticalToolPatterns, name) !== null || sensitiveRead !== null;
  const reason = bySensitiveName
  ? `Tool "${name}" matches a sensitive pattern (${bySensitiveName}).`
    : `Tool "${name}" carries a sensitive parameter.`;

return {
  decision: 'require_approval',
  severity: critical ? 'critical' : 'warning',
  reason,
  // Critical actions never get a standing allow-always.
  allowAlways: !critical,
};
}
