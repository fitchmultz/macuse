import { parseAppState, sameDocument } from "./app-state.mjs";
import {
  closesWindow,
  fail,
  focusRequirements,
  guardAction,
  guardTargetAction,
  isRecord,
  mutationGate,
  nonempty,
  operation,
  postDispatchAnchor,
  resolveTarget,
  setValueVerification,
  supportedMethods,
  verifyFocusedField,
} from "./cua-guard-steps.mjs";

export { GUI_METHODS } from "./cua-guard-steps.mjs";

/** @typedef {import("./cua-guard-service.mjs").SkyRequest} SkyRequest */
/** @typedef {import("./cua-guard-service.mjs").GuardAction} GuardAction */
/** @typedef {import("./cua-guard-service.mjs").RunRecord} RunRecord */
/** @typedef {import("./cua-guard-service.mjs").FocusAnchor} FocusAnchor */
/** @typedef {import("./cua-guard-service.mjs").GuardDispatch} GuardDispatch */
/** @typedef {import("./cua-guard-service.mjs").GuardDiagnostic} GuardDiagnostic */
/** @typedef {import("./cua-guard-service.mjs").MacuseRunMeta} MacuseRunMeta */
/** @typedef {import("./cua-guard-service.mjs").MacuseEnvelope} MacuseEnvelope */
/** @typedef {import("./app-state.mjs").AppObservation} AppObservation */
/** @typedef {import("./app-state.mjs").AppElement} AppElement */

/** @typedef {{ action: GuardAction, input: Record<string, unknown> & { app: string }, target: AppElement | undefined, fresh: AppObservation, app: string }} MutationContext */

/**
 * Validate a macuse tool envelope in place. Throws on any invalid field.
 * @param {unknown} input
 * @returns {asserts input is import("./cua-guard-service.mjs").MacuseEnvelope}
 */
export function validateEnvelope(input) {
  if (!isRecord(input)) {
    fail("macuse requires an input object.");
  }
  validateEnvelopeFields(input);
  if (input.allowMutating === true) {
    assertMutationComplete(input);
  }
}

/**
 * @param {Record<string, unknown>} input
 * @returns {void}
 */
function validateEnvelopeFields(input) {
  if (input.apps !== undefined && (!Array.isArray(input.apps) || !input.apps.every(nonempty))) {
    fail("apps must contain exact nonempty app identifiers used by the script.");
  }
  if (input.allowMutating !== undefined && typeof input.allowMutating !== "boolean") {
    fail("allowMutating must be a boolean.");
  }
  if (input.safetyNote !== undefined && typeof input.safetyNote !== "string") {
    fail("safetyNote must be a string.");
  }
}

/**
 * @param {Record<string, unknown>} input
 * @returns {void}
 */
function assertMutationComplete(input) {
  if (
    input.apps === undefined ||
    !Array.isArray(input.apps) ||
    input.apps.length === 0 ||
    !nonempty(input.safetyNote)
  ) {
    fail(
      "Mutations require nonempty apps, allowMutating:true and a concrete nonempty safetyNote. Match apps exactly to the identifiers used in code.",
    );
  }
}

/**
 * Focus anchor to keep when a run switches or invalidates apps.
 * @param {FocusAnchor | undefined} focusAnchor
 * @param {RunRecord | undefined} run
 * @param {MacuseEnvelope} meta
 * @returns {FocusAnchor | undefined}
 */
function keptFocusAnchor(focusAnchor, run, meta) {
  if (run?.mutationBlocked === true) {
    return;
  }
  if (meta.invalidatedApps !== undefined && meta.invalidatedApps.length > 0) {
    return;
  }
  return focusAnchor;
}

/**
 * Start or continue a run for the trusted metadata, clearing stale state.
 * @param {MacuseEnvelope} meta
 * @param {GuardState} guard
 * @returns {{ run: RunRecord, focusAnchor: FocusAnchor | undefined }}
 */
