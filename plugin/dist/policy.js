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
export const DEFAULT_TOOL_POLICY = {
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
    sensitiveParamKeys: ['amount', 'total', 'price', 'to', 'recipient', 'account', 'destination', 'quantity'],
};
export function loadToolPolicy(raw) {
    if (!raw)
        return DEFAULT_TOOL_POLICY;
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_TOOL_POLICY, ...parsed };
}
function anyMatch(patterns, text) {
    for (const source of patterns) {
        try {
            if (new RegExp(source, 'i').test(text))
                return source;
        }
        catch {
            // Ignore an invalid operator-supplied pattern rather than crash the gateway.
        }
    }
    return null;
}
export function classifyToolCall(toolName, params, policy = DEFAULT_TOOL_POLICY) {
    const name = String(toolName || '');
    // Explicit reads/drafts win: never pause them, even if a broad verb matches.
    if (anyMatch(policy.allowToolPatterns, name))
        return { decision: 'allow' };
    const bySensitiveName = anyMatch(policy.sensitiveToolPatterns, name);
    const byParam = policy.sensitiveParamKeys.some((key) => key in params) ? 'sensitive-param' : null;
    if (!bySensitiveName && !byParam)
        return { decision: 'allow' };
    const critical = anyMatch(policy.criticalToolPatterns, name) !== null;
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
