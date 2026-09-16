import crypto from 'node:crypto';
import { Contro1Client, RiskLevel } from './core/contro1.js';
import { buildBinding, checkBinding } from './core/binding.js';
import { PendingApproval, PendingStore } from './core/store.js';
import { PolicyConfig, PolicyResult, classify } from './policy.js';
import {
  OpenClawDecision,
  OpenClawPendingApproval,
  OpenClawTransport,
  approvalSummary,
  machineObservedFacts,
} from './openclaw/types.js';

export const INTEGRATION = 'openclaw';
export const WORKFLOW_ID = 'openclaw-approval-bridge';

export const EVENT = {
  seen: 'openclaw.approval.seen',
  requested: 'openclaw.approval.requested',
  autoAllowed: 'openclaw.approval.auto_allowed',
  blocked: 'openclaw.approval.blocked',
  approved: 'openclaw.approval.approved',
  denied: 'openclaw.approval.denied',
  expired: 'openclaw.approval.expired',
  bindingMismatch: 'openclaw.approval.binding_mismatch',
  resolveFailed: 'openclaw.approval.resolve_failed',
} as const;

export type BridgeOptions = {
  contro1: Contro1Client;
  transport: OpenClawTransport;
  store: PendingStore;
  policy: PolicyConfig;
  publicBaseUrl: string;
  deliveryMode?: 'poll' | 'webhook';
  /** Grant allow-always instead of allow-once when a reviewer approves. Off by default. */
  allowAlways?: boolean;
};

export type CallbackOutcome = {
  status: 'resolved' | 'denied' | 'ignored' | 'binding_mismatch' | 'unknown_request';
  request_id: string;
  decision?: OpenClawDecision;
  reason?: string;
};

export type AutonomousActionInput = {
  /** What the agent did, e.g. "email.send" or "browser.purchase". */
  action: string;
  summary: string;
  agent_id?: string;
  session_key?: string;
  /** Machine-observed facts about the action. Free-form, kept as-is. */
  observed?: Record<string, unknown>;
  /** The agent's own reasoning. Recorded as context, never as a routing input. */
  reason?: string;
  outcome?: 'success' | 'failure';
};

export class ApprovalBridge {
  private readonly seen = new Set<string>();

  constructor(private readonly options: BridgeOptions) {}

  /**
   * Record an autonomous action the agent took without an approval.
   *
   * This is the cooperative half of the connector: the enforced approval path
   * does not depend on the agent, but this does. It exists so that everything
   * the assistant does in the background - not just the actions that tripped an
   * approval - lands in a durable, exportable Contro1 audit trail, beyond
   * OpenClaw's own 30-day metadata-only ledger. An adversarial agent can skip
   * this call; that is exactly why enforcement lives in the approval path and
   * this is only additive evidence.
   */
  async logAutonomousAction(input: AutonomousActionInput): Promise<void> {
    const correlationId = input.session_key || input.agent_id || 'openclaw';
    await this.options.contro1.forAgent(input.agent_id).logAudit({
      action: input.action.startsWith('openclaw.') ? input.action : `openclaw.autonomous.${input.action}`,
      summary: input.summary,
      source: { integration: INTEGRATION, workflow_id: WORKFLOW_ID },
      // The Contro1 agent comes from the credential; the OpenClaw id is provenance.
      actor: { agent_name: input.agent_id ? `OpenClaw agent ${input.agent_id}` : undefined },
      resource: input.session_key ? { type: 'openclaw.session', uri: input.session_key } : undefined,
      outcome: input.outcome || 'success',
      severity: input.outcome === 'failure' ? 'warning' : 'info',
      correlation_id: correlationId,
      external_request_id: `openclaw:autonomous:${crypto
        .createHash('sha256')
        .update(`${correlationId}:${input.action}:${JSON.stringify(input.observed ?? {})}:${Date.now()}`)
        .digest('hex')
        .slice(0, 24)}`,
      metadata: {
        openclaw: { agent_id: input.agent_id },
        machine_observed: input.observed,
        agent_reported: input.reason ? { reason: input.reason } : undefined,
      },
    });
  }

  /**
   * Pull every pending OpenClaw approval and make sure each one has been
   * routed. Safe to call on a timer: approvals already handled are skipped,
   * and the Contro1 request carries a deterministic external_request_id, so a
   * duplicate call cannot create a duplicate approval.
   */
  async sync(): Promise<{ seen: number; created: number }> {
    const pending = await this.options.transport.listPending();
    let created = 0;
    for (const approval of pending) {
      if (this.seen.has(approval.id)) continue;
      this.seen.add(approval.id);
      try {
        const handled = await this.onApproval(approval);
        if (handled) created += 1;
      } catch (error) {
        // Leave it unseen so the next sync retries. An approval we failed to
        // route is an approval nobody is looking at; it must not be dropped.
        this.seen.delete(approval.id);
        console.error(`Could not route OpenClaw approval ${approval.id}:`, error);
      }
    }
    return { seen: pending.length, created };
  }

