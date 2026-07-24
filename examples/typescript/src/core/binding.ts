import { stableHash } from './contro1.js';

/**
 * An approval is permission for one exact action, not a standing licence.
 *
 * OpenClaw already enforces this on its own side: the gateway stores the
 * canonical `systemRunPlan` at approval time and rejects a forwarded
 * `node.invoke system.run` whose command, rawCommand, cwd, agentId or
 * sessionKey no longer matches. The bridge mirrors that rule on the Contro1
 * side so a reviewer's decision can never be replayed onto a different action.
 */
export type ActionBinding = {
  /** OpenClaw's canonical approval id. */
  approval_id: string;
  /** exec | plugin | system-agent. */
  kind: string;
  /** sha256 over the facts the reviewer was actually shown. */
  action_hash: string;
};

/**
 * Build the binding from the machine-observed facts only. Anything the model
 * wrote about itself (a justification, a summary it authored) must stay out of
 * this hash: it is reviewer context, not part of the authorized action.
 */
export function buildBinding(approvalId: string, kind: string, machineObserved: unknown): ActionBinding {
  return {
    approval_id: approvalId,
    kind,
    action_hash: stableHash(machineObserved),
  };
}

export type BindingCheck = { ok: true } | { ok: false; reason: string };

/**
 * Re-check a binding immediately before resolving the approval in OpenClaw.
 * `current` is the freshly re-read approval record; `bound` is what the
 * reviewer approved. Any drift is a hard denial, never a warning.
 */
export function checkBinding(bound: ActionBinding, current: { id: string; kind: string; machineObserved: unknown } | null): BindingCheck {
  if (!current) return { ok: false, reason: 'approval_no_longer_pending' };
  if (current.id !== bound.approval_id) return { ok: false, reason: 'approval_id_mismatch' };
  if (current.kind !== bound.kind) return { ok: false, reason: 'approval_kind_mismatch' };
  if (stableHash(current.machineObserved) !== bound.action_hash) return { ok: false, reason: 'action_hash_mismatch' };
  return { ok: true };
}
