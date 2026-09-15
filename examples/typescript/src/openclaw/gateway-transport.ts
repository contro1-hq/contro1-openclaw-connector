import { OpenClawDecision, OpenClawPendingApproval, OpenClawTransport } from './types.js';

/**
 * Direct Gateway WebSocket transport - PREVIEW, not enabled by default.
 *
 * The gateway broadcasts `exec.approval.requested` and
 * `plugin.approval.requested` to every operator client holding
 * `operator.approvals`, and accepts `approval.resolve` (kind-agnostic) or
 * `exec.approval.resolve`. That is a better fit than polling: the bridge would
 * learn about an approval the instant it is raised.
 *
 * It is not the default for one concrete reason. The `connect` handshake
 * requires signing the server's `connect.challenge` nonce with a device key
 * using the v3 payload built by `buildDeviceAuthPayloadV3` in
 * `packages/gateway-client/src/device-auth.ts`. That payload's exact byte
 * layout is not published as a spec - it is published as code, in
 * `@openclaw/gateway-client`, which when this connector was built still returned
 * E404 on npm ("npm may return E404 until the first package-bearing release is
 * published"); it has since been published (2026.9.4). Reimplementing an authentication payload by guessing at its
 * shape is exactly the kind of thing that fails closed in testing and open in
 * production, so the connector does not guess.
 *
 * Now that `@openclaw/gateway-client` is published, finish this class by:
 *   1. adding the dependency and constructing its client with
 *      role `operator` and scopes `["operator.approvals", "operator.read"]`;
 *   2. subscribing to `exec.approval.requested` / `plugin.approval.requested`
 *      and forwarding each payload into `ApprovalBridge.onApproval()`;
 *   3. implementing `resolve()` as an `approval.resolve` RPC with the canonical
 *      approval id, an explicit `kind`, and the decision.
 * The rest of the bridge does not change: `OpenClawTransport` is the only
 * seam, and the Contro1 side never learns which transport was used.
 */
export class OpenClawGatewayTransport implements OpenClawTransport {
  readonly name = 'openclaw-gateway';

  constructor(_options: { url: string; token: string }) {
    throw new Error(
      'The gateway WebSocket transport is a preview and is not implemented yet: the connect handshake ' +
        'needs the device-auth v3 signature from @openclaw/gateway-client, which is not published on npm ' +
        'when this connector was built. It is now published but this transport is not implemented yet. Use OPENCLAW_TRANSPORT=cli (the default).',
    );
  }

  async listPending(): Promise<OpenClawPendingApproval[]> {
    throw new Error('not implemented');
  }

  async resolve(_approvalId: string, _decision: OpenClawDecision): Promise<void> {
    throw new Error('not implemented');
  }
}
