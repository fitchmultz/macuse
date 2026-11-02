import type { AppObservation } from "./app-state.mjs";
export type CuaContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };
export interface CuaInput {
  code: string;
  apps?: string[];
  allowMutating?: boolean;
  safetyNote?: string;
  timeoutMs?: number;
}
export interface CuaAction {
  id: number;
  method: string;
  app: string;
  dispatched: boolean;
  outcome: "not_dispatched" | "unknown" | "completed";
  verification: "none" | "native-returned" | "exact-field-value" | "native-window-closed";
  target?: { index: string; id?: string; role: string; name: string };
  before?: { title: string | null; url: string | null; nativeWindowIdentity: boolean };
  closesWindow?: boolean;
  error?: string;
}
export interface CuaResult {
  content: CuaContent[];
  isError: boolean;
  details: {
    macuse: {
      runId: string;
      status: "completed" | "failed" | "unknown" | "running";
      /** Absent on read-only results without recorded actions. */
      actions?: CuaAction[] | undefined;
      /** Absent when no observations were retained for the run. */
      observations?: AppObservation[] | undefined;
      kernelReset: boolean;
      interruption?: string;
      provisionalActions?: unknown[];
      images: Array<{
        index: number;
        mimeType?: string;
        width?: number;
        height?: number;
        coordinateSpace: "native-screenshot";
        scale: string;
      }>;
      /** Set by MacuseSession when saveImagePath exports the first screenshot. */
      savedImage?: {
        path: string;
        bytes: number;
        sha256: string;
        mimeType?: string;
        width?: number;
        height?: number;
      };
      /** Set by MacuseSession from native focus observation; attribution is never claimed. */
      focus?: Record<string, unknown>;
    };
  };
}
export interface CuaStatus {
  connected: boolean;
  running: boolean;
  resetting: boolean;
  runId?: string;
  kernelResets: number;
}
/** Structural request shape the runtime dispatches to the native client. */
export interface CuaToolRequest {
  name: string;
  arguments: Record<string, unknown>;
  _meta?: { macuse?: Record<string, unknown> } | undefined;
}
/** Structural call options the runtime passes to the native client. */
export interface CuaCallToolOptions {
  signal?: AbortSignal | undefined;
  timeout?: number | undefined;
  resetTimeoutOnProgress?: boolean | undefined;
  maxTotalTimeout?: number | undefined;
}
/**
 * Structural view of the MCP client the runtime drives: the SDK client and
 * test fakes that provide these members are both acceptable connections.
 */
export interface CuaClient {
  callTool(
    request: CuaToolRequest,
    schema?: unknown,
    options?: CuaCallToolOptions,
  ): Promise<unknown>;
  close(): Promise<void>;
}
export class CuaRuntime {
  constructor(options?: {
    cwd?: string;
    resourcesPath?: string;
    connect?: (options: unknown, onDiagnostic: (event: unknown) => void) => Promise<CuaClient>;
  });
  execute(
    input: CuaInput | Record<string, unknown>,
    options?: {
      signal?: AbortSignal;
      onUpdate?: (update: {
        content: CuaContent[];
        isError: boolean;
        details: { macuse: Partial<CuaResult["details"]["macuse"]> };
      }) => void;
    },
  ): Promise<CuaResult>;
  getObservation(app: string): AppObservation | undefined;
  invalidateObservation(app: string): void;
  reset(): Promise<CuaStatus>;
  stop(): Promise<void>;
  status(): CuaStatus;
}
export function resolveLaunch(options?: { cwd?: string; resourcesPath?: string }): Promise<{
  command: string;
  args: [string];
  cwd: string;
  env: LaunchEnv & Record<string, string>;
}>;
export interface LaunchEnv {
  CODEX_HOME: string;
  CODEX_CLI_PATH: string;
  CUA_REPL_NODE_REPL_PATH: string;
  CUA_REPL_ENABLED_SURFACES: string;
  NODE_REPL_NODE_PATH: string;
  NODE_REPL_NODE_MODULE_DIRS: string;
  NODE_REPL_TRUSTED_CODE_PATHS: string;
  NODE_REPL_TRUSTED_SERVICES: string;
  MACUSE_SKY_SERVICE_URL: string;
}
export function imageMetadata(data: string): { mimeType?: string; width?: number; height?: number };
export function appApproval(request: any): {
  action: "accept" | "decline";
  content?: Record<string, never>;
};
