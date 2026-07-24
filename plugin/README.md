# Contro1 Approvals - OpenClaw plugin

**Turn any sensitive OpenClaw tool call into a human approval routed to Contro1. Free up to 1,000 approval requests per month.**

This is the ClawHub-installable half of the [Contro1 OpenClaw connector](../README.md). Where the external bridge governs the exec and plugin approvals OpenClaw already raises, this plugin extends the *coverage*: it uses OpenClaw's `before_tool_call` hook to turn **any** sensitive tool call - sending an email, buying something in the browser, deleting a file, deploying - into an approval.

## Thin by design

OpenClaw plugins run in-process with the gateway and are **not sandboxed**, so this plugin is deliberately minimal:

- It **holds no Contro1 credentials** and makes **no network calls**.
- Its only job is to classify a tool call and return `requireApproval`.
- The credential-bearing governance - creating the Contro1 request, verifying the signed decision, keeping evidence - stays in the **external bridge**, out of the gateway process.

When this plugin returns `requireApproval`, OpenClaw raises a plugin approval. The bridge picks it up from `openclaw approvals pending`, routes it to the right human (role routing, quorum, SLA), and resolves it. Enable forwarding so the bridge sees them:

```bash
openclaw config set approvals.plugin.enabled true
```

## Default policy

A `before_tool_call` hook fires on **every** tool call, so the default is **allow** - only sensitive calls pause, or the assistant would stall on every step.

- **Require approval:** send/message, buy/pay/transfer, deploy/publish, delete/destroy, exec/shell, browser submit/checkout, credential/secret access, permission grants - or any call carrying a sensitive parameter (`amount`, `to`, `recipient`, ...).
- **Critical (no standing allow-always):** payments, deletes, deploys, credential access.
- **Always allow:** reads and drafts (`get_*`, `list_*`, `read_*`, `search_*`, `draft_*`).

Override with `CONTRO1_TOOL_POLICY` (a JSON string matching `ToolPolicyConfig` in [src/policy.ts](src/policy.ts)).

## Fail closed

Unknown, malformed, mismatched, missing, and timed-out decisions all fail closed - OpenClaw denies the call. The deprecated `timeoutBehavior` field is intentionally not set.

## Build, validate, publish

```bash
npm install
npm run build
npm run manifest      # openclaw plugins build --entry ./dist/index.js
npm run validate      # openclaw plugins validate --entry ./dist/index.js

# preview, then publish to ClawHub
clawhub package publish . --dry-run
npm run publish:clawhub
```

`openclaw plugins build` aligns `openclaw.plugin.json` and the `package.json` `openclaw.compat.pluginApi` / `openclaw.build.openclawVersion` fields to your installed OpenClaw. ClawHub tracks semver, tags, changelog, and runs an automated security scan; installs validate `pluginApi` and `minGatewayVersion` compatibility.

## Pairing

Install this plugin **and** run the bridge:

- Plugin (this package): coverage - turns sensitive tool calls into approvals.
- [Bridge](../examples/typescript): governance - routes the approval to Contro1 and keeps the evidence.

Use the plugin without the bridge and approvals fall back to OpenClaw's own chat surfaces (`/approve`), with no role routing or signed evidence.
