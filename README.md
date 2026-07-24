# Contro1 OpenClaw Connector

**OpenClaw knows how to stop before a risky command. Contro1 governs who approves it, how it routes, and what evidence survives.** This connector places a human-approval, role-routing, and signed-audit layer in front of OpenClaw exec and plugin approvals, through an external bridge that never runs inside the gateway process.

Repository description:

> External approval bridge that routes OpenClaw exec and plugin approvals to Contro1 for human decisions, role routing, quorum, and signed audit evidence, with fail-closed action binding.

## Links

- Website: https://contro1.com
- Documentation: https://contro1.com/docs/openclaw-human-approval
- Contro1 CLI (your assistant can use it too): https://contro1.com/docs/cli
- Agent Integration Kit: https://contro1.com/agent-kit

> Because an OpenClaw assistant can run shell commands, it can also use the `contro1` CLI directly - to create an approval request, wait for the decision, log an autonomous action, or pull evidence - without going through the bridge. The bridge governs the exec/plugin approvals OpenClaw already raises; the CLI is for approvals and logging the assistant chooses to ask for itself. See the [CLI docs](https://contro1.com/docs/cli).

OpenClaw is an open-source personal AI assistant that runs on your own machine, answers on the channels you already use (WhatsApp, Telegram, iMessage, Signal, Slack, and more), keeps persistent memory, browses the web, runs shell commands, manages email and calendar, and can write its own skills. It acts autonomously in the background. This connector governs what it is allowed to do.

## What this connector does

This connector is the small server in this repository. You deploy it in your own environment as an OpenClaw **operator client**, running outside the gateway process. Instead of a human answering every `/approve` in chat, the bridge routes each pending approval to Contro1, waits for a signed decision, verifies it, and only then resolves the approval in OpenClaw. It also gives you a durable audit trail of the assistant's autonomous background work through an agent-side self-logging skill.

Governed approval families:

- **exec approvals** - host shell commands that miss the allowlist under `ask`/`auto` mode
- **plugin approvals** - plugin-owned operations that request approval per call
- **system-agent approvals** - surfaced together by `openclaw approvals pending`

Contro1 decides whether each is auto-allowed, routed to a human, or blocked. Every decision is recorded as signed audit evidence linked to the OpenClaw agent, session, and command.

## Two parts: bridge and ClawHub plugin

- **[Bridge](examples/typescript)** - governance. Runs outside the gateway, holds the Contro1 credentials, routes approvals to the right human, and keeps signed evidence.
- **[ClawHub plugin](plugin)** - coverage. A thin, secret-free plugin that uses OpenClaw's `before_tool_call` hook to turn *any* sensitive tool call (email, browser purchase, file delete, deploy) into an approval - not just host exec. It holds no credentials and makes no network calls; the bridge does the credential-bearing work. Install it from ClawHub for one click. **Free up to 1,000 approval requests per month.**

You can run the bridge alone (governs exec/plugin approvals OpenClaw already raises) or add the plugin to extend coverage to every sensitive tool call.

## Why an external bridge, not a native plugin

OpenClaw native plugins run **in-process with the gateway and are not sandboxed** - a faulty or hostile plugin can crash or compromise the whole gateway. An external operator client is the documented path for integrations and keeps a clean trust boundary. See [docs/openclaw-connector.md](docs/openclaw-connector.md).

## Quick start (no OpenClaw, no cloud account)

```bash
cd examples/typescript
npm install
OPENCLAW_TRANSPORT=mock npm run dev
```

Then, in another terminal, inject an approval as if OpenClaw had raised one:

```bash
curl -sX POST http://localhost:8092/mock/approvals \
  -H 'content-type: application/json' \
  -d '{"rawCommand":"sudo systemctl restart api","agentId":"main","sessionKey":"whatsapp:+15550001111"}'
```

Without a `CONTRO1_API_KEY` the bridge runs in simulated mode and logs the request it would create. Set your key and webhook secret from **Settings -> APIs & Webhooks** in Contro1 to route to a real reviewer.

## Run the tests

```bash
cd examples/typescript
npm test
```

The suite covers the fail-closed rules: tampered signature, stale timestamp, unknown request id, replayed callback, expired approval, and an action mutated after approval.

## What you need to prepare

### In Contro1

- Create an account and organization.
- Open **Settings -> APIs & Webhooks**.
- Create an API key named e.g. `OpenClaw approval bridge` and set it as `CONTRO1_API_KEY`.
- Reveal or rotate the organization webhook secret and set it as `CONTRO1_WEBHOOK_SECRET`.
- Choose where approvals go: dashboard, Slack, Microsoft Teams, or your operator workflow.
- Define reviewer routing (required role, department, SLA, escalation).

### In this bridge deployment

- Deploy `examples/typescript` on any host that can receive HTTPS (Cloud Run, ECS, Kubernetes, Render, Fly.io, a VM).
- Set `PUBLIC_BASE_URL` to its public address; Contro1 posts the signed decision to `<PUBLIC_BASE_URL>/contro1/callback`.
- Give it an OpenClaw operator token with `operator.approvals` (full `pending` enumeration currently also draws on `operator.admin`).
- Keep the API key and webhook secret out of source control.

### In OpenClaw

- Set `tools.exec.mode` to `ask` (or `auto` with a conservative allowlist) so misses stop for the bridge.
- Keep `askFallback: "deny"` so an unreachable bridge means deny, not run.
- Set `skills.workshop.approvalPolicy` to `pending` so the assistant cannot rewrite its own skills to grant new powers.
- Optionally install `skills/contro1-openclaw-agent.md` into the assistant's skills directory and set `CONTRO1_BRIDGE_URL` so it self-logs autonomous actions to `POST /agent/audit`.

## Configuration

See [.env.example](.env.example) for all variables and [docs/openclaw-connector.md](docs/openclaw-connector.md) for the policy schema, protocol mapping, event taxonomy, and fail-closed rules.

## Compatibility

Built and verified against OpenClaw **stable `v2026.7.1`**. The default `cli` transport uses only documented `openclaw approvals` commands. The `gateway` WebSocket transport is a preview pending the publication of `@openclaw/gateway-client` on npm.

## License

MIT
