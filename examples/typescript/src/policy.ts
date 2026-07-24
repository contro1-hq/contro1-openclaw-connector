import { RiskLevel } from './core/contro1.js';
import { OpenClawPendingApproval, approvalSummary } from './openclaw/types.js';

export type PolicyDecision = 'auto_allow' | 'require_approval' | 'block';

export type PolicyResult = {
  decision: PolicyDecision;
  risk: RiskLevel;
  rule_id: string;
  reason: string;
  required_role: string;
  sla_minutes: number;
  comment_required: boolean;
};

export type PolicyConfig = {
  /** Agents allowed to raise approvals at all. Empty means "any". */
  allowed_agents?: string[];
  /** Regex sources matched against the command; a hit is always blocked. */
  block_patterns?: string[];
  /** Regex sources matched against the command; a hit always needs a human. */
  approval_patterns?: string[];
  /** Regex sources for commands safe enough to allow without a human. */
  auto_allow_patterns?: string[];
  /** Reviewer role for anything that reaches a human. */
  default_required_role?: string;
  default_sla_minutes?: number;
  /** Sessions or agents that are treated as production and never auto-allowed. */
  production_session_patterns?: string[];
};

/**
 * Defaults are deliberately conservative: nothing is auto-allowed unless the
 * operator opts into it, and a handful of unambiguously destructive shapes are
 * blocked outright so they never reach a reviewer to be rubber-stamped.
 */
export const DEFAULT_POLICY: Required<Omit<PolicyConfig, 'allowed_agents'>> & { allowed_agents: string[] } = {
  allowed_agents: [],
  block_patterns: [
    'rm\\s+-rf\\s+/(?:\\s|$)',
    ':\\(\\)\\s*\\{.*\\};\\s*:',
    'mkfs\\.',
    'dd\\s+if=.*of=/dev/',
  ],
  approval_patterns: [
    '\\bcurl\\b.*\\|\\s*(?:ba)?sh',
    '\\bwget\\b.*\\|\\s*(?:ba)?sh',
    '\\bsudo\\b',
    '\\bssh\\b',
    '\\bkubectl\\b',
    '\\bterraform\\b\\s+(?:apply|destroy)',
    '\\baws\\b',
    '\\bgcloud\\b',
    '\\bdocker\\b\\s+(?:run|exec)',
    '\\bgit\\b\\s+push',
    '\\bnpm\\b\\s+publish',
    '\\brm\\b\\s+-rf',
    '\\bchmod\\b\\s+777',
    '/\\.ssh/',
    '\\.env\\b',
    '\\bAWS_SECRET|\\bAPI_KEY|\\bPRIVATE_KEY',
  ],
  auto_allow_patterns: [],
  default_required_role: 'platform',
  default_sla_minutes: 15,
  production_session_patterns: ['prod', 'production'],
};

export function loadPolicy(raw?: string | null): PolicyConfig {
  if (!raw) return DEFAULT_POLICY;
  const parsed = JSON.parse(raw) as PolicyConfig;
  return { ...DEFAULT_POLICY, ...parsed };
}

function anyMatch(patterns: string[] | undefined, text: string): string | null {
  for (const source of patterns || []) {
    try {
      if (new RegExp(source, 'i').test(text)) return source;
    } catch {
      console.warn(`Ignoring invalid policy pattern: ${source}`);
    }
  }
  return null;
}

/**
 * Classify one OpenClaw approval.
 *
 * Every input to this function is machine-observed: the command OpenClaw
 * captured, the agent id it attributed the run to, the session it came from.
 * Nothing the model wrote about its own intentions is consulted, because a
 * justification the agent authored cannot be evidence about the agent.
 */
export function classify(approval: OpenClawPendingApproval, policy: PolicyConfig = DEFAULT_POLICY): PolicyResult {
  const requiredRole = policy.default_required_role || DEFAULT_POLICY.default_required_role;
  const slaMinutes = policy.default_sla_minutes ?? DEFAULT_POLICY.default_sla_minutes;
  const command = [approval.rawCommand, approval.command, (approval.argv || []).join(' '), approvalSummary(approval)]
    .filter(Boolean)
    .join(' ');
  const sessionKey = approval.sessionKey || '';

  const base = { required_role: requiredRole, sla_minutes: slaMinutes };

  if (policy.allowed_agents?.length && approval.agentId && !policy.allowed_agents.includes(approval.agentId)) {
    return {
      ...base,
      decision: 'block',
      risk: 'critical',
      rule_id: 'unknown-agent',
      reason: `Agent ${approval.agentId} is not on the allowed agent list.`,
      comment_required: true,
    };
  }

  const blocked = anyMatch(policy.block_patterns, command);
  if (blocked) {
    return {
      ...base,
      decision: 'block',
      risk: 'critical',
      rule_id: 'blocked-command-shape',
      reason: `Command matches a blocked pattern (${blocked}) and is denied without reaching a reviewer.`,
      comment_required: true,
    };
  }

  const isProduction = anyMatch(policy.production_session_patterns, sessionKey) !== null;

  // Plugin and system-agent approvals are not shell commands, so command
  // pattern matching says nothing useful about them. They always go to a human.
  const kind = approval.kind || 'exec';
  if (kind !== 'exec') {
    return {
      ...base,
      decision: 'require_approval',
      risk: isProduction ? 'high' : 'medium',
      rule_id: `${kind}-approval`,
      reason: `OpenClaw raised a ${kind} approval; these are reviewed by a human by default.`,
      comment_required: isProduction,
    };
  }

  const needsApproval = anyMatch(policy.approval_patterns, command);
  if (needsApproval) {
    return {
      ...base,
      decision: 'require_approval',
      risk: isProduction ? 'critical' : 'high',
      rule_id: 'sensitive-command-shape',
      reason: `Command matches a sensitive pattern (${needsApproval}).`,
      comment_required: true,
    };
  }

  if (isProduction) {
    return {
      ...base,
      decision: 'require_approval',
      risk: 'high',
      rule_id: 'production-session',
      reason: `Session ${sessionKey} is treated as production, so no command is auto-allowed.`,
      comment_required: true,
    };
  }

  const autoAllowed = anyMatch(policy.auto_allow_patterns, command);
  if (autoAllowed) {
    return {
      ...base,
      decision: 'auto_allow',
      risk: 'low',
      rule_id: 'auto-allow-pattern',
      reason: `Command matches an operator-configured auto-allow pattern (${autoAllowed}).`,
      comment_required: false,
    };
  }

  // Default: OpenClaw already decided this command was worth stopping for.
  // Absent an explicit auto-allow rule, that judgment stands.
  return {
    ...base,
    decision: 'require_approval',
    risk: 'medium',
    rule_id: 'default-require-approval',
    reason: 'OpenClaw stopped this command for approval and no auto-allow rule matched.',
    comment_required: false,
  };
}
