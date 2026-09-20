/**
 * Types for the OpenClaw approval surface.
 *
 * Verified against OpenClaw docs at release v2026.7.1 (2026-07-13):
 *   - docs.openclaw.ai/gateway/protocol
 *   - docs.openclaw.ai/tools/exec-approvals
 *   - docs.openclaw.ai/tools/exec-approvals-advanced
 *   - docs.openclaw.ai/cli/approvals
 */

/** The three decisions OpenClaw accepts on `approvals resolve`. */
export type OpenClawDecision = 'allow-once' | 'allow-always' | 'deny';

/**
 * Approval kinds the gateway tracks. `openclaw approvals pending` lists exec,
 * plugin and OpenClaw system-agent approvals together.
 */
export type OpenClawApprovalKind = 'exec' | 'plugin' | 'system-agent' | string;

/**
 * A pending approval as returned under `approvals` by
 * `openclaw approvals pending --json`.
 *
 * `id`, `summary`, `createdAtMs` and `expiresAtMs` are the documented,
 * script-stable fields. Everything else is best-effort: the CLI sanitizes its
 * projection, so treat unknown extras as optional and never depend on them for
 * a security decision.
 */
export type OpenClawPendingApproval = {
  id: string;
  kind?: OpenClawApprovalKind;
  summary?: string;
  createdAtMs?: number;
  expiresAtMs?: number;
  agentId?: string;
  sessionKey?: string;
  host?: string;
  command?: string;
  rawCommand?: string;
  cwd?: string;
  argv?: string[];
  allowedDecisions?: OpenClawDecision[];
  [key: string]: unknown;
};

export type OpenClawPendingResponse = {
  approvals?: OpenClawPendingApproval[];
};

/**
 * How the bridge reaches OpenClaw. Both implementations resolve approvals with
 * the same three decisions; they differ only in how they learn about them.
 */
export interface OpenClawTransport {
  /** Every approval currently awaiting a decision. */
  listPending(): Promise<OpenClawPendingApproval[]>;
  /** Apply a decision. First answer wins on the gateway side. */
  resolve(approvalId: string, decision: OpenClawDecision, reason?: string): Promise<void>;
  /** Human-readable name, used in logs and audit records. */
  readonly name: string;
}

/**
 * Normalize an approval into the machine-observed facts a reviewer decides on.
 *
 * Only fields OpenClaw itself produced belong here. If the agent authored the
 * text, it goes in `agent_reported` instead, where it can inform a human but
 * cannot change risk, routing, or the action binding.
 */
export function machineObservedFacts(approval: OpenClawPendingApproval): Record<string, unknown> {
  return {
    approval_id: approval.id,
    kind: approval.kind || 'exec',
    agent_id: approval.agentId ?? null,
    session_key: approval.sessionKey ?? null,
    host: approval.host ?? null,
    command: approval.command ?? null,
    raw_command: approval.rawCommand ?? null,
    argv: approval.argv ?? null,
    cwd: approval.cwd ?? null,
    created_at_ms: approval.createdAtMs ?? null,
    expires_at_ms: approval.expiresAtMs ?? null,
  };
}

/** The one-line description OpenClaw produced for this approval. */
export function approvalSummary(approval: OpenClawPendingApproval): string {
  return (
    approval.summary ||
    approval.rawCommand ||
    approval.command ||
    (approval.argv || []).join(' ') ||
    `${approval.kind || 'exec'} approval ${approval.id}`
  );
}

/**
 * Who is able to instruct an OpenClaw assistant.
 *
 * THE TRANSPORT DOES NOT ANSWER THIS, AND IT IS TEMPTING TO THINK IT DOES.
 * The local CLI transport says the BRIDGE reaches OpenClaw over a local socket
 * as one operating system user. That protects the credential. It says nothing
 * about who can talk to the assistant, because OpenClaw answers on WhatsApp,
 * Telegram, iMessage, Signal and Slack, and any of those can be a group.
 *
 * `sessionKey` and `host` on an approval cannot answer it either: they are
 * best-effort projections, and this file already states that they are never the
 * basis of a security decision.
 *
 * So the honest default is `unknown`, which Contro1 reads exactly the way it
 * reads a group chat: other people can instruct this assistant, and it may not
 * use a personal account without somebody deciding so by name.
 *
 * An operator who knows better can say so with CONTRO1_OPENCLAW_REACH=private,
 * and that is a claim with a person behind it rather than an inference. It is
 * true for a headless assistant with no chat channels wired up, and it stops
 * being true the moment one is added, which is why nothing here tries to work
 * it out on the assistant's behalf.
 */
export type DeclaredReach = 'private' | 'unknown';

export function reachForOpenClaw(params: { declared?: string; host?: string }): {
  kind: 'private' | 'shared' | 'unknown';
  label: string;
  participants_known: boolean;
} {
  const where = params.host || 'this computer';
  if (params.declared === 'private') {
    return { kind: 'private', label: `OpenClaw on ${where}, declared single-operator`, participants_known: true };
  }
  return {
    kind: 'unknown',
    label: `OpenClaw on ${where}`,
    participants_known: false,
  };
}
