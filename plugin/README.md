# Contro1 Approvals - OpenClaw plugin

**Turn any sensitive OpenClaw tool call into a human approval routed to Contro1. Free up to 1,000 approval requests per month.**

This is the ClawHub-installable half of the [Contro1 OpenClaw connector](https://github.com/contro1-hq/contro1-openclaw-connector). The external bridge governs the exec and plugin approvals OpenClaw already raises; this plugin extends the *coverage* to **any** sensitive tool call - sending an email, buying something in the browser, deleting a file, deploying - by pausing it for approval through OpenClaw's `before_tool_call` hook.

**Learn more:** [contro1.com](https://contro1.com) · [How it works](https://contro1.com/docs/openclaw-human-approval) · [Source on GitHub](https://github.com/contro1-hq/contro1-openclaw-connector)

## Install

This plugin only pauses sensitive tool calls. Routing an approval to a human and keeping the evidence is done by Contro1 through the bridge, so you need a free Contro1 account and the bridge running.

1. **Create a free Contro1 account** at [contro1.com](https://contro1.com) and sign in. Open **Settings -> APIs & Webhooks** and copy your **API key** and **organization webhook secret**. Free up to 1,000 approval requests per month.
2. **Deploy the [bridge](https://github.com/contro1-hq/contro1-openclaw-connector/tree/main/examples/typescript)** and give it those two values as `CONTRO1_API_KEY` and `CONTRO1_WEBHOOK_SECRET`, plus a public `PUBLIC_BASE_URL`. The [full setup guide](https://contro1.com/docs/openclaw-human-approval) walks through it step by step.
3. **Install this plugin** (`contro1-approvals`) from [ClawHub](https://clawhub.ai/contro1/plugins/openclaw-approvals-plugin).
4. **Turn on plugin approval forwarding** so the bridge sees the approvals:

   ```bash
   openclaw config set approvals.plugin.enabled true
   ```

Without the bridge and a Contro1 account, a paused tool call falls back to OpenClaw's own `/approve` in chat, with no role routing or signed evidence.

## What it pauses

A `before_tool_call` hook fires on **every** tool call, so the default is **allow** - only sensitive calls pause, or the assistant would stall on every step.

- **Require approval:** send/message, buy/pay/transfer, deploy/publish, delete/destroy, exec/shell, browser submit/checkout, credential/secret access, permission grants - or any call carrying a sensitive parameter (`amount`, `to`, `recipient`, ...).
- **Critical (no standing allow-always):** payments, deletes, deploys, credential access.
- **Always allow:** reads and drafts (`get_*`, `list_*`, `read_*`, `search_*`, `draft_*`).
- **Exception:** a read/list/get-shaped name that also matches `credential|secret|token|api_key|password|ssh|vault|keychain|keyring` (e.g. `read_credentials`, `get_secret`) is not covered by the always-allow rule above - it still requires approval, and is treated as critical (no standing allow-always).

Override the defaults with the `CONTRO1_TOOL_POLICY` environment variable (a JSON string matching `ToolPolicyConfig` in [src/policy.ts](https://github.com/contro1-hq/contro1-openclaw-connector/blob/main/plugin/src/policy.ts)). Set `sensitiveReadOverridePatterns` explicitly if your own credential/secret tool names don't match the default list.

## No credentials, no network

OpenClaw plugins run in-process with the gateway and are not sandboxed, so this plugin is deliberately minimal: it holds no Contro1 credentials and makes no network calls. It only classifies a tool call and returns `requireApproval`. Everything that touches a secret - creating the Contro1 request, verifying the signed decision, keeping evidence - stays in the external bridge.

## Fail closed

Unknown, malformed, mismatched, missing, and timed-out decisions all fail closed: OpenClaw denies the call. The deprecated `timeoutBehavior` field is intentionally not set.

---

## Building from source

Only needed if you fork or customize the plugin; installing from ClawHub needs none of this.

```bash
npm install
npm run build
npm run manifest      # openclaw plugins build --entry ./dist/index.js
npm run validate      # openclaw plugins validate --entry ./dist/index.js
```

`openclaw plugins build` aligns `openclaw.plugin.json` and the `package.json` `openclaw.compat.pluginApi` / `openclaw.build.openclawVersion` fields to your installed OpenClaw. On install, OpenClaw validates `pluginApi` and `minGatewayVersion` compatibility.
