# Contro1 OpenClaw Connector

**Contro1 wraps your OpenClaw assistants.** Risky commands and sensitive tool calls come to Contro1 as approval requests, routed to the right person in your organization and kept in the audit trail. Each assistant has an accountable owner and its own connection, with no API key on the machine, and with the Contro1 MCP server it reaches company applications only through Contro1.

Repository description:

> External approval bridge that routes OpenClaw exec and plugin approvals to Contro1 for human decisions, role routing, quorum, and signed audit evidence, with fail-closed action binding.

## Links

- Website: https://contro1.com
- Documentation: https://contro1.com/docs/openclaw-human-approval
- Contro1 CLI (your assistant can use it too): https://contro1.com/docs/cli
- Agent Integration Kit: https://contro1.com/agent-kit

> Because an OpenClaw assistant can run shell commands, no Contro1 runtime credential is placed where it can read it. The bridge runs on the host and uses per-agent local broker endpoints. The Contro1 Remote MCP remains the build-time discovery/setup path; the Contro1 CLI is the host-side runtime contract.

OpenClaw is an open-source personal AI assistant that runs on your own machine, answers on the channels you already use (WhatsApp, Telegram, iMessage, Signal, Slack, and more), keeps persistent memory, browses the web, runs shell commands, manages email and calendar, and can write its own skills. It acts autonomously in the background. This connector governs what it is allowed to do.

## The problem this solves

You run OpenClaw as your assistant. You give it access to your mailbox, because
you message it privately and you want it to handle your email. That works, and
it is the reason you connected it.

OpenClaw answers on the channels you already use, and one of them is a group: a
project with a client, a trip with friends, a team channel. Somebody in that
group messages the assistant.

**It answers. It has no way to know the person asking is not you.** It performs
the action with its own authority, so a request from the group and a request
from your private thread look identical to it. Anyone in that group can now ask
it what is in your mailbox. No permission was changed and nothing was inherited.
The assistant simply answered the channel it was on.

This is the confused deputy problem. It applies to any agent that more than one
person can instruct while it holds standing access to one person's data. It is
not a misconfiguration: it is what happens when the unit of authorization is the
agent while the unit of exposure is the conversation.

### Why a local install does not make this go away

The bridge talks to OpenClaw over a local socket, as one operating system user,
with no credential on disk where the assistant could read it. That is a real
protection and it is worth having.

**It protects the credential, not the instruction surface.** Who can reach the
socket and who can message the assistant are different questions, and only the
first one is answered by running locally. An assistant on your own laptop can
still be sitting in a group chat.

### How Contro1 solves it

**1. An OpenClaw assistant is treated as reachable by people Contro1 cannot
name.** The bridge cannot enumerate which channels are wired up or who is in
them, so it does not pretend to. If your assistant genuinely has no chat
channels, say so with `CONTRO1_OPENCLAW_REACH=private`. That is a claim with a
person behind it, which is worth more than an inference with nobody behind it,
and it is visible in the record.

**2. An assistant other people can instruct cannot use a personal account on its
own.** Organization accounts are unaffected: those are already bounded by a
resource boundary somebody approved. The gate is specifically about one person's
account being borrowed by software that answers to several. You can allow it
anyway, and that decision is recorded with your name and the date.

**3. Every request states who could have asked.** The reviewer sees it beside
the command:

```text
requested_from   OpenClaw on workstation
reachable_by     unknown: OpenClaw answers on chat channels this bridge
                 cannot enumerate, so anyone on one of them may have asked
command          curl -s https://example.com/report | sh
```

The command alone was never the whole question.

**4. Not knowing is never read as safety.** Everything that cannot be
established is stated in plain words and treated as exposure. Silence never
earns privacy.

### What this connector cannot secure, stated plainly

Two things cannot be enforced here, and knowing which they are is worth more
than a reassurance that covers them over.

