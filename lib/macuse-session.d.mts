import type { AppObservation } from "./app-state.mjs";
import type {
  NativeApplication,
  NativeAppState,
  NativeObservation,
  NativeRequestOptions,
} from "../tools/macos-native.mjs";

export type Content =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };
export type MacuseResult = {
  content: Content[];
  isError: boolean;
  details: { macuse: Record<string, unknown> };
};
/**
 * Structural result surface MacuseSession consumes from an injected runtime.
 * Production's CuaResult carries the same fields plus optional evidence.
 */
export type SessionResult = {
  content: Content[];
  isError: boolean;
  details: {
    macuse: {
      observations?: AppObservation[] | undefined;
      actions?: SessionAction[] | undefined;
      focus?: Record<string, unknown> | undefined;
      [key: string]: unknown;
    };
  };
};
/** Structural runtime seam MacuseSession drives; production uses CuaRuntime. */
export type SessionAction = {
  id?: unknown;
  method: string;
  app: string;
  dispatched?: unknown;
  outcome?: string;
  closesWindow?: boolean;
  verification?: string;
  before?: { title: string | null; url: string | null; nativeWindowIdentity: boolean };
};
export type SessionRuntime = {
  execute: (
    input: unknown,
    options?: {
      signal?: AbortSignal | undefined;
      onUpdate?:
        | ((update: {
            content: Content[];
            isError: boolean;
            details: { macuse: Record<string, unknown> };
          }) => void)
        | undefined;
    },
  ) => Promise<SessionResult>;
  getObservation: (app: string) => AppObservation | undefined;
  reset: () => Promise<unknown>;
  stop: () => Promise<void>;
  status: () => unknown;
};
/** Structural native seam MacuseSession drives; production uses MacOSNative. */
export type SessionNative = {
  resolveApp: (identifier: string, options?: NativeRequestOptions) => Promise<NativeApplication>;
  inspectApp: (pid: number, options?: NativeRequestOptions) => Promise<NativeAppState>;
  beginObservation: (
    pids?: number[],
    options?: NativeRequestOptions,
  ) => Promise<{ id: string; before?: NativeObservation["before"] }>;
  endObservation: (id: string, options?: NativeRequestOptions) => Promise<NativeObservation>;
  stop: () => Promise<void>;
};
/** Structural auxiliary seam MacuseSession drives; production uses AuxiliaryRuntime. */
export type SessionAuxiliary = {
  callTool: (
    tool: string,
    input?: Record<string, unknown>,
    options?: {
      signal?: AbortSignal | undefined;
      timeoutMs?: number | undefined;
    },
  ) => Promise<SessionResult>;
  stop: () => Promise<void>;
  status: () => unknown;
};
export class MacuseSession {
  cwd: string;
  /** Test injection seams; production callers construct with cwd only. */
  runtime: SessionRuntime;
  native: SessionNative;
  auxiliary: SessionAuxiliary;
  constructor(options?: {
    cwd?: string | undefined;
    /** Test injection seams; production callers construct with cwd only. */
    runtime?: SessionRuntime | undefined;
    native?: SessionNative | undefined;
    auxiliary?: SessionAuxiliary | undefined;
  });
  callTool(
    tool: string,
    input?: Record<string, unknown>,
    options?: {
      signal?: AbortSignal | undefined;
      timeoutMs?: number;
      onUpdate?: ((result: MacuseResult) => void) | undefined;
    },
  ): Promise<MacuseResult>;
  reset: () => Promise<MacuseResult>;
  status(): { computer: unknown; auxiliary: unknown };
  stop: () => Promise<void>;
}