function beginRun(meta, guard) {
  const runId = meta.runId;
  if (typeof runId !== "string" || runId.trim().length === 0) {
    fail("Missing trusted macuse run metadata.");
  }
  const run = guard.getRun();
  if (run === undefined || run.runId !== runId) {
    if (run?.mutationBlocked === true) {
      guard.publicObservations.clear();
    }
    for (const app of meta.invalidatedApps ?? []) {
      guard.observations.delete(guard.canonical(app));
      guard.publicObservations.delete(guard.canonical(app));
    }
    return {
      run: { runId, actions: [], mutationBlocked: false },
      focusAnchor: keptFocusAnchor(guard.getFocusAnchor(), run, meta),
    };
  }
  return { run, focusAnchor: guard.getFocusAnchor() };
}

/**
 * Validate and filter the native setup response.
 * @param {unknown} result
 * @returns {Record<string, unknown>}
 */
function setupResponse(result) {
  if (!isRecord(result) || result.target !== "mac" || !Array.isArray(result.methods)) {
    fail("macuse requires the native macOS Sky service.");
  }
  const listed = /** @type {unknown[]} */ (result.methods);
  return {
    ...result,
    methods: listed.filter((method) => typeof method === "string" && supportedMethods.has(method)),
  };
}

/**
 * @typedef {object} GuardState
 * @property {GuardDispatch} dispatch
 * @property {() => import("./cua-guard-service.mjs").NodeReplContext | undefined} context
 * @property {(event: GuardDiagnostic) => void} diagnostic
 * @property {Map<string, AppObservation>} observations
 * @property {Map<string, AppObservation>} publicObservations
 * @property {Map<string, string>} resolvedApps
 * @property {(app: string) => string} canonical
 * @property {() => RunRecord} activeRun
 * @property {() => RunRecord | undefined} getRun
 * @property {(value: RunRecord) => void} setRun
 * @property {() => FocusAnchor | undefined} getFocusAnchor
 * @property {(value: FocusAnchor | undefined) => void} setFocusAnchor
 * @property {() => Promise<null | void>} getTail
 * @property {(value: Promise<null | void>) => void} setTail
 * @property {() => void} blockRun
 * @property {() => void} publish
 * @property {(action: GuardAction) => void} record
 * @property {(app: string) => Promise<{ result: Record<string, unknown>, observation: AppObservation }>} snapshot
 */

/**
 * Publish the current run evidence to the host response metadata.
 * @param {GuardState} guard
 * @returns {void}
 */
function publishMeta(guard) {
  const active = guard.context();
  if (!active) {
    fail("macuse run context is missing.");
  }
  active.setResponseMeta({
    macuse: {
      runId: guard.activeRun().runId,
      actions: guard.activeRun().actions,
      observations: [...guard.observations.values()],
      resolvedApps: Object.fromEntries(guard.resolvedApps),
      mutationBlocked: guard.activeRun().mutationBlocked,
    },
  });
}

/**
 * @param {GuardState} guard
 * @param {GuardAction} action
 * @returns {void}
 */
function recordAction(guard, action) {
  publishMeta(guard);
  guard.diagnostic({ runId: guard.activeRun().runId, ...action });
}

/**
 * @param {GuardState} guard
 * @param {string} app
 * @returns {Promise<{ result: Record<string, unknown>, observation: AppObservation }>}
 */
async function takeSnapshot(guard, app) {
  const result = await guard.dispatch({
    type: "execute",
    method: "get_app_state",
    args: [{ app, disableDiff: true }],
  });
  if (
    !isRecord(result) ||
    typeof result.text !== "string" ||
    /^(?:The following is a diff|There has been no change)/m.test(result.text)
  ) {
    fail("Native service did not return a full app snapshot.");
  }
  // CUA binds subsequent calls to the native app path returned by getApp.
  if (nonempty(result.app)) {
    guard.resolvedApps.set(app, result.app);
  }
  const observation = parseAppState(guard.canonical(app), result.text);
  guard.observations.set(observation.app, observation);
  publishMeta(guard);
  return { result, observation };
}

/**
 * Serve a public get_app_state read.
 * @param {GuardState} guard
 * @param {Record<string, unknown> & { app: string }} input
 * @returns {Promise<Record<string, unknown>>}
 */
async function publicRead(guard, input) {
  guard.setFocusAnchor(undefined);
  const { result, observation } = await guard.snapshot(input.app);
  guard.publicObservations.set(observation.app, observation);
  return result;
}

