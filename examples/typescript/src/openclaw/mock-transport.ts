import { OpenClawDecision, OpenClawPendingApproval, OpenClawTransport } from './types.js';

/**
 * An in-process stand-in for OpenClaw, so the whole approval loop can be run
 * and tested without installing a gateway.
 *
 * Push an approval in with `inject()`, watch it flow to Contro1, approve or
 * reject it in the dashboard, and read the recorded decision back with
 * `decisionFor()`.
 */
export class MockOpenClawTransport implements OpenClawTransport {
  readonly name = 'mock';
  private readonly pending = new Map<string, OpenClawPendingApproval>();
  private readonly decisions = new Map<string, OpenClawDecision>();

  inject(approval: Partial<OpenClawPendingApproval> & { id?: string }): OpenClawPendingApproval {
    const id = approval.id || `mock_appr_${Math.random().toString(36).slice(2, 10)}`;
    const now = Date.now();
    const record: OpenClawPendingApproval = {
      kind: 'exec',
      agentId: 'main',
      sessionKey: 'mock:session',
      host: 'gateway',
      command: 'echo hello',
      rawCommand: 'echo hello',
      argv: ['echo', 'hello'],
      cwd: '/workspace',
      createdAtMs: now,
      // OpenClaw expires pending exec approvals after 30 minutes by default.
      expiresAtMs: now + 30 * 60 * 1000,
      allowedDecisions: ['allow-once', 'allow-always', 'deny'],
      ...approval,
      id,
    };
    record.summary = record.summary || record.rawCommand;
    this.pending.set(id, record);
    return record;
  }

  async listPending(): Promise<OpenClawPendingApproval[]> {
    const now = Date.now();
    for (const [id, approval] of this.pending) {
      // Mirror the gateway: an expired approval is gone, and the exec that was
      // waiting on it is denied.
      if (approval.expiresAtMs && approval.expiresAtMs < now) {
        this.pending.delete(id);
        this.decisions.set(id, 'deny');
      }
    }
    return [...this.pending.values()];
  }

  async resolve(approvalId: string, decision: OpenClawDecision): Promise<void> {
    const existing = this.decisions.get(approvalId);
    // First answer wins, exactly like the gateway resolver.
    if (existing) {
      if (existing !== decision) {
        throw new Error(`approval ${approvalId} already resolved as ${existing}`);
      }
      return;
    }
    if (!this.pending.has(approvalId)) {
      throw new Error(`approval ${approvalId} is not pending`);
    }
    this.decisions.set(approvalId, decision);
    this.pending.delete(approvalId);
  }

  decisionFor(approvalId: string): OpenClawDecision | undefined {
    return this.decisions.get(approvalId);
  }
}