  async pollContro1Decisions(): Promise<{ checked: number; resolved: number; failed: number }> {
    const pending = await this.options.store.listPending();
    let resolved = 0;
    let failed = 0;
    for (const item of pending) {
      // One unreadable request must not stall every other approval behind it.
      // A failure leaves the approval unresolved, which OpenClaw denies on expiry.
      try {
        const request = await this.options.contro1.forAgent(item.agent_id).getRequest(item.contro1_request_id);
        const status = classifyContro1Status(request);
        if (status === 'pending') continue;
        await this.applyDecision({ request_id: item.contro1_request_id, status });
        resolved += 1;
      } catch (error) {
        failed += 1;
        console.error(`Contro1 request ${item.contro1_request_id}: ${(error as Error).message}`);
      }
    }
    return { checked: pending.length, resolved, failed };
  }

  /**
   * Route one approval. Returns true when a Contro1 request was created and a
   * human now owns the decision.
   */
  async onApproval(approval: OpenClawPendingApproval): Promise<boolean> {
    const policy = classify(approval, this.options.policy);
    const machineObserved = machineObservedFacts(approval);
    const summary = approvalSummary(approval);
    const correlationId = approval.sessionKey || approval.id;
    const traceId = `trc_${crypto.createHash('sha256').update(correlationId).digest('hex').slice(0, 24)}`;

    if (policy.decision === 'block') {
      await this.deny(approval, policy.reason);
      await this.audit({
        action: EVENT.blocked,
        summary: `Blocked by connector policy: ${summary}`,
        approval,
        outcome: 'denied',
        correlationId,
        metadata: { policy, machine_observed: machineObserved },
      });
      return false;
    }

    if (policy.decision === 'auto_allow') {
      await this.options.transport.resolve(approval.id, 'allow-once');
      await this.audit({
        action: EVENT.autoAllowed,
        summary: `Auto-allowed without human review: ${summary}`,
        approval,
        outcome: 'success',
        correlationId,
        metadata: { policy, machine_observed: machineObserved },
      });
      return false;
    }

    const externalRequestId = `openclaw:${approval.kind || 'exec'}:${approval.id}`;
    const created = await this.options.contro1.forAgent(approval.agentId).createRequest({
      title: `Approve OpenClaw ${approval.kind || 'exec'} action: ${truncate(summary, 90)}`,
      description: policy.reason,
      request_type: 'approval',
      source: {
        integration: INTEGRATION,
        framework: 'openclaw',
        workflow_id: WORKFLOW_ID,
        run_id: approval.id,
        session_id: approval.sessionKey,
      },
      routing: {
        required_role: policy.required_role,
        priority: policy.risk === 'critical' || policy.risk === 'high' ? 'urgent' : 'normal',
        sla_minutes: policy.sla_minutes,
      },
      // Never the native OpenClaw id as actor.agent_id: Contro1 would read it
      // as a claim to be a different Contro1 agent and refuse the request.
      actor: { agent_name: approval.agentId ? `OpenClaw agent ${approval.agentId}` : undefined },
      context: {
        action_type: actionType(approval),
        tool_name: approval.kind === 'plugin' ? 'openclaw.plugin' : 'openclaw.exec',
        tool_input: machineObserved,
        resource: approval.cwd,
        environment: approval.host,
        summary,
      },
      continuation: {
        mode: 'decision',
        webhook_url: this.options.deliveryMode === 'webhook' ? `${this.options.publicBaseUrl}/contro1/callback` : undefined,
        // Contro1 must decide before OpenClaw's own expiry, or the decision
        // arrives after the gateway has already denied the command.
        expires_at: approval.expiresAtMs ? new Date(approval.expiresAtMs).toISOString() : undefined,
      },
      risk_level: policy.risk,
      policy_trigger: policy.reason,
      policy_context: {
        source: 'openclaw_approval_bridge',
        policy_name: 'openclaw-exec-policy',
        rule_id: policy.rule_id,
        rule_reason: policy.reason,
        enforcement: 'require_approval',
      },
      approval_comment_required: policy.comment_required,
      external_request_id: externalRequestId,
      correlation_id: correlationId,
      trace_id: traceId,
      tool_calls: [
        {
          name: approval.kind === 'plugin' ? 'openclaw.plugin.call' : 'openclaw.exec.run',
          arguments: machineObserved,
          outcome: 'pending',
        },
      ],
      metadata: {
        // Machine-observed facts are what routing and risk were derived from.
        // Anything the agent wrote about itself is display-only context.
        machine_observed: machineObserved,
        agent_reported: { summary },
        openclaw: {
          agent_id: approval.agentId,
          approval_id: approval.id,
          kind: approval.kind || 'exec',
          expires_at_ms: approval.expiresAtMs,
          allowed_decisions: approval.allowedDecisions,
        },
      },
    });

    const requestId = String(created.id || created.request_id || '');
    if (!requestId) throw new Error('Contro1 did not return a request id');

    const pending: PendingApproval = {
      contro1_request_id: requestId,
      external_request_id: externalRequestId,
      correlation_id: correlationId,
      trace_id: traceId,
      binding: buildBinding(approval.id, approval.kind || 'exec', machineObserved),
      machine_observed: machineObserved,
      agent_id: approval.agentId,
      session_key: approval.sessionKey,
      created_at_ms: Date.now(),
    };
    await this.options.store.put(pending);

    await this.audit({
      action: EVENT.requested,
      summary: `Sent to a human reviewer: ${summary}`,
      approval,
      outcome: 'success',
      correlationId,
      requestId,
      metadata: { policy, machine_observed: machineObserved },
    });
    return true;
  }

