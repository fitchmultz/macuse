export type AuxiliaryToolName =
  | 'event_stream_start' | 'event_stream_status' | 'event_stream_stop'
  | 'computer_history_pause' | 'computer_history_resume' | 'computer_history_status'
  | 'computer_history_get_settings' | 'computer_history_update_settings';
export type ObservationEntry =
  | { scope: 'app'; bundleID: string; urlDomain?: string }
  | { scope: 'url'; urlDomain: string; bundleID?: string };
export type ObservationSettings = {
  defaultApplicationBehavior: 'observe' | 'do_not_observe';
  defaultURLBehavior: 'observe' | 'do_not_observe';
  allowlist: ObservationEntry[];
  blocklist: ObservationEntry[];
};
export type AuxiliaryToolDescriptor = {
  name: AuxiliaryToolName;
  description: string;
  inputSchema: { type: 'object'; additionalProperties: false; properties: Record<string, unknown>; required: string[] };
  annotations: { readOnlyHint: boolean; destructiveHint: false; idempotentHint: boolean; openWorldHint: false };
};
export type AuxiliaryResult = {
  content: Array<{ type: string; [key: string]: unknown }>;
  isError: boolean;
  details: { macuse: {
    tool: string;
    isError: boolean;
    dispatched: boolean;
    outcome: 'reported' | 'unknown' | 'not_dispatched';
    reason?: string;
    missingTools?: string[];
    attempts: number;
    durationMs: number;
  } };
};
export const auxiliaryTools: AuxiliaryToolDescriptor[];
/** Validates local safety flags/settings and returns a detached upstream-only argument object. Throws on invalid input. */
export function validateAuxiliaryArguments(tool: string, input?: unknown): { observation?: ObservationSettings };
export class AuxiliaryRuntime {
  constructor(options?: { cwd?: string; codexBin?: string });
  readonly cwd: string;
  readonly codexBin: string;
  /** Settings updates replace the complete observation: callers must preserve unchanged freshly read fields. */
  callTool(tool: string, input?: unknown, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<AuxiliaryResult>;
  status(): { running: boolean; processPid: number | null; threadId: string | null; pendingRequests: number; cwd: string; codexBin: string; stderrTail: string };
  /** Stops only the owned transport and awaits its exit; the next call can start lazily. */
  stop(): Promise<void>;
}
