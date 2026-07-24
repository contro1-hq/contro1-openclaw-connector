import { ActionBinding } from './binding.js';

export type PendingApproval = {
  /** Contro1 request id, the key the signed callback arrives under. */
  contro1_request_id: string;
  /** Idempotency key we sent to Contro1. */
  external_request_id: string;
  correlation_id: string;
  trace_id: string;
  binding: ActionBinding;
  /** The facts shown to the reviewer, kept for the audit record. */
  machine_observed: Record<string, unknown>;
  agent_id?: string;
  session_key?: string;
  created_at_ms: number;
  /** Set once we have resolved it in OpenClaw, so a replayed callback is a no-op. */
  resolved_at_ms?: number;
};

/**
 * Pending-approval state behind an interface.
 *
 * The in-memory implementation is fine for a single-process pilot. Anything
 * running more than one replica, or expected to survive a restart with
 * approvals in flight, must swap in a durable store: an unknown request id on
 * callback is a hard denial, so losing this map means losing approvals that a
 * human already granted.
 */
export interface PendingStore {
  put(pending: PendingApproval): Promise<void>;
  getByRequestId(requestId: string): Promise<PendingApproval | null>;
  getByApprovalId(approvalId: string): Promise<PendingApproval | null>;
  markResolved(requestId: string): Promise<void>;
  delete(requestId: string): Promise<void>;
  /** Drop entries older than maxAgeMs so a long-running process does not grow without bound. */
  sweep(maxAgeMs: number): Promise<number>;
}

export class InMemoryPendingStore implements PendingStore {
  private readonly byRequestId = new Map<string, PendingApproval>();
  private readonly byApprovalId = new Map<string, string>();

  async put(pending: PendingApproval): Promise<void> {
    this.byRequestId.set(pending.contro1_request_id, pending);
    this.byApprovalId.set(pending.binding.approval_id, pending.contro1_request_id);
  }

  async getByRequestId(requestId: string): Promise<PendingApproval | null> {
    return this.byRequestId.get(requestId) || null;
  }

  async getByApprovalId(approvalId: string): Promise<PendingApproval | null> {
    const requestId = this.byApprovalId.get(approvalId);
    return requestId ? this.byRequestId.get(requestId) || null : null;
  }

  async markResolved(requestId: string): Promise<void> {
    const pending = this.byRequestId.get(requestId);
    if (pending) pending.resolved_at_ms = Date.now();
  }

  async delete(requestId: string): Promise<void> {
    const pending = this.byRequestId.get(requestId);
    if (!pending) return;
    this.byApprovalId.delete(pending.binding.approval_id);
    this.byRequestId.delete(requestId);
  }

  async sweep(maxAgeMs: number): Promise<number> {
    const cutoff = Date.now() - maxAgeMs;
    let removed = 0;
    for (const [requestId, pending] of this.byRequestId) {
      if (pending.created_at_ms < cutoff) {
        await this.delete(requestId);
        removed += 1;
      }
    }
    return removed;
  }
}