  /**
   * Apply a verified Contro1 decision to OpenClaw.
   *
   * The caller must have verified the callback signature and timestamp before
   * getting here. This method still fails closed on everything else: an
   * unknown request id, a replayed callback, or an approval whose facts have
   * drifted since the reviewer saw them.
   */
  async applyDecision(payload: Record<string, unknown>): Promise<CallbackOutcome> {
    const requestId = String(
      payload.request_id || (payload.protocol_response as Record<string, unknown> | undefined)?.request_id || '',
    );
    const status = String(
      payload.status || (payload.protocol_response as Record<string, unknown> | undefined)?.status || '',
    );

    const pending = await this.options.store.getByRequestId(requestId);
    if (!pending) return { status: 'unknown_request', request_id: requestId };

    // Execute each request id exactly once. A duplicate delivery is a no-op,
    // not a second decision.
    if (pending.resolved_at_ms) return { status: 'ignored', request_id: requestId, reason: 'already_resolved' };

    if (status !== 'approved') {
      await this.options.transport.resolve(pending.binding.approval_id, 'deny', `Contro1 request ${requestId}: ${status}`);
      await this.options.store.markResolved(requestId);
      await this.auditPending({
        action: EVENT.denied,
        summary: `Reviewer did not approve (${status}); OpenClaw action denied.`,
        pending,
        outcome: 'denied',
        callback: payload,
      });
      return { status: 'denied', request_id: requestId, decision: 'deny' };
    }

    // The reviewer approved a specific action. Re-read the approval and confirm
    // it is still that action before letting it run.
    const current = await this.currentBindingSubject(pending.binding.approval_id);
    const check = checkBinding(pending.binding, current);
    if (!check.ok) {
      await this.options.store.markResolved(requestId);
      await this.auditPending({
        action: check.reason === 'approval_no_longer_pending' ? EVENT.expired : EVENT.bindingMismatch,
        summary:
          check.reason === 'approval_no_longer_pending'
            ? 'Approval was no longer pending in OpenClaw when the decision arrived; the action did not run.'
            : `Approval did not match the action the reviewer saw (${check.reason}); the action did not run.`,
        pending,
        outcome: 'denied',
        callback: payload,
        metadata: { binding_check: check },
      });
      return { status: 'binding_mismatch', request_id: requestId, reason: check.reason };
    }

    const decision: OpenClawDecision = this.options.allowAlways ? 'allow-always' : 'allow-once';
    try {
      await this.options.transport.resolve(pending.binding.approval_id, decision, `Contro1 request ${requestId}`);
    } catch (error) {
      await this.auditPending({
        action: EVENT.resolveFailed,
        summary: `Could not apply the approved decision to OpenClaw: ${(error as Error).message}`,
        pending,
        outcome: 'failure',
        callback: payload,
      });
      throw error;
    }

    await this.options.store.markResolved(requestId);
    await this.auditPending({
      action: EVENT.approved,
      summary: `Reviewer approved; OpenClaw action resolved as ${decision}.`,
      pending,
      outcome: 'success',
      callback: payload,
      metadata: { decision },
    });
    return { status: 'resolved', request_id: requestId, decision };
  }

