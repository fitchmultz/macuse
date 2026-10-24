import type { IndependentProofSession } from './independent-proof-session.mjs';
export const independentProofTools: Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
}>;
export function independentProofFailure(error: unknown, options?: { notDispatched?: boolean }): Awaited<ReturnType<IndependentProofSession['execute']>>;
export function callIndependentProof(session: IndependentProofSession, name: string, input: unknown, options?: { signal?: AbortSignal }): ReturnType<IndependentProofSession['execute']>;
