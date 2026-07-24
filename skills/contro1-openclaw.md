---
name: contro1-openclaw
description: Add Contro1 human approvals, role routing, quorum, and signed audit evidence to OpenClaw exec and plugin approvals through an external bridge, without touching the gateway process.
---

# Contro1 OpenClaw Skill

Use this skill when integrating Contro1 with OpenClaw so that sensitive exec and plugin actions stop for a human, route to the right owner, and leave signed audit evidence.

## Positioning

OpenClaw already knows how to stop before a risky command: its exec-approval engine holds a pending approval and waits for a decision. Contro1 governs who makes that decision, how it routes, and what evidence survives.

Build an **external approval bridge**, not a native plugin. OpenClaw's own docs are explicit that native plugins run in-process with the gateway and are not sandboxed, so a faulty or hostile plugin can take down or compromise the whole gateway. The bridge runs as a separate operator client and is the correct trust boundary. Put Contro1 in front of:

- exec approvals (`exec.approval.requested`, resolved by `openclaw approvals resolve <id> <decision>`)
- plugin approvals (`plugin.approval.requested`)
- OpenClaw system-agent approvals surfaced by `openclaw approvals pending`

## Required Discovery

Before coding in a customer repo, inspect:

- how OpenClaw is configured: `tools.exec.mode` (`deny` / `allowlist` / `ask` / `auto` / `full`), `ask`, and `askFallback`
- whether the bridge will reach OpenClaw via the `openclaw` CLI (default) or the Gateway WebSocket (preview)
- what operator credentials the bridge holds; approval resolution needs `operator.approvals`, and full `pending` enumeration currently also draws on `operator.admin`
- how agent id, session key, and host (gateway vs node) are represented in this deployment
- which sessions are production and must never be auto-allowed
- where the signed Contro1 callback can be received (public HTTPS URL for `PUBLIC_BASE_URL`)

## Integration Rules

- Do not weaken OpenClaw. Keep `askFallback: "deny"` so that if the bridge is unreachable, OpenClaw denies rather than runs.
- Route exec and plugin approvals through Contro1; resolve them only from a verified signed callback.
- Set OpenClaw to `ask` (or `auto` with a conservative allowlist) so misses actually stop for the bridge to pick up.
- Use a deterministic `external_request_id` (`openclaw:<kind>:<approval_id>`) for idempotency.
- Use the OpenClaw session key as `correlation_id` so a whole session groups in the timeline.
- Bind every approval to the machine-observed facts (command, argv, cwd, agent, session) with a hash; re-check the binding before resolving, mirroring OpenClaw's own `systemRunPlan` mismatch rejection.
- Only machine-observed facts feed risk and routing. Text the agent authored is display-only.
- Fail closed on invalid signature, stale timestamp (older than 5 minutes), unknown request id, expired approval, or binding mismatch.
- Beat OpenClaw's 30-minute approval expiry: set the Contro1 request `expires_at` to the approval's `expiresAtMs`.
- Log auto-allowed and denied actions as audit records, not just approvals, so the timeline has no holes.

## Protocol Mapping

Use:

- `source.integration = "openclaw"`
- `context.action_type = "shell_exec" | "tool_invoke" | "session_control"`
- `policy_context.source = "openclaw_approval_bridge"`
- `actor.agent_id` = OpenClaw `agentId`
- `correlation_id` = OpenClaw `sessionKey`
- `approval_comment_required = true` for production sessions and any sensitive command shape

## Event Names

Use these audit actions:

```text
openclaw.approval.requested
openclaw.approval.auto_allowed
openclaw.approval.blocked
openclaw.approval.approved
openclaw.approval.denied
openclaw.approval.expired
openclaw.approval.binding_mismatch
openclaw.approval.resolve_failed
```

## Policy Defaults

Auto-allow only when the operator has explicitly added an auto-allow pattern and the session is not production. Absent that, an approval OpenClaw already stopped for stays stopped for a human.

Require approval for every plugin/system-agent approval, every production-session command, and any command matching a sensitive shape (pipe-to-shell, `sudo`, `ssh`, cloud CLIs, `kubectl`, `terraform apply/destroy`, `git push`, `npm publish`, secret/`.env`/`.ssh` access).

Block outright, before a reviewer sees them, unambiguously destructive shapes (`rm -rf /`, fork bombs, `mkfs`, `dd` to a device) and unknown agents when an allowed-agent list is configured.

## Final Report

When done, report:

- which OpenClaw approvals now route through Contro1 (exec, plugin, system-agent)
- the OpenClaw config applied (`tools.exec.mode`, `ask`, `askFallback`) and why `askFallback` stays `deny`
- the operator scope granted to the bridge (`operator.approvals`, and whether `operator.admin` was needed for enumeration)
- approval policy defaults (auto-allow, require-approval, block)
- audit event names added
- callback signature verification and action-binding status
- smoke tests performed (mock approve, deny, tamper, replay, expiry, binding mismatch)
- remaining limitation: the Gateway WebSocket transport stays preview until `@openclaw/gateway-client` publishes the device-auth signature; the CLI transport is the supported path
