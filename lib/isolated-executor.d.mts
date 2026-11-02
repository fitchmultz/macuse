import type { MacuseEnvelope } from "./cua-guard-service.mjs";

/** The validated tool-input envelope handed to one sandboxed guest run. */
export type ExecutorInput = MacuseEnvelope;

/** Context a host capability receives for one guest call. */
export interface ExecutorCallContext {
  runId: string;
  envelope: ExecutorInput;
  signal: AbortSignal;
}

/** A registered host capability the sandboxed guest may call. */
export interface ExecutorCapability {
  mutating: boolean;
  invoke: (params: unknown, context: ExecutorCallContext) => unknown;
}

/** One recorded guest capability call. `method` and `callId` keep guest values. */
export interface ExecutorAction {
  method: unknown;
  callId: unknown;
  dispatched: boolean;
  outcome: string;
  mutating?: boolean;
  error?: string;
}

/** The settled result of one admitted execution. */
export interface ExecutorResult {
  runId: string;
  isError: boolean;
  error?: string;
  value?: unknown;
  actions: ExecutorAction[];
  outcomeUnknown: boolean;
  interruption?: string;
}

/** Status of the executor and its worker. */
export interface ExecutorStatus {
  running: boolean;
  pid?: number;
  hostCallsPending: number;
  mutationBlocked: boolean;
}

/**
 * Opt-in research primitive only. No production macuse session imports this
 * class; it runs registered capabilities inside a deny-default OS sandbox.
 */
export class IsolatedExecutor {
  constructor(options?: {
    capabilities?: Record<string, ExecutorCapability>;
    memoryLimitMiB?: number;
  });
  execute(
    input: ExecutorInput,
    options?: { signal?: AbortSignal | undefined },
  ): Promise<ExecutorResult>;
  status(): ExecutorStatus;
  stop(): Promise<ExecutorStatus & { workerStopped: boolean; settled: boolean }>;
}
