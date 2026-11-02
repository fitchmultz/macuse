import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { IndependentProofSession } from "../lib/independent-proof-session.mjs";
import { callIndependentProof, independentProofTools } from "../lib/independent-proof-tools.mjs";

// Explicit -e opt-in only; this file is not in the package's pi.extensions manifest.
interface IndependentErrorMarker {
  independent?: { isError?: boolean };
}

const isIndependentErrorMarker = (value: unknown): value is IndependentErrorMarker =>
  typeof value === "object" && value !== null;

export default function independentProof(pi: ExtensionAPI): void {
  let session: IndependentProofSession | undefined;
  let stopping: Promise<void> | undefined;
  const getSession = (): IndependentProofSession => {
    if (stopping) {
      throw new Error("Independent proof is stopping; no execution admitted.");
    }
    if (session === undefined) {
      session = new IndependentProofSession();
    }
    return session;
  };
  const stop = (): Promise<void> => {
    if (stopping === undefined) {
      stopping = Promise.resolve()
        .then(async () => {
          const stopped = await session?.stop();
          if (stopped && (!stopped.settled || !stopped.workerStopped || !stopped.nativeStopped)) {
            throw new Error(
              "Independent proof shutdown is unsettled. Retaining the blocked session; inspect fresh fixture state and never replay actions.",
            );
          }
          session = undefined;
          return;
        })
        .finally(() => {
          stopping = undefined;
        });
    }
    return stopping;
  };
  for (const tool of independentProofTools) {
    pi.registerTool({
      name: tool.name,
      label: tool.name,
      description: tool.description,
      annotations: tool.annotations,
      promptSnippet:
        tool.name === "macuse_independent_proof"
          ? "Qualify an operator-owned native fixture through independent sandboxed JavaScript"
          : "Clear experimental proof bindings without undoing GUI effects",
      parameters: Type.Unsafe<Record<string, unknown>>(tool.inputSchema),
      executionMode: "sequential",
      constrainedSampling: { type: "json_schema", strict: "prefer" },
      promptGuidelines:
        tool.name === "macuse_independent_proof"
          ? [
              'Use macuse_independent_proof only for explicitly requested disposable-fixture qualification. JavaScriptCore scripts and Promise expressions are supported, not top-level await or the vendor cua API. Guest code calls macuse.call("observe"|"screenshot"|"act", params). The operator pins the target outside guest code; no recording, selected-range, focus, or general-app parity is supported. Mutation flags are not user permission. Preserve native unknown/unverified evidence; observe after actions and never replay dispatched calls.',
            ]
          : [
              "macuse_independent_proof_reset clears bindings and observations but cannot undo GUI effects or erase prior unknown evidence.",
            ],
      async execute(_id, params, signal) {
        return callIndependentProof(getSession(), tool.name, params, { signal });
      },
    });
  }
  // Both hosts preserve partial failure evidence while marking the tool result as failed.
  pi.on("tool_result", (event) => {
    let isError: boolean | undefined;
    if (
      event.toolName === "macuse_independent_proof" ||
      event.toolName === "macuse_independent_proof_reset"
    ) {
      if (isIndependentErrorMarker(event.details)) {
        isError = event.details.independent?.isError;
      }
    }
    return isError === true ? { isError: true } : undefined;
  });
  pi.on("session_start", stop);
  pi.on("session_tree", stop);
  pi.on("session_shutdown", stop);
}
