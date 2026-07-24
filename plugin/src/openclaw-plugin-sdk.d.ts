/**
 * Minimal ambient declaration for the slice of the OpenClaw plugin SDK this
 * plugin uses. It lets the plugin typecheck in this repo without installing the
 * full `openclaw` peer dependency. At runtime the real package provides these,
 * and `openclaw plugins build` / `openclaw plugins validate` check the manifest
 * against the actual SDK.
 *
 * Faithful to docs.openclaw.ai/plugins/sdk-entrypoints and
 * docs.openclaw.ai/plugins/plugin-permission-requests (OpenClaw v2026.7.1).
 */
declare module 'openclaw/plugin-sdk/plugin-entry' {
  export type ToolCallEvent = {
    /** The tool the model selected. */
    toolName: string;
    /** The arguments the model passed to the tool. */
    params: Record<string, unknown>;
    agentId?: string;
    sessionKey?: string;
  };

  export type ApprovalDecision = 'allow-once' | 'allow-always' | 'deny';

  /**
   * Ask a human before this tool call runs. Unknown, malformed, mismatched,
   * missing, and timed-out decisions all fail closed. `title` is capped at 80
   * characters and `description` at 512; neither should contain secrets, since
   * they render on chat approval surfaces.
   */
  export type RequireApproval = {
    title: string;
    description?: string;
    /** Defaults to "warning". Use "critical" only for production/irreversible harm. */
    severity?: 'warning' | 'critical';
    /** Defaults to ["allow-once","allow-always","deny"]. Drop allow-always when standing trust is unsafe. */
    allowedDecisions?: ApprovalDecision[];
    timeoutMs?: number;
    onResolution?: (decision: ApprovalDecision) => void;
  };

  export type BeforeToolCallResult = void | { requireApproval: RequireApproval };

  export type OpenClawPluginApi = {
    on(
      event: 'before_tool_call',
      handler: (event: ToolCallEvent) => Promise<BeforeToolCallResult> | BeforeToolCallResult,
    ): void;
  };

  export type PluginEntry = {
    id: string;
    name: string;
    register: (api: OpenClawPluginApi) => void;
  };

  export function definePluginEntry(entry: PluginEntry): PluginEntry;
}
