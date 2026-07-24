# Contro1 OpenClaw Connector Guide

This guide covers the threat model, the approval flow, policy defaults, the protocol mapping, and the event taxonomy for governing OpenClaw with Contro1.

## Verified against

The connector was built against the official OpenClaw documentation and source at:

- OpenClaw **stable `v2026.7.1`** (published 2026-07-13), the current stable release channel tag.
- `docs.openclaw.ai/gateway/protocol` - frames, handshake, RPC method families, exec approvals.
- `docs.openclaw.ai/tools/exec-approvals` and `.../exec-approvals-advanced` - the approval flow, `systemRunPlan` binding, 30-minute expiry, `askFallback`, channel forwarding config.
- `docs.openclaw.ai/gateway/operator-scopes` - `operator.approvals` and scope mapping.
- `docs.openclaw.ai/cli/approvals` - `openclaw approvals pending|resolve`.

Anything below marked **not officially specified** was not confirmed in that documentation and must be decided per deployment rather than assumed.

## What OpenClaw is

OpenClaw is an open-source personal AI assistant that runs on your own machine and answers on the channels you already use (WhatsApp, Telegram, iMessage, Signal, Slack, Discord, and more). It keeps persistent memory, browses the web, runs shell commands, manages email and calendar, and can write its own skills. It acts autonomously in the background - which is exactly why it needs a guardrail for the actions that matter and an audit trail for the rest.

## What this connector does

The connector is the small server in this repository. You deploy it in your own environment as an OpenClaw **operator client**, running outside the gateway process. It watches for approvals OpenClaw has stopped for, asks Contro1 for a human decision, verifies the signed answer, and only then resolves the approval in OpenClaw. Through an agent-side skill it also records the assistant's autonomous background actions as durable Contro1 audit evidence.

It governs three approval families OpenClaw already exposes:

- **exec approvals** - host shell commands that miss the allowlist under `ask`/`auto` mode.
- **plugin approvals** - plugin-owned operations that request approval per call.
- **system-agent approvals** - surfaced together with the above by `openclaw approvals pending`.

## Why the governance runs outside the gateway

OpenClaw plugins run **in-process with the gateway and are not sandboxed**: a faulty or hostile plugin can crash or compromise the entire gateway. So the parts that hold a credential or make the approval decision stay outside it, in an external operator client - the documented path for scripts, dashboards, and integrations. That keeps a clear trust boundary between "decides whether to run" (the gateway) and "decides who approves" (Contro1). The bridge never needs to be trusted inside the gateway; it only needs an operator token scoped to approvals.

The optional [ClawHub plugin](../plugin) does run in-process, and is safe to because it holds no credentials, makes no network calls, and only asks OpenClaw to pause a sensitive tool call. The credential-bearing governance still happens in the bridge.

## The trust boundary

Three parties, each with one job:

1. **OpenClaw** decides an action needs approval and holds it pending (up to 30 minutes by default).
2. **This connector** maps the pending approval to a Contro1 request, verifies the signed decision, re-checks the binding, and resolves the approval.
3. **Contro1** routes the decision to the right human, enforces role/quorum/SLA, and keeps signed evidence.

## Making the guardrail unbypassable

A guardrail written into the assistant's prompt is a suggestion: a capable, self-improving agent can reason around an instruction. This connector does not rely on instructions. OpenClaw enforces exec approvals **out-of-process, on the execution host** (the `openclaw` process on the gateway machine, or the companion app on a node). The model that decides to run a command is not the thing that runs it - it can only request, and the host holds the gate.

Because enforcement is external, make it truly unbypassable by denying the assistant any authority to loosen it:

- **Policy can only tighten.** OpenClaw computes the effective exec policy as the stricter of config and the host approvals file; an approval can never widen it. Keep the host approvals file (`$OPENCLAW_STATE_DIR/exec-approvals.json`) owned by the host, not writable from the assistant's workspace.
- **Changing the rules is privileged.** Config mutation and reserved namespaces need `operator.admin`; the assistant's session should not hold it. Route any policy or allowlist change through Contro1 approval too.
- **It cannot rewrite its own instructions.** Set `skills.workshop.approvalPolicy` to `pending` so the assistant drafts skill proposals into a human-reviewed queue instead of writing to its own `SKILL.md`.
- **It cannot approve its own request.** The bridge holds the `operator.approvals` credential, not the assistant, and runs as a separate operator client. Keep `askFallback` at `deny` so removing the reviewer closes the gate.