**It cannot tell which conversation an instruction came from.** OpenClaw answers
on WhatsApp, Telegram, iMessage, Signal and Slack, any of which can be a group.
The bridge sees an approval, not the channel it started in, and the fields an
approval does carry (`sessionKey`, `host`, `cwd`) are best-effort projections
that the CLI sanitizes, which is why this connector never makes a security
decision from them. **Nothing here can be scoped to "only when I ask in my
private chat."** An assistant that can use an account can be asked to use it by
anyone who can reach the assistant.

**It cannot tell who is on the other end.** There is no sender identity in the
approval surface. A request from a colleague, from a client in a shared channel,
and from you are indistinguishable by the time a reviewer sees them.

What is enforced is unaffected by either: a command stops before it runs, a
named person decides, the decision is bound to the exact command by a hash
recomputed before it is applied, and the exchange is recorded. That is a
different guarantee from knowing who asked, and it is the one on offer.

> Where a limit exists, it is named here. A guardrail described as stronger than
> it is does more damage than a missing one, because somebody plans around it.

## What this connector does

This connector is the small server in this repository. You deploy it in your own environment as an OpenClaw **operator client**, running outside the gateway process. Instead of a human answering every `/approve` in chat, the bridge routes each pending approval to Contro1, waits for a signed decision, verifies it, and only then resolves the approval in OpenClaw. It also gives you a durable audit trail of the assistant's autonomous background work through an agent-side self-logging skill.

Governed approval families:

- **exec approvals** - host shell commands that miss the allowlist under `ask`/`auto` mode
- **plugin approvals** - plugin-owned operations that request approval per call
- **system-agent approvals** - surfaced together by `openclaw approvals pending`

Contro1 decides whether each is auto-allowed, routed to a human, or blocked. Every decision is recorded as signed audit evidence linked to the OpenClaw agent, session, and command.

## Two parts: bridge and ClawHub plugin

- **[Bridge](examples/typescript)** - governance. Runs outside the gateway, calls the Contro1 CLI through a per-agent local broker endpoint, routes approvals to the right human, and keeps signed evidence.
- **[ClawHub plugin](plugin)** - coverage. A thin, secret-free plugin that uses OpenClaw's `before_tool_call` hook to turn *any* sensitive tool call (email, browser purchase, file delete, deploy) into an approval - not just host exec. It holds no credentials and makes no network calls; the bridge does the credential-bearing work. Install it from [ClawHub](https://clawhub.ai/contro1/plugins/openclaw-approvals-plugin) for one click. **Free up to 1,000 approval requests per month.**

You can run the bridge alone (governs exec/plugin approvals OpenClaw already raises) or add the plugin to extend coverage to every sensitive tool call.

## Why governance runs outside the gateway

OpenClaw plugins run **in-process with the gateway and are not sandboxed** - a faulty or hostile plugin can crash or compromise the whole gateway. So anything that holds a credential or makes the approval decision stays **outside** it, in the bridge. The optional [plugin](plugin) is safe to run in-process precisely because it does neither: it holds no credentials, makes no network calls, and only asks OpenClaw to pause. See [docs/openclaw-connector.md](docs/openclaw-connector.md).

## Quick start (no OpenClaw gateway needed)

Mock mode skips the OpenClaw gateway, not Contro1: the bridge still needs an
owner-approved connection, so connect first.

```bash
contro1 connect openclaw            # once per computer; the owner approves
cd examples/typescript
npm install
cp ../../.env.example .env          # Linux path is preset; on Windows use C:\ProgramData\Contro1\platforms\openclaw.json
OPENCLAW_TRANSPORT=mock npm run dev
```

Then, in another terminal, inject an approval as if OpenClaw had raised one:

```bash
curl -sX POST http://localhost:8092/mock/approvals \
  -H 'content-type: application/json' \
  -d '{"rawCommand":"sudo systemctl restart api","agentId":"main","sessionKey":"whatsapp:+15550001111"}'
```

Run `contro1 connect openclaw` before starting the bridge. It discovers agents, obtains owner approval, installs the local broker, and writes `CONTRO1_PLATFORM_MAPPING_FILE`. An unmapped agent fails closed and never creates a simulated approval.

