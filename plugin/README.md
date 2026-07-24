# Contro1 Approvals - OpenClaw plugin

**Turn any sensitive OpenClaw tool call into a human approval routed to Contro1. Free up to 1,000 approval requests per month.**

This is the ClawHub-installable half of the [Contro1 OpenClaw connector](../README.md). The external bridge governs the exec and plugin approvals OpenClaw already raises; this plugin extends the *coverage* to **any** sensitive tool call - sending an email, buying something in the browser, deleting a file, deploying - by pausing it for approval through OpenClaw's `before_tool_call` hook.

## Install

1. Install `contro1-approvals` from ClawHub into your OpenClaw.
2. Turn on plugin approval forwarding so the bridge can route the approvals:

   ```bash
   openclaw config set approvals.plugin.enabled true
   ```
3. Run the [bridge](../examples/typescript) so approvals go to Contro1. Without it, a paused tool call falls back to OpenClaw's own `/approve` in chat, with no role routing or signed evidence.

## What it pauses

A `before_tool_call` hook fires on **every** tool call, so the default is **allow** - only sensitive calls pause, or the assistant would stall on every step.

- **Require approval:** send/message, buy/pay/transfer, deploy/publish, delete/destroy, exec/shell, browser submit/checkout, credential/secret access, permission grants - or any call carrying a sensitive parameter (`amount`, `to`, `recipient`, ...).
- **Critical (no standing allow-always):** payments, deletes, deploys, credential access.
- **Always allow:** reads and drafts (`get_*`, `list_*`, `read_*`, `search_*`, `draft_*`).

Override the defaults with the `CONTRO1_TOOL_POLICY` environment variable (a JSON string matching `ToolPolicyConfig` in [src/policy.ts](src/policy.ts)).

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