## Two skills: enforced and cooperative

The repo ships two skill files with different jobs:

- **`skills/contro1-openclaw.md`** is the build guide for whoever sets up the bridge.
- **`skills/contro1-approvals/SKILL.md`** (the `contro1-approvals` skill) installs into the assistant's own skills directory (`~/.agents/skills` or `<workspace>/skills`). It teaches the assistant the cooperative behavior: give a reviewer clear, factual context when an action needs approval, and POST a short audit note to `POST /agent/audit` after each autonomous action.

Keep the split clear. The agent-side skill improves quality - good context, honest logging of background work beyond OpenClaw's 30-day metadata ledger. It is **not** the enforcement. An adversarial assistant can skip it, which is exactly why enforcement lives in the approval path and this is only additive evidence.

## Approval flow

```
OpenClaw raises exec.approval.requested (or plugin.approval.requested)
      │
      ▼
Bridge sees it (openclaw approvals pending --json, polled)
      │
      ├─ policy = block         → openclaw approvals resolve <id> deny + audit record
      ├─ policy = auto_allow     → openclaw approvals resolve <id> allow-once + audit record
      └─ policy = require_approval
             │
             ▼
      POST /requests to Contro1 (bound to the exact command via an action hash)
             │
             ▼
      Contro1 routes to dashboard / Slack / Teams / operator workflow
             │
             ▼
      Reviewer approves or rejects
             │
             ▼
      Signed POST to /contro1/callback
             │
      verify signature + timestamp (< 5 min) ─ fail → 401, nothing runs
             │
      re-read approval + re-check action hash ─ mismatch → 409, nothing runs
             │
             ▼
      openclaw approvals resolve <id> allow-once  (or deny)
             │
             ▼
      audit record linked to the request by correlation_id + in_reply_to
```

## Transports

The bridge reaches OpenClaw through a single `OpenClawTransport` seam. Three implementations ship:

- **`cli` (default, supported).** Uses the documented `openclaw approvals pending --json` and `openclaw approvals resolve <id> <decision>` commands. Polls for new approvals; because approvals stay pending for 30 minutes, a few-second poll interval adds negligible latency. Needs `operator.approvals` to resolve; full enumeration currently also draws on `operator.admin`.
- **`mock`.** An in-process stand-in so the whole loop runs with no OpenClaw installed. Drives approvals via `POST /mock/approvals`.
- **`gateway` (preview, not implemented).** Would subscribe to `exec.approval.requested` over the Gateway WebSocket and resolve via `approval.resolve`. It is intentionally left unimplemented: the `connect` handshake requires signing the server's challenge nonce with the device-auth **v3** payload from `@openclaw/gateway-client`, and that package still returns `E404` on npm as of `v2026.7.1`. The connector does not guess at an authentication payload's byte layout. Finish this transport once the package publishes; nothing else in the bridge changes.

## Configure OpenClaw so approvals actually stop

The bridge can only govern actions OpenClaw stops for. Set exec mode to `ask` (or `auto` with a conservative allowlist) so misses pause:

```bash
openclaw config set tools.exec.mode ask
```

Keep the fallback closed so that if the bridge is unreachable, OpenClaw denies rather than runs:

```bash
openclaw approvals set --gateway --stdin <<'EOF'
{ version: 1, defaults: { security: "allowlist", ask: "on-miss", askFallback: "deny" } }
EOF
```

`askFallback: "deny"` is the single most important line: it is what makes the approval a gate rather than a suggestion.

## Policy

Policy classifies each approval into `block`, `auto_allow`, or `require_approval` from **machine-observed facts only** - the command OpenClaw captured, the agent id, and the session key. Text the agent authored about its own intent is never consulted for a security decision.

