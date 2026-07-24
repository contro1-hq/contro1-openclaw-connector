import crypto from 'node:crypto';

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export type ProtocolRequest = {
  title: string;
  description?: string;
  request_type: 'approval' | 'input' | 'decision' | 'review';
  source: {
    integration: string;
    framework?: string;
    workflow_id?: string;
    run_id?: string;
    session_id?: string;
  };
  routing?: {
    required_role?: string;
    priority?: 'low' | 'normal' | 'high' | 'urgent';
    sla_minutes?: number;
  };
  actor?: { agent_id?: string; agent_name?: string; user_id?: string; user_email?: string };
  context?: {
    tool_name?: string;
    tool_input?: unknown;
    action_type?: string;
    resource?: string;
    environment?: string;
    summary?: string;
  };
  continuation: {
    mode: 'decision' | 'instruction';
    callback_url?: string;
    webhook_url?: string;
    expires_at?: string;
  };
  risk_level?: RiskLevel;
  policy_trigger?: string;
  policy_context?: {
    source?: string;
    policy_name?: string;
    rule_id?: string;
    rule_reason?: string;
    policy_version?: string;
    enforcement?: string;
  };
  approval_comment_required?: boolean;
  external_request_id?: string;
  correlation_id?: string;
  trace_id?: string;
  parent_trace_id?: string;
  tool_calls?: Array<{ name: string; arguments?: unknown; outcome?: string }>;
  retrieved_context?: Array<{ source: string; uri?: string; snippet?: string }>;
  metadata?: Record<string, unknown>;
};

export type AuditRecord = {
  action: string;
  summary: string;
  source: { integration: string; workflow_id?: string; run_id?: string };
  actor?: { agent_id?: string; agent_name?: string };
  resource?: { type?: string; id?: string; uri?: string };
  outcome: 'success' | 'failure' | 'denied';
  severity?: 'info' | 'warning' | 'error';
  correlation_id?: string;
  external_request_id?: string;
  in_reply_to?: { type: 'request'; id: string };
  metadata?: Record<string, unknown>;
};

/**
 * Flatten the connector-facing protocol request into the shape the Contro1
 * Runtime API accepts on POST /requests. The full protocol object is preserved
 * under metadata.protocol_request so reviewers and evidence exports keep every
 * field the connector sent.
 */
export function normalizeProtocolRequest(request: ProtocolRequest): Record<string, unknown> {
  return {
    type: request.request_type,
    context: request.context?.summary || request.description || request.title,
    question: request.title,
    callback_url: request.continuation.webhook_url || request.continuation.callback_url,
    priority: request.routing?.priority || 'normal',
    required_role: request.routing?.required_role,
    sla_minutes: request.routing?.sla_minutes,
    risk_level: request.risk_level,
    policy_trigger: request.policy_trigger,
    policy_context: request.policy_context,
    approval_comment_required: request.approval_comment_required,
    external_request_id: request.external_request_id,
    correlation_id: request.correlation_id,
    trace_id: request.trace_id,
    parent_trace_id: request.parent_trace_id,
    actor: request.actor,
    tool_calls: request.tool_calls,
    retrieved_context: request.retrieved_context,
    metadata: {
      protocol_request: request,
      ...request.metadata,
    },
  };
}

export class Contro1Client {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly simulated: boolean;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.apiKey = env.CONTRO1_API_KEY || '';
    this.baseUrl = (env.CONTRO1_BASE_URL || 'https://api.contro1.com/api/centcom/v1').replace(/\/$/, '');
    this.simulated = !this.apiKey;
    if (this.simulated) {
      console.warn('CONTRO1_API_KEY is not set. Running in simulated mode: requests are logged, never sent.');
    }
  }

  async createRequest(payload: ProtocolRequest): Promise<Record<string, unknown>> {
    return await this.post('/requests', normalizeProtocolRequest(payload), payload.external_request_id);
  }

  async logAudit(payload: AuditRecord): Promise<Record<string, unknown>> {
    return await this.post('/audit-records', payload, payload.external_request_id);
  }

  /**
   * Re-read the authoritative decision straight from Contro1. Use this whenever
   * the callback looks unusual, or before any action expensive enough that a
   * second round trip is cheaper than being wrong.
   */
  async getRequest(requestId: string): Promise<Record<string, unknown>> {
    if (this.simulated) return { id: requestId, status: 'simulated' };
    const response = await fetch(`${this.baseUrl}/requests/${encodeURIComponent(requestId)}`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    const body = (await response.json()) as Record<string, unknown>;
    if (!response.ok) throw new Error(`Contro1 GET /requests/${requestId} failed: ${response.status}`);
    return body;
  }

  private async post(path: string, payload: unknown, idempotencyKey?: string): Promise<Record<string, unknown>> {
    if (this.simulated) {
      console.log(`SIMULATED Contro1 POST ${path}`, JSON.stringify(payload, null, 2));
      return { id: `req_sim_${stableHash(payload)}`, state: 'simulated' };
    }
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
      body: JSON.stringify(payload),
    });
    const body = (await response.json()) as Record<string, unknown>;
    if (!response.ok) {
      throw new Error(`Contro1 API failed: ${response.status} ${JSON.stringify(body)}`);
    }
    return body;
  }
}

/**
 * Verify a Contro1 callback. Fails closed on a missing secret, a missing
 * header, a timestamp outside the allowed skew, or a signature mismatch.
 * The signed string is `${timestamp}.${rawBody}` - verify against the raw
 * body bytes, never against a re-serialized JSON object.
 */
export function verifyCallback(
  rawBody: string,
  signatureHeader: string | string[] | undefined,
  timestampHeader: string | string[] | undefined,
  secret: string,
  maxSkewSeconds = 300,
): boolean {
  const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
  const timestamp = Array.isArray(timestampHeader) ? timestampHeader[0] : timestampHeader;
  if (!secret || !signature || !timestamp) return false;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - ts) > maxSkewSeconds) return false;

  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  if (expected.length !== signature.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

export function stableHash(value: unknown): string {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/** Deterministic JSON: object keys sorted, no incidental whitespace. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}