  /** Deny an approval in OpenClaw without troubling a human. */
  private async deny(approval: OpenClawPendingApproval, reason: string): Promise<void> {
    try {
      await this.options.transport.resolve(approval.id, 'deny', reason);
    } catch (error) {
      // A denial that fails still leaves the approval pending, which OpenClaw
      // will turn into a denial at expiry. Log it and move on.
      console.error(`Could not deny OpenClaw approval ${approval.id}:`, error);
    }
  }

  private async currentBindingSubject(approvalId: string) {
    const pending = await this.options.transport.listPending();
    const found = pending.find((approval) => approval.id === approvalId);
    if (!found) return null;
    return { id: found.id, kind: found.kind || 'exec', machineObserved: machineObservedFacts(found) };
  }

  private async audit(input: {
    action: string;
    summary: string;
    approval: OpenClawPendingApproval;
    outcome: 'success' | 'failure' | 'denied';
    correlationId: string;
    requestId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    try {
      await this.options.contro1.forAgent(input.approval.agentId).logAudit({
        action: input.action,
        summary: input.summary,
        source: { integration: INTEGRATION, workflow_id: WORKFLOW_ID, run_id: input.approval.id },
        actor: { agent_name: input.approval.agentId ? `OpenClaw agent ${input.approval.agentId}` : undefined },
        resource: { type: 'openclaw.approval', id: input.approval.id, uri: input.approval.sessionKey },
        outcome: input.outcome,
        severity: input.outcome === 'success' ? 'info' : 'warning',
        correlation_id: input.correlationId,
        external_request_id: `${input.action}:${input.approval.id}`,
        in_reply_to: input.requestId ? { type: 'request', id: input.requestId } : undefined,
        metadata: input.metadata,
      });
    } catch (error) {
      console.warn('Could not write Contro1 audit record:', error);
    }
  }

  private async auditPending(input: {
    action: string;
    summary: string;
    pending: PendingApproval;
    outcome: 'success' | 'failure' | 'denied';
    callback?: unknown;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    try {
      await this.options.contro1.forAgent(input.pending.agent_id).logAudit({
        action: input.action,
        summary: input.summary,
        source: { integration: INTEGRATION, workflow_id: WORKFLOW_ID, run_id: input.pending.binding.approval_id },
        actor: { agent_name: input.pending.agent_id ? `OpenClaw agent ${input.pending.agent_id}` : undefined },
        resource: {
          type: 'openclaw.approval',
          id: input.pending.binding.approval_id,
          uri: input.pending.session_key,
        },
        outcome: input.outcome,
        severity: input.outcome === 'success' ? 'info' : 'warning',
        correlation_id: input.pending.correlation_id,
        external_request_id: `${input.action}:${input.pending.binding.approval_id}`,
        in_reply_to: { type: 'request', id: input.pending.contro1_request_id },
        metadata: {
          machine_observed: input.pending.machine_observed,
          action_hash: input.pending.binding.action_hash,
          trace_id: input.pending.trace_id,
          callback: input.callback,
          ...input.metadata,
        },
      });
    } catch (error) {
      console.warn('Could not write Contro1 audit record:', error);
    }
  }
}

function actionType(approval: OpenClawPendingApproval): string {
  const kind = approval.kind || 'exec';
  if (kind === 'exec') return 'shell_exec';
  if (kind === 'plugin') return 'tool_invoke';
  return 'session_control';
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Every request state in which a human decision exists. A decided request moves
 * on from `answered` into the callback states, so a bridge that only knows
 * `answered` and `closed` sees a real decision as pending forever.
 */
const DECIDED_STATES = new Set(['answered', 'callback_pending', 'callback_delivered', 'callback_failed', 'closed']);

/**
 * `state` says WHETHER a decision exists; the API's derived `status` says WHAT
 * it was. Neither is enough alone: `status` reads `timed_out` for a request
 * nobody has answered yet. Anything other than an explicit approval denies.
 * Kept in step with classifyContro1Request in @contro1/approval-bridge-core.
 */
export function classifyContro1Status(request: Record<string, unknown>): 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled' {
  const state = String(request.state ?? '').toLowerCase();
  if (state === 'expired') return 'expired';
  if (state === 'cancelled') return 'cancelled';
  if (!DECIDED_STATES.has(state)) return 'pending';
  const protocol = request.protocol_response && typeof request.protocol_response === 'object'
    ? request.protocol_response as Record<string, unknown>
    : {};
  const status = String(request.status ?? protocol.status ?? '').toLowerCase();
  return status === 'approved' ? 'approved' : 'denied';
}

export type { RiskLevel, PolicyResult };
