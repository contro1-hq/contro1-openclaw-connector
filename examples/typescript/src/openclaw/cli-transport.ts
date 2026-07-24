import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  OpenClawDecision,
  OpenClawPendingApproval,
  OpenClawPendingResponse,
  OpenClawTransport,
} from './types.js';

const execFileAsync = promisify(execFile);

export type CliTransportOptions = {
  /** Path to the `openclaw` binary. */
  binary?: string;
  /** Gateway URL, passed through as `--url`. Omit to use the CLI's own config. */
  gatewayUrl?: string;
  /** Gateway token, passed through as `--token`. Omit to use the CLI's own config. */
  gatewayToken?: string;
  timeoutMs?: number;
};

/**
 * Talks to OpenClaw through the documented `openclaw approvals` CLI.
 *
 * This is the default transport because every call it makes is a published,
 * stable command surface:
 *   openclaw approvals pending --json
 *   openclaw approvals resolve <id> <allow-once|allow-always|deny>
 *
 * It polls rather than streams. That is fine in practice: exec approvals stay
 * pending for 30 minutes by default, so a poll interval of a few seconds adds
 * negligible latency to a decision a human is going to take much longer over.
 *
 * The CLI needs `operator.approvals` to resolve; complete enumeration through
 * `pending` currently also draws on `operator.admin`, because approval records
 * are otherwise filtered by requester and reviewer. Treat the credentials this
 * transport uses as remote-execution-grade and scope them deliberately.
 */
export class OpenClawCliTransport implements OpenClawTransport {
  readonly name = 'openclaw-cli';
  private readonly binary: string;
  private readonly baseArgs: string[];
  private readonly timeoutMs: number;

  constructor(options: CliTransportOptions = {}) {
    this.binary = options.binary || 'openclaw';
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.baseArgs = [];
    if (options.gatewayUrl) this.baseArgs.push('--url', options.gatewayUrl);
    if (options.gatewayToken) this.baseArgs.push('--token', options.gatewayToken);
  }

  async listPending(): Promise<OpenClawPendingApproval[]> {
    const stdout = await this.run(['approvals', 'pending', '--json', ...this.baseArgs]);
    if (!stdout.trim()) return [];
    let parsed: OpenClawPendingResponse | OpenClawPendingApproval[];
    try {
      parsed = JSON.parse(stdout) as OpenClawPendingResponse | OpenClawPendingApproval[];
    } catch {
      throw new Error(`openclaw approvals pending --json returned unparseable output: ${stdout.slice(0, 200)}`);
    }
    const approvals = Array.isArray(parsed) ? parsed : parsed.approvals || [];
    // Only entries with a usable id can be resolved later. Drop the rest rather
    // than surfacing an approval we could never act on.
    return approvals.filter((approval) => typeof approval?.id === 'string' && approval.id.length > 0);
  }

  async resolve(approvalId: string, decision: OpenClawDecision, reason?: string): Promise<void> {
    const args = ['approvals', 'resolve', approvalId, decision, ...this.baseArgs];
    // --reason is a local CLI note. The gateway approval record has no free-text
    // resolution-reason field, so the durable reason lives in the Contro1
    // request and audit record, not here.
    if (reason) args.push('--reason', reason);
    await this.run(args);
  }

  private async run(args: string[]): Promise<string> {
    try {
      const { stdout } = await execFileAsync(this.binary, args, {
        timeout: this.timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
      });
      return stdout;
    } catch (error) {
      const err = error as { stderr?: string; message?: string };
      throw new Error(`${this.binary} ${args[0]} ${args[1]} failed: ${(err.stderr || err.message || '').trim()}`);
    }
  }
}