/**
 * Run the full guarded mutation path for one GUI request.
 * @param {GuardState} guard
 * @param {SkyRequest} request
 * @param {MacuseEnvelope} meta
 * @param {{ action: GuardAction, input: Record<string, unknown> & { app: string } }} held
 * @returns {Promise<unknown>}
 */
async function runMutation(guard, request, meta, held) {
  const { action, input } = held;
  mutationGate(meta, input, action, { run: guard.activeRun(), resolvedApps: guard.resolvedApps });
  const before = guard.publicObservations.get(guard.canonical(input.app));
  if (!before) {
    fail("Observe this exact app with getApp/getAXState before mutating it.");
  }
  const priorFocus =
    guard.getFocusAnchor()?.app === guard.canonical(input.app) ? guard.getFocusAnchor() : undefined;
  guard.setFocusAnchor(undefined);
  const { observation: fresh } = await guard.snapshot(input.app);
  if (!sameDocument(before, fresh)) {
    fail(
      "The app document changed since the last public observation. Inspect a fresh state before acting.",
    );
  }
  const resolved = resolveTarget(before, fresh, input);
  if (resolved !== undefined) {
    input.element_index = resolved.index;
    action.target = {
      index: resolved.target.index,
      id: resolved.target.id,
      role: resolved.target.role,
      name: resolved.target.name,
    };
  }
  const target = resolved?.target;
  const { needsFocus, commandKey } = focusRequirements(request, input, before);
  if (needsFocus) {
    verifyFocusedField(request, before, fresh, priorFocus);
  }
  guardTargetAction(request, input, target);
  action.before = {
    title: fresh.title,
    url: fresh.url,
    nativeWindowIdentity: fresh.nativeWindowIdentity,
  };
  if (closesWindow(request, input, target, commandKey)) {
    action.closesWindow = true;
  }
  action.dispatched = true;
  action.outcome = "unknown";
  recordAction(guard, action);
  const result = await guard.dispatch({ ...request, args: [input] });
  const app = guard.canonical(input.app);
  await settleMutation(guard, request, { action, input, target, fresh, app });
  action.outcome = "completed";
  recordAction(guard, action);
  return result;
}

/**
 * Read back setValue or keep a focus anchor after other mutations.
 * @param {GuardState} guard
 * @param {SkyRequest} request
 * @param {MutationContext} context
 * @returns {Promise<void>}
 */
async function settleMutation(guard, request, context) {
  const { action, input, target, fresh, app } = context;
  if (request.method === "set_value") {
    const { observation: after } = await guard.snapshot(input.app);
    const field = setValueVerification(input, target, fresh, after);
    if (field.index === after.focused?.index) {
      guard.setFocusAnchor({ app, observation: after, element: field });
    }
    action.verification = "exact-field-value";
    return;
  }
  guard.setFocusAnchor(postDispatchAnchor(request, input, { fresh, target, app }));
  action.verification = "native-returned";
}

/**
 * Serve one execute request: public reads, list_apps, or a mutation.
 * @param {GuardState} guard
 * @param {SkyRequest} request
 * @param {MacuseEnvelope} meta
 * @returns {Promise<unknown>}
 */
async function runOperation(guard, request, meta) {
  /** @type {GuardAction | undefined} */
  let action;
  try {
    action = guardAction(request, guard.activeRun().actions);
    const input = operation(request);
    // list_apps returns no validated input.
    if (input === undefined) {
      return await guard.dispatch(request);
    }
    if (request.method === "get_app_state") {
      return await publicRead(guard, input);
    }
    if (action === undefined) {
      fail("GUI action record is missing.");
    }
    return await runMutation(guard, request, meta, { action, input });
  } catch (error) {
    if (action) {
      action.error = error instanceof Error ? error.message : String(error);
      if (action.dispatched) {
        guard.blockRun();
      }
      recordAction(guard, action);
    }
    throw error;
  } finally {
    publishMeta(guard);
  }
}

/**
 * @param {GuardState} guard
 * @param {SkyRequest} request
 * @param {MacuseRunMeta | undefined} meta
 * @returns {Promise<unknown>}
 */
async function runTask(guard, request, meta) {
  // Guest arguments never supply gates; require trusted caller metadata.
  if (!guard.context()?.setResponseMeta || !meta || !nonempty(meta.runId)) {
    fail("Missing trusted macuse run metadata.");
  }
  validateEnvelope(meta);
  const next = beginRun(meta, guard);
  guard.setRun(next.run);
  guard.setFocusAnchor(next.focusAnchor);
  publishMeta(guard);
  if (request.type === "setup") {
    return setupResponse(await guard.dispatch(request));
  }
  return runOperation(guard, request, meta);
}

