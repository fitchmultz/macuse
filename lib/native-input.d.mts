import type {
  NativeApplication,
  NativeAppState,
  NativeObservation,
  NativeRequestOptions,
  NativeTextRequest,
  NativeTextResult,
} from "../tools/macos-native.mjs";
import type { AppObservation } from "./app-state.mjs";

/**
 * Structural native seam `insertText` drives; production passes MacOSNative.
 * The session's injected native backend must satisfy the same surface.
 */
export interface NativeTextBackend {
  resolveApp(identifier: string, options?: NativeRequestOptions): Promise<NativeApplication>;
  beginObservation(
    pids?: number[],
    options?: NativeRequestOptions,
  ): Promise<{ id: string; before?: NativeObservation["before"] }>;
  endObservation(id: string, options?: NativeRequestOptions): Promise<NativeObservation>;
  inspectApp(pid: number, options?: NativeRequestOptions): Promise<NativeAppState>;
  replaceSelectedText(
    request: NativeTextRequest,
    options?: NativeRequestOptions,
  ): Promise<NativeTextResult>;
  stop(): Promise<void>;
}

export type InsertTextInput = {
  app: string;
  text: string;
  allowMutating?: boolean;
  safetyNote?: string;
  expectedTitle?: string;
  expectedUrl?: string;
};
export type InsertTextResult = {
  content: { type: "text"; text: string }[];
  isError: boolean;
  details: {
    macuse: {
      tool: "insert_text";
      app: string;
      dispatched: boolean;
      outcome: "not_dispatched" | "unknown" | "verified";
      target?: NativeApplication;
      insertedUTF16Length?: number;
      replacedUTF16Length?: number;
      focus?:
        | (NativeObservation & { observationAvailable: true })
        | { observationAvailable: false; observationError: string; inputAttribution: false };
    };
  };
};
export function insertText(
  native: NativeTextBackend,
  input: InsertTextInput,
  observation: AppObservation | undefined,
  options: { signal?: AbortSignal; refreshObservation: () => Promise<AppObservation | undefined> },
): Promise<InsertTextResult>;
