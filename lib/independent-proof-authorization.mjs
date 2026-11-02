import { maxImageBytes, maxRunImageBytes } from "./independent-proof-validation.mjs";

/** @typedef {{ generation: number, failed: boolean, captureAttempts: number, imageBytes: number }} ProofRun */
/** @typedef {{ bundleId: string }} Target */
/** @typedef {{ observationId: unknown, elements: Record<string, unknown>[], windows: Record<string, unknown>[] }} Observation */
/** @typedef {{ run: ProofRun | undefined, target: Target | undefined, observed: Observation | undefined, generation: number, mutationBlocked: boolean }} AuthorizationState */
/** @typedef {import("./isolated-executor.mjs").ExecutorCallContext} Context */

/** @type {Record<string, string[]>} */
const fields = {
  observe: ["app"],
  screenshot: ["app", "observationId", "windowToken"],
  act: ["app", "observationId", "elementToken", "action", "value"],
};

/** @param {unknown} value */
function nonempty(value) {
  return typeof value === "string" && value.trim() !== "" && value.isWellFormed();
}

/** @param {Record<string, unknown>} params */
function validAction(params) {
  return (
    typeof params.action === "string" &&
    ["press", "setValue"].includes(params.action) &&
    (params.action !== "setValue" ||
      (typeof params.value === "string" && params.value.isWellFormed())) &&
    (params.action !== "press" || params.value === undefined)
  );
}

/** @param {Record<string, unknown>} params @param {Context} context @param {ProofRun} run @param {AuthorizationState} state */
function authorizeAct(params, context, run, state) {
  const observed = state.observed;
  if (observed === undefined) {
    throw new Error("A fresh same-session native observation is required.");
  }
  if (state.mutationBlocked || run.failed) {
    throw new Error(
      "Proof mutation blocked after a refusal or uncertain effect; inspect/reset before continuing, never replay.",
    );
  }
  if (context.envelope.allowMutating !== true || !nonempty(context.envelope.safetyNote)) {
    throw new Error("Parent mutation authorization is required.");
  }
  if (!validAction(params)) {
    throw new Error("Only observed press or exact full-field setValue is supported.");
  }
  if (!observed.elements.some((element) => element.token === params.elementToken)) {
    throw new Error("Unknown observed element token.");
  }
}

/** @param {Record<string, unknown>} params @param {ProofRun} run @param {Observation | undefined} observed */
function authorizeScreenshot(params, run, observed) {
  if (observed === undefined) {
    throw new Error("A fresh same-session native observation is required.");
  }
  if (!observed.windows.some((window) => window.token === params.windowToken)) {
    throw new Error("Unknown observed window token.");
  }
  // Reserve the full native ceiling before starting another capture.
  if (run.captureAttempts >= 2 || run.imageBytes + maxImageBytes > maxRunImageBytes) {
    throw new Error("Per-run screenshot count/byte budget exhausted.");
  }
}

/** @param {Record<string, unknown>} params @param {Context} context @param {Target} target */
function authorizeScope(params, context, target) {
  const apps = context.envelope.apps;
  if (
    params.app !== target.bundleId ||
    !Array.isArray(apps) ||
    apps.length !== 1 ||
    apps[0] !== target.bundleId
  ) {
    throw new Error("Every native proof operation requires the exact trusted target app scope.");
  }
}

/** @param {string} method @param {Record<string, unknown>} params @param {Observation | undefined} observed */
function authorizeObservation(method, params, observed) {
  if (
    method !== "observe" &&
    (observed === undefined || params.observationId !== observed.observationId)
  ) {
    throw new Error("A fresh same-session native observation is required.");
  }
}

/** @param {string} method @param {Record<string, unknown>} params @param {Context} context @param {AuthorizationState} state */
export function authorizeProof(method, params, context, state) {
  const { run, target, observed } = state;
  if (!run || run.generation !== state.generation || context.signal.aborted) {
    throw new Error("Proof request cancelled before native dispatch.");
  }
  if (!target) {
    throw new Error(
      "Native proof requires operator-configured MACUSE_INDEPENDENT_PROOF_TARGET; guest code cannot select the target.",
    );
  }
  const allowed = fields[method] ?? [];
  if (Object.keys(params).some((key) => !allowed.includes(key))) {
    throw new Error(
      "Unsupported guest fields; authorization and target identity are parent-owned.",
    );
  }
  authorizeScope(params, context, target);
  authorizeObservation(method, params, observed);
  if (method === "act") {
    authorizeAct(params, context, run, state);
  }
  if (method === "screenshot") {
    authorizeScreenshot(params, run, observed);
  }
}

export { fields };
