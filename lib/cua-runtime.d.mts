import type { AppObservation } from "./app-state.mjs";
export type CuaContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
export interface CuaInput {
  code: string;
  apps?: string[];
  allowMutating?: boolean;
  allowPointer?: boolean;
  safetyNote?: string;
  timeoutMs?: number;
}
export interface CuaAction {
  id: number;
  method: string;
  app: string;
  dispatched: boolean;
  outcome: "not_dispatched" | "unknown" | "completed";
  verification: "none" | "native-returned" | "exact-field-value";
  target?: { index: string; id?: string; role: string; name: string };
  before?: { title: string | null; url: string | null };
  closesWindow?: boolean;
  error?: string;
}
export interface CuaResult {
  content: CuaContent[];
  isError: boolean;
  details: { macuse: {
    runId: string;
    status: "completed" | "failed" | "unknown" | "running";
    actions: CuaAction[];
    observations: AppObservation[];
    kernelReset: boolean;
    interruption?: string;
    provisionalActions?: unknown[];
    images: Array<{ index: number; mimeType?: string; width?: number; height?: number; coordinateSpace: "native-screenshot"; scale: string }>;
  } };
}
export interface CuaStatus { connected: boolean; running: boolean; resetting: boolean; runId?: string; kernelResets: number }
export class CuaRuntime {
  constructor(options?: { cwd?: string; resourcesPath?: string; connect?: (options: unknown, onDiagnostic: (event: any) => void) => Promise<any> });
  execute(input: CuaInput, options?: { signal?: AbortSignal; onUpdate?: (update: { content: CuaContent[]; isError: boolean; details: { macuse: Partial<CuaResult["details"]["macuse"]> } }) => void }): Promise<CuaResult>;
  getObservation(app: string): AppObservation | undefined;
  invalidateObservation(app: string): void;
  reset(): Promise<CuaStatus>;
  stop(): Promise<void>;
  status(): CuaStatus;
}
export function resolveLaunch(options?: { cwd?: string; resourcesPath?: string }): Promise<{ command: string; args: string[]; cwd: string; env: Record<string, string> }>;
export function imageMetadata(data: string): { mimeType?: string; width?: number; height?: number };
export function appApproval(request: any): { action: "accept" | "decline"; content?: Record<string, never> };
