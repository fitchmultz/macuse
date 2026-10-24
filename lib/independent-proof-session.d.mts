export interface ProofTarget {
  readonly bundleId: string;
  readonly pid: number;
  /** Exact canonical path returned by the operator-owned fixture launcher. */
  readonly path: string;
  readonly windowTitle?: string;
}
export interface ProofInput {
  readonly code: string;
  readonly apps?: readonly string[];
  readonly allowMutating?: boolean;
  readonly safetyNote?: string;
  readonly timeoutMs?: number;
}
export interface ProofResult {
  content: Array<{ type: "text"; text: string } | { type: "image"; mimeType: "image/png"; data: string }>;
  isError: boolean;
  details: { independent: { isError: boolean; [key: string]: unknown } };
}
export interface ProofSettlement {
  workerStopped: boolean;
  nativeStopped: boolean;
  hostCallsPending: number;
  settled: boolean;
  priorUnknown: boolean;
}
/** No native access without an explicit target or operator environment configuration. */
export class IndependentProofSession {
  constructor(options?: { readonly target?: ProofTarget });
  execute(input: ProofInput, options?: { signal?: AbortSignal }): Promise<ProofResult>;
  reset(): Promise<ProofResult>;
  stop(): Promise<ProofSettlement>;
}