Override the built-in defaults with a JSON file pointed at by `CONTRO1_POLICY_FILE`:

```json
{
  "allowed_agents": ["main", "ci"],
  "block_patterns": ["rm\\s+-rf\\s+/(?:\\s|$)", "mkfs\\."],
  "approval_patterns": ["\\bsudo\\b", "\\bkubectl\\b", "\\bterraform\\b\\s+(?:apply|destroy)"],
  "auto_allow_patterns": ["^ls\\b", "^cat\\b", "^git\\b\\s+status"],
  "production_session_patterns": ["prod", "production"],
  "default_required_role": "platform",
  "default_sla_minutes": 15
}
```

### Defaults

- **Auto-allow** only when an operator-configured `auto_allow_patterns` entry matches and the session is not production. Nothing is auto-allowed out of the box.
- **Require approval** for every plugin/system-agent approval, every production-session command, and any command matching a sensitive shape (pipe-to-shell, `sudo`, `ssh`, cloud CLIs, `kubectl`, `terraform apply/destroy`, `docker run/exec`, `git push`, `npm publish`, `chmod 777`, secret/`.env`/`.ssh` access). By default, an approval OpenClaw already stopped for stays stopped for a human.
- **Block** before a reviewer ever sees it: unambiguously destructive shapes (`rm -rf /`, fork bombs, `mkfs`, `dd` to a device) and unknown agents when `allowed_agents` is set.

## Protocol mapping

| Field | Value |
| --- | --- |
| `source.integration` | `openclaw` |
| `source.workflow_id` | `openclaw-approval-bridge` |
| `context.action_type` | `shell_exec` \| `tool_invoke` \| `session_control` |
| `actor.agent_id` | OpenClaw `agentId` |
| `correlation_id` | OpenClaw `sessionKey` |
| `external_request_id` | `openclaw:<kind>:<approval_id>` |
| `policy_context.source` | `openclaw_approval_bridge` |
| `continuation.expires_at` | OpenClaw approval `expiresAtMs` |

The full connector-side request object is preserved under `metadata.protocol_request`. Machine-observed facts live under `metadata.machine_observed`; anything the agent authored lives under `metadata.agent_reported` and is display-only.

## Event taxonomy

Audit records use these actions:

```text
openclaw.approval.requested       a human now owns the decision
openclaw.approval.auto_allowed    allowed by policy without a human, logged
openclaw.approval.blocked         denied by policy before reaching a human
openclaw.approval.approved        reviewer approved; resolved allow-once/allow-always
openclaw.approval.denied          reviewer rejected; resolved deny
openclaw.approval.expired         approval gone from OpenClaw before the decision arrived
openclaw.approval.binding_mismatch  action changed after the reviewer saw it; refused
openclaw.approval.resolve_failed  could not apply the approved decision to OpenClaw
```

## Fail-closed rules

The action does not run when any of these is true:

- the callback signature is missing or invalid;
- the callback timestamp is more than 5 minutes old (replay protection; the timestamp marks callback delivery, not request creation);
- the `request_id` is unknown to the bridge;
- the approval is no longer pending in OpenClaw (it expired or was resolved elsewhere);
- the approval's machine-observed facts no longer hash to what the reviewer approved.

Each request id is resolved exactly once; a duplicate callback is a no-op.

## Not officially specified

These were not confirmed in the reviewed OpenClaw documentation and should be decided per deployment:

- **Email as an approval surface.** Contro1 can route to dashboard, Slack, Teams, or an operator workflow; OpenClaw forwards approval prompts to chat channels. Neither documents email approval for this flow. Decide explicitly before relying on it.
- **Mobile push as an approval surface.** OpenClaw ships iOS/Android companion apps and macOS notifications, but push approval for dangerous actions is not documented as a first-class surface in the pages reviewed.
- **The exact device-auth v3 signature payload** for a direct Gateway WebSocket client, which is published as code in an as-yet-unpublished npm package rather than as a byte-level spec. This is why the gateway transport stays preview.