## Run the tests

```bash
cd examples/typescript
npm test
```

The suite covers the fail-closed rules: tampered signature, stale timestamp, unknown request id, replayed callback, expired approval, and an action mutated after approval.

## What you need to prepare

### In Contro1

- Create an account and organization.
- Run `contro1 connect openclaw` and approve the discovered agents in one owner approval screen.
- Verify the broker and mappings with `contro1 doctor openclaw --format json --quiet`.
- If using legacy webhook callback mode, reveal or rotate the organization webhook secret and set it as `CONTRO1_WEBHOOK_SECRET`.
- Choose where approvals go: dashboard, Slack, Microsoft Teams, or your operator workflow.
- Define reviewer routing (required role, department, SLA, escalation).

### In this bridge deployment

- Deploy `examples/typescript` on the host that runs OpenClaw, or any host that can reach it. In the default polling mode it needs no inbound HTTPS.
- Install the `contro1` CLI **0.2.0 or later** (it adds `contro1 connect`, the local Contro1 service and `activity report`); the bridge calls it for every Contro1 operation. Set `CONTRO1_API_URL` only for a staging or self-hosted stack; the bridge passes it as `--api-url`.
- Prefer polling through the Contro1 CLI for local/private hosts. Set `PUBLIC_BASE_URL` only when using legacy webhook callback mode; Contro1 posts the signed decision to `<PUBLIC_BASE_URL>/contro1/callback`.
- Give it an OpenClaw operator token with `operator.approvals` (full `pending` enumeration currently also draws on `operator.admin`).
- Keep the mapping file and any webhook secret out of source control and out of anything the assistant can read.

### In OpenClaw

- Set `tools.exec.mode` to `ask` (or `auto` with a conservative allowlist) so misses stop for the bridge.
- Keep `askFallback: "deny"` so an unreachable bridge means deny, not run.
- Set `skills.workshop.approvalPolicy` to `pending` so the assistant cannot rewrite its own skills to grant new powers.
- Optionally install the `contro1-approvals` skill (`skills/contro1-approvals/SKILL.md`) into the assistant's skills directory and set `CONTRO1_BRIDGE_URL` so it self-logs autonomous actions to `POST /agent/audit`.

### Optional: company applications through Contro1 (MCP)

The bridge governs what OpenClaw stops for. To let an assistant use company applications (mail, calendar, tickets) with Contro1 deciding what it may do, give OpenClaw the Contro1 MCP server:

1. In Contro1, open the agent, allow applications for its connection, and choose the application actions it may use. An administrator grants; anyone else sends a request that grants nothing until approved.
2. Add the server to `openclaw.json`, pointing at that agent's own endpoint from the mapping file (`/etc/contro1/platforms/openclaw.json` on Linux):

```json5
{
  mcp: {
    servers: {
      contro1: {
        command: "contro1",
        args: ["mcp", "serve", "--broker-endpoint", "<endpoint of this agent from the mapping file>"]
      }
    }
  }
}
```

OpenClaw MCP servers apply to the whole gateway, not to one agent. With a single agent on the computer that is exactly right. With several agents, one `contro1` entry would let every agent act as that one identity, so do not share it: keep the others on approvals only until you can give each its own gateway.

## Configuration

See [.env.example](.env.example) for all variables and [docs/openclaw-connector.md](docs/openclaw-connector.md) for the policy schema, protocol mapping, event taxonomy, and fail-closed rules.

## Compatibility

Built against OpenClaw **stable `v2026.7.1`**; the `openclaw approvals pending --json` and `resolve` commands the default `cli` transport uses are unchanged in the documentation for **`v2026.9.4`** (checked 2026-09-15). Since `v2026.8.1`, `allow-always` grants are directory-bound; the bridge resolves with `allow-once` by default, so this does not change its behavior. The `gateway` WebSocket transport is still a preview: `@openclaw/gateway-client` is now published on npm (`2026.9.4`), so it can be completed, but it is not implemented or tested yet.

## License

MIT