/**
 * @param {object} options
 * @param {GuardDispatch} options.dispatch
 * @param {() => import("./cua-guard-service.mjs").NodeReplContext | undefined} [options.context]
 * @param {(event: GuardDiagnostic) => void} [options.diagnostic]
 * @returns {(request: SkyRequest) => Promise<unknown>}
 */
export function createGuard({
  dispatch,
  context = () => globalThis.nodeRepl,
  diagnostic = () => {
    /* Diagnostics are optional evidence for the host. */
  },
}) {
  /** @type {Map<string, AppObservation>} */
  const observations = new Map();
  /** @type {Map<string, AppObservation>} */
  const publicObservations = new Map();
  /** @type {Map<string, string>} */
  const resolvedApps = new Map();
  /**
   * @param {string} app
   * @returns {string}
   */
  const canonical = (app) => resolvedApps.get(app) ?? app;
  /** @type {RunRecord | undefined} */
  let run;
  /** @type {FocusAnchor | undefined} */
  let focusAnchor;
  /** @type {Promise<null | void>} */
  let tail = Promise.resolve();
  /** @type {GuardState} */
  const guard = {
    dispatch,
    context,
    diagnostic,
    observations,
    publicObservations,
    resolvedApps,
    canonical,
    activeRun: () => run ?? fail("macuse run state is missing."),
    getRun: () => run,
    setRun: (value) => {
      run = value;
    },
    getFocusAnchor: () => focusAnchor,
    setFocusAnchor: (value) => {
      focusAnchor = value;
    },
    getTail: () => tail,
    setTail: (value) => {
      tail = value;
    },
    blockRun: () => {
      guard.activeRun().mutationBlocked = true;
    },
    publish: () => publishMeta(guard),
    record: (action) => recordAction(guard, action),
    snapshot: (app) => takeSnapshot(guard, app),
  };
  return function dispatchRpc(request) {
    // Capture trusted caller metadata before joining the queue.
    const meta = guard.context()?.requestMeta?.macuse;
    const task = guard.getTail().then(() => runTask(guard, request, meta));
    // Serialize the entire preflight/action/readback, including public reads.
    guard.setTail(
      task.then(
        () => {
          /* Queue continuation is intentional. */
          return null;
        },
        () => {
          /* Queue errors are delivered by the task itself. */
          return null;
        },
      ),
    );
    return task;
  };
}

/**
 * The vendor Sky service module loaded from the host-resolved file URL.
 * @typedef {object} SkyServiceModule
 * @property {(request: unknown) => Promise<unknown>} handleRpc
 */

/**
 * @param {unknown} module
 * @returns {module is SkyServiceModule}
 */
const isSkyService = (module) =>
  typeof module === "object" &&
  module !== null &&
  "handleRpc" in module &&
  typeof module.handleRpc === "function";

/** @type {Promise<(request: SkyRequest) => Promise<unknown>> | undefined} */
let guard;

/**
 * Load the vendor Sky service module once and memoize the guard.
 * @returns {Promise<(request: SkyRequest) => Promise<unknown>>}
 */
function loadGuard() {
  const serviceUrl = process.env.MACUSE_SKY_SERVICE_URL;
  if (!(serviceUrl !== undefined && serviceUrl.startsWith("file:"))) {
    fail("Missing host-resolved Sky service module URL.");
  }
  const load = /** @type {Promise<unknown>} */ (import(serviceUrl));
  const created = load.then((/** @type {unknown} */ module) => {
    if (!isSkyService(module)) {
      throw new Error("Sky service module does not export handleRpc.");
    }
    return createGuard({
      dispatch: module.handleRpc,
      diagnostic: (event) => process.stderr.write(`MACUSE_CUA_EVENT ${JSON.stringify(event)}\n`),
    });
  });
  guard = created;
  return created;
}

/**
 * @param {SkyRequest} request
 * @returns {Promise<unknown>}
 */
export async function handleRpc(request) {
  const handler = await (guard ?? loadGuard());
  return handler(request);
}
