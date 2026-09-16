import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

const CLI_TIMEOUT_MS = 30_000;
const CLI_MAX_OUTPUT = 1024 * 1024;

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

const STATIC_CREDENTIAL_VARIABLES = ['CONTRO1_AGENT_TOKEN_FILE', 'CONTRO1_AGENT_TOKEN', 'CONTRO1_TOKEN', 'CONTRO1_API_KEY'] as const;

type MappingEntry = { platform_subject: string; agent_id: string; endpoint: string; endpoint_mode: string; server_principal?: string };

export class Contro1IdentityError extends Error {}

export class Contro1Client {
  private readonly cliPath: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly mappingPath: string;
  private mapping?: MappingEntry[];
  /** Set on a client bound to one mapped agent (see forAgent). */
  readonly contro1AgentId?: string;

  constructor(env: NodeJS.ProcessEnv = process.env, bound?: { agentId: string }) {
    this.env = { ...env };
    this.cliPath = env.CONTRO1_CLI || 'contro1';
    if (this.env.CONTRO1_BASE_URL && !this.env.CONTRO1_API_URL) {
      this.env.CONTRO1_API_URL = this.env.CONTRO1_BASE_URL.replace(/\/api\/centcom\/v1\/?$/u, '');
    }
    if (bound) {
      this.contro1AgentId = bound.agentId;
      this.mappingPath = '';
      return;
    }

    // Each OpenClaw agent reaches Contro1 through its own broker endpoint.
    const mappingPath = this.env.CONTRO1_PLATFORM_MAPPING_FILE?.trim();
    if (!mappingPath) {
      throw new Contro1IdentityError('CONTRO1_PLATFORM_MAPPING_FILE is required. Run: contro1 connect openclaw');
    }
    if (STATIC_CREDENTIAL_VARIABLES.some((name) => this.env[name]?.trim())) {
      throw new Contro1IdentityError('Static Contro1 credentials are unsupported. Remove them and run: contro1 connect openclaw');
    }
    this.mappingPath = mappingPath;
  }

  /**
   * The client for one OpenClaw agent. An agent that is not mapped is refused:
   * there is no default identity.
   */
  forAgent(openclawAgentId: string | undefined): Contro1Client {
    if (!openclawAgentId) {
      throw new Contro1IdentityError('This approval has no OpenClaw agent id, so it cannot be attributed to a connected agent.');
    }
    const entry = this.loadMapping().find((e) => e.platform_subject === openclawAgentId);
    if (!entry) {
      throw new Contro1IdentityError(`OpenClaw agent ${openclawAgentId} is not connected to Contro1 on this computer. Run: contro1 connect openclaw`);
    }
    const env: NodeJS.ProcessEnv = { ...this.env, CONTRO1_BROKER_ENDPOINT: entry.endpoint };
    delete env.CONTRO1_PLATFORM_MAPPING_FILE;
    for (const name of STATIC_CREDENTIAL_VARIABLES) delete env[name];
    if (entry.server_principal) env.CONTRO1_BROKER_PRINCIPAL = entry.server_principal;
    return new Contro1Client(env, { agentId: entry.agent_id });
  }

  private loadMapping(): MappingEntry[] {
    if (this.mapping) return this.mapping;
    let parsed: { schema_version?: number; entries?: MappingEntry[] };
    try {
      parsed = JSON.parse(readFileSync(this.mappingPath!, 'utf8'));
    } catch (error) {
      throw new Contro1IdentityError(`Cannot read the Contro1 mapping file: ${(error as Error).message}`);
    }
    if (parsed.schema_version !== 1 || !Array.isArray(parsed.entries)) {
      throw new Contro1IdentityError('The Contro1 mapping file has an unsupported format. Run: contro1 doctor openclaw');
    }
    this.mapping = parsed.entries;
    return this.mapping;
  }

  private assertBound(): void {
    if (!this.contro1AgentId) {
      throw new Contro1IdentityError('Call forAgent(agentId) before using the Contro1 client.');
    }
  }

  async createRequest(payload: ProtocolRequest): Promise<Record<string, unknown>> {
    this.assertBound();
    const body = normalizeProtocolRequest(payload);
    return await this.runJson(['requests', 'create', '--runtime', '--file', '-'], body);
  }

  async logAudit(payload: AuditRecord): Promise<Record<string, unknown>> {
    this.assertBound();
    return await this.runJson(['activity', 'report', '--file', '-'], payload);
  }

  /**
   * Re-read the authoritative decision straight from Contro1. Use this whenever
   * the callback looks unusual, or before any action expensive enough that a
   * second round trip is cheaper than being wrong.
   */
  async getRequest(requestId: string): Promise<Record<string, unknown>> {
    this.assertBound();
    return await this.runJson(['requests', 'get', '--runtime', requestId]);
  }

  /**
   * Run one fixed CLI command and parse its JSON. Bounded in time and output: a
   * hung or runaway CLI fails this call (and so leaves the approval unresolved,
   * which OpenClaw denies on expiry) instead of stalling the whole bridge.
   */
  private async runJson(args: string[], payload?: unknown): Promise<Record<string, unknown>> {
    // The CLI does not read CONTRO1_API_URL from the environment; it takes the
    // API origin from its profile or --api-url. Pass it explicitly, or a bridge
    // configured for a staging or local stack would silently talk to production.
    const apiUrl = this.env.CONTRO1_API_URL?.trim();
    const fullArgs = [...args, ...(apiUrl ? ['--api-url', apiUrl] : []), '--format', 'json', '--quiet'];
    const child = spawn(this.cliPath, fullArgs, {
      env: this.env,
      shell: false,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const output = new Promise<number | null>((resolve, reject) => {
      const fail = (message: string) => {
        clearTimeout(timer);
        child.kill();
        reject(new Error(`${message}: ${redact(stderr.slice(0, 500))}`));
      };
      const timer = setTimeout(() => fail(`contro1 CLI timed out after ${CLI_TIMEOUT_MS}ms`), CLI_TIMEOUT_MS);
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
        if (stdout.length > CLI_MAX_OUTPUT) fail('contro1 CLI stdout exceeded limit');
      });
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
        if (stderr.length > CLI_MAX_OUTPUT) fail('contro1 CLI stderr exceeded limit');
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    if (payload !== undefined) {
      child.stdin.end(JSON.stringify(payload));
    } else {
      child.stdin.end();
    }
    const code = await output;
    if (code !== 0) {
      throw new Error(`contro1 CLI exited with ${code}: ${redact(stderr)}`);
    }
    try {
      return JSON.parse(stdout) as Record<string, unknown>;
    } catch {
      throw new Error(`contro1 CLI returned invalid JSON: ${redact(stdout.slice(0, 200))}`);
    }
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

function redact(value: string): string {
  return value
    .replace(/cc_live_[A-Za-z0-9._-]+/g, 'cc_live_[redacted]')
    .replace(/cc_test_[A-Za-z0-9._-]+/g, 'cc_test_[redacted]')
    .replace(/cco_cli_[A-Za-z0-9._-]+/g, 'cco_cli_[redacted]')
    .replace(/ccr_live_[A-Za-z0-9._-]+/g, 'ccr_live_[redacted]');
}
