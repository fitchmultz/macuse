import {
  parseAppState,
  sameDocument,
  findSameElement,
  findUniqueElement,
  findContextElement,
} from "./app-state.mjs";

/** @typedef {import("./cua-guard-service.mjs").SkyRequest} SkyRequest */
/** @typedef {import("./cua-guard-service.mjs").GuardAction} GuardAction */
/** @typedef {import("./cua-guard-service.mjs").RunRecord} RunRecord */
/** @typedef {import("./cua-guard-service.mjs").FocusAnchor} FocusAnchor */
/** @typedef {import("./cua-guard-service.mjs").GuardDispatch} GuardDispatch */
/** @typedef {import("./cua-guard-service.mjs").GuardDiagnostic} GuardDiagnostic */
/** @typedef {import("./cua-guard-service.mjs").MacuseRunMeta} MacuseRunMeta */
/** @typedef {import("./app-state.mjs").AppObservation} AppObservation */
/** @typedef {import("./app-state.mjs").AppElement} AppElement */

export const GUI_METHODS = [
  "click",
  "drag",
  "paste",
  "perform_secondary_action",
  "press_key",
  "scroll",
  "select_text",
  "set_value",
  "type_text",
];
const methods = new Set(["list_apps", "get_app_state", ...GUI_METHODS]);
/** @type {Record<string, readonly string[]>} */
const operationKeys = {
  get_app_state: ["app", "disableDiff"],
  click: ["app", "element_index", "x", "y", "mouse_button", "click_count", "key", "duration"],
  drag: ["app", "from_x", "from_y", "to_x", "to_y"],
  paste: ["app", "text", "format"],
  perform_secondary_action: ["app", "element_index", "action"],
  press_key: ["app", "key", "duration"],
  scroll: ["app", "direction", "pages", "element_index", "x", "y"],
  select_text: ["app", "element_index", "text", "prefix", "suffix", "selection_type"],
  set_value: ["app", "element_index", "value"],
  type_text: ["app", "text"],
};
/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
/**
 * @param {unknown} value
 * @returns {value is string}
 */
const nonempty = (value) => typeof value === "string" && value.trim().length > 0;
/**
 * A declared function (not an arrow const) so tsgo treats calls to it as
 * never-returning and narrows after guard checks.
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
  throw new Error(message);
}

/**
 * @param {string} key
 * @returns {string | undefined}
 */
function appWideCommandKey(key) {
  const keys = key
    .toLowerCase()
    .split("+")
    .map((part) => part.trim());
  const command = /^(?:super|meta)(?:_[lr])?$|^(?:cmd|command)$/;
  const modifiers = keys.slice(0, -1);
  // Save, Close, New, Open, Print, Quit, Hide and Minimize, including Shift/Option variants.
  if (
    modifiers.some((part) => command.test(part)) &&
    modifiers.every(
      (part) => command.test(part) || /^(?:shift|alt)(?:_[lr])?$|^option$/.test(part),
    ) &&
    ["s", "w", "n", "o", "p", "q", "h", "m"].includes(keys.at(-1) ?? "")
  )
    return keys.at(-1);
  return;
}

/**
 * Validate a macuse tool envelope in place. Throws on any invalid field.
 * @param {unknown} input
 * @returns {asserts input is import("./cua-guard-service.mjs").MacuseEnvelope}
 */
export function validateEnvelope(input) {
  if (!isRecord(input)) fail("macuse requires an input object.");
  if (input.apps !== undefined && (!Array.isArray(input.apps) || !input.apps.every(nonempty)))
    fail("apps must contain exact nonempty app identifiers used by the script.");
  if (input.allowMutating !== undefined && typeof input.allowMutating !== "boolean")
    fail("allowMutating must be a boolean.");
  if (input.safetyNote !== undefined && typeof input.safetyNote !== "string")
    fail("safetyNote must be a string.");
  if (
    input.allowMutating === true &&
    (input.apps === undefined ||
      !Array.isArray(input.apps) ||
      input.apps.length === 0 ||
      !nonempty(input.safetyNote))
  ) {
    fail(
      "Mutations require nonempty apps, allowMutating:true and a concrete nonempty safetyNote. Match apps exactly to the identifiers used in code.",
    );
  }
}

/**
 * @param {SkyRequest} request
 * @returns {(Record<string, unknown> & { app: string }) | undefined}
 */
function operation(request) {
  if (request.type !== "execute" || request.method === undefined || !methods.has(request.method))
    fail(`Unsupported Computer Use request: ${request.method ?? request.type}.`);
  const { method, args } = request;
  if (args === undefined || !Array.isArray(args)) fail("Sky arguments must be an array.");
  if (method === "list_apps") {
    if (args.length > 0) fail("list_apps takes no arguments.");
    return;
  }
  if (args.length !== 1 || !isRecord(args[0])) fail(`${method} requires one argument object.`);
  const input = { ...args[0] };
  for (const key of Object.keys(input))
    if (!(operationKeys[method]?.includes(key) ?? false))
      fail(`Unsupported ${method} argument: ${key}.`);
  if (!nonempty(input.app)) fail("A nonempty app identifier is required.");
  if (
    input.element_index !== undefined &&
    (!Number.isSafeInteger(input.element_index) || Number(input.element_index) < 0)
  )
    fail("element_index must be a nonnegative integer.");
  /**
   * @param {string} key
   * @param {boolean} [required]
   * @returns {string | undefined}
   */
  const string = (key, required = true) => {
    const value = input[key];
    if ((required || value !== undefined) && (typeof value !== "string" || !value.isWellFormed()))
      fail(`${key} must be a well-formed Unicode string.`);
    return typeof value === "string" ? value : undefined;
  };
  /**
   * @param {string} key
   * @returns {void}
   */
  const finite = (key) => {
    if (!Number.isFinite(input[key])) fail(`${key} must be a finite number.`);
  };
  if (
    ["set_value", "select_text", "perform_secondary_action"].includes(method) &&
    input.element_index === undefined
  )
    fail(`${method} requires element_index.`);
  if (["click", "scroll"].includes(method)) {
    if (input.element_index === undefined) {
      finite("x");
      finite("y");
    } else if (input.x !== undefined || input.y !== undefined)
      fail("Choose an element index or coordinates, not both.");
  }
  switch (method) {
    case "get_app_state":
      if (input.disableDiff !== undefined && typeof input.disableDiff !== "boolean")
        fail("disableDiff must be a boolean.");
      break;
    case "click":
      if (
        input.click_count !== undefined &&
        (!Number.isSafeInteger(input.click_count) || Number(input.click_count) < 1)
      )
        fail("click_count must be a positive integer.");
      if (
        input.mouse_button !== undefined &&
        !["left", "right", "middle", "l", "r", "m", 0, 1, 2].some(
          (allowed) => allowed === input.mouse_button,
        )
      )
        fail("Invalid mouse_button.");
      string("key", false);
      if (input.duration !== undefined) finite("duration");
      break;
    case "drag":
      for (const key of ["from_x", "from_y", "to_x", "to_y"]) finite(key);
      break;
    case "scroll":
      if (!["up", "down", "left", "right", "u", "d", "l", "r"].some((d) => d === input.direction))
        fail("Invalid scroll direction.");
      if (input.pages !== undefined && (!Number.isFinite(input.pages) || Number(input.pages) <= 0))
        fail("pages must be a finite positive number.");
      break;
    case "press_key":
      if (!nonempty(input.key)) fail("key must be nonempty.");
      if (input.duration !== undefined) finite("duration");
      break;
    case "perform_secondary_action":
      if (!nonempty(input.action)) fail("action must be nonempty.");
      break;
    case "set_value":
      string("value");
      break;
    case "paste":
      string("text");
      if (!["text", "md", "html"].some((format) => format === input.format))
        fail("paste format must be text, md or html.");
      break;
    case "type_text": {
      const text = string("text");
      if (text !== undefined && /[^\x00-\x7f]/.test(text))
        fail(
          "Native typeText corrupts non-ASCII text. Use paste, the host selected-text insertion tool, or setValue for an intended full-field replacement.",
        );
      break;
    }
    case "select_text":
      string("text");
      string("prefix", false);
      string("suffix", false);
      if (
        input.selection_type !== undefined &&
        !["text", "cursor_before", "cursor_after"].some((kind) => kind === input.selection_type)
      )
        fail("Invalid selection_type.");
      break;
  }
  return { ...input, app: input.app };
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
  /**
   * @returns {RunRecord}
   */
  const activeRun = () => run ?? fail("macuse run state is missing.");
  const publish = () => {
    const active = context();
    if (!active) fail("macuse run context is missing.");
    active.setResponseMeta({
      macuse: {
        runId: activeRun().runId,
        actions: activeRun().actions,
        observations: [...observations.values()],
        resolvedApps: Object.fromEntries(resolvedApps),
        mutationBlocked: activeRun().mutationBlocked,
      },
    });
  };
  /**
   * @param {GuardAction} action
   * @returns {void}
   */
  const record = (action) => {
    publish();
    diagnostic({ runId: activeRun().runId, ...action });
  };
  /**
   * @param {string} app
   * @returns {Promise<{ result: Record<string, unknown>, observation: AppObservation }>}
   */
  const snapshot = async (app) => {
    const result = await dispatch({
      type: "execute",
      method: "get_app_state",
      args: [{ app, disableDiff: true }],
    });
    if (
      !isRecord(result) ||
      typeof result.text !== "string" ||
      /^(?:The following is a diff|There has been no change)/m.test(result.text)
    )
      fail("Native service did not return a full app snapshot.");
    // CUA binds subsequent calls to the native app path returned by getApp.
    if (nonempty(result.app)) resolvedApps.set(app, result.app);
    const observation = parseAppState(canonical(app), result.text);
    observations.set(observation.app, observation);
    publish();
    return { result, observation };
  };
  /**
   * @param {SkyRequest} request
   * @returns {Promise<unknown>}
   */
  return function handleRpc(request) {
    // Capture trusted caller metadata before joining the queue. Guest arguments never supply gates.
    const meta = context()?.requestMeta?.macuse;
    const task = tail.then(async () => {
      if (!context()?.setResponseMeta || !meta || !nonempty(meta.runId))
        fail("Missing trusted macuse run metadata.");
      const runId = meta.runId;
      validateEnvelope(meta);
      if (run?.runId !== runId) {
        if (run?.mutationBlocked === true) {
          publicObservations.clear();
          focusAnchor = undefined;
        }
        if (meta.invalidatedApps !== undefined && meta.invalidatedApps.length > 0)
          focusAnchor = undefined;
        for (const app of meta.invalidatedApps ?? []) {
          observations.delete(canonical(app));
          publicObservations.delete(canonical(app));
        }
        run = { runId, actions: [], mutationBlocked: false };
      }
      publish();
      if (request.type === "setup") {
        const result = await dispatch(request);
        if (!isRecord(result) || result.target !== "mac" || !Array.isArray(result.methods))
          fail("macuse requires the native macOS Sky service.");
        const listed = /** @type {unknown[]} */ (result.methods);
        return {
          ...result,
          methods: listed.filter((method) => typeof method === "string" && methods.has(method)),
        };
      }
      /** @type {GuardAction | undefined} */
      let action;
      try {
        const firstArgument = request.args?.[0];
        if (request.method !== undefined && GUI_METHODS.includes(request.method)) {
          action = {
            id: activeRun().actions.length + 1,
            method: request.method,
            app: isRecord(firstArgument) ? firstArgument.app : undefined,
            dispatched: false,
            outcome: "not_dispatched",
            verification: "none",
          };
          activeRun().actions.push(action);
        }
        const input = operation(request);
        // list_apps returns no validated input.
        if (input === undefined) return await dispatch(request);
        if (request.method === "get_app_state") {
          focusAnchor = undefined;
          const { result, observation } = await snapshot(input.app);
          publicObservations.set(observation.app, observation);
          return result;
        }
        // Only GUI methods reach the mutation path; their action record exists by construction.
        if (!action) fail("GUI action record is missing.");
        if (activeRun().mutationBlocked)
          fail(
            "A previous dispatched action has an uncertain outcome. Inspect current state; do not replay or continue mutations in this run.",
          );
        if (
          meta.allowMutating !== true ||
          meta.apps?.some((app) => canonical(app) === canonical(input.app)) !== true
        )
          fail(
            "Mutation app is outside this run's exact apps scope or allowMutating is false. Match apps to the identifiers used in code.",
          );
        const before = publicObservations.get(canonical(input.app));
        if (!before) fail("Observe this exact app with getApp/getAXState before mutating it.");
        const priorFocus = focusAnchor?.app === canonical(input.app) ? focusAnchor : undefined;
        focusAnchor = undefined;
        const { observation: fresh } = await snapshot(input.app);
        if (!sameDocument(before, fresh))
          fail(
            "The app document changed since the last public observation. Inspect a fresh state before acting.",
          );
        /** @type {AppElement | undefined} */
        let target;
        if (input.element_index !== undefined) {
          const original = before.elements.find(
            (element) => element.index === String(input.element_index),
          );
          target =
            original && findSameElement(original, before) && findSameElement(original, fresh);
          // Check cell values before dispatch; setValue can legitimately change its parent cell on readback.
          if (
            !target ||
            !original ||
            target.cellValueContext !== original.cellValueContext ||
            target.descendants !== original.descendants ||
            target.disabled ||
            target.name !== original.name ||
            target.value !== original.value
          )
            fail(
              "Target identity or value changed since the last public observation. Inspect a fresh state before acting.",
            );
          input.element_index = Number(target.index);
          action.target = {
            index: target.index,
            id: target.id,
            role: target.role,
            name: target.name,
          };
        }
        /**
         * The guest key argument for the methods that can carry one.
         * @returns {string | undefined}
         */
        const requestedKey = () => {
          if (request.method !== "press_key" && request.method !== "click") return;
          const key = input.key;
          if (nonempty(key)) return key;
          return;
        };
        const key = requestedKey();
        const commandKey = key !== undefined ? appWideCommandKey(key) : undefined;
        // Clicks can hold modifier keys without producing a keyboard edit.
        const modifiersOnly =
          request.method === "click" &&
          key
            ?.split("+")
            .every((part) =>
              /^(?:shift|control|ctrl|alt|option|super|meta)(?:_[lr])?$|^(?:cmd|command)$/i.test(
                part.trim(),
              ),
            );
        // Tab and modified keys can edit text; only bare dismissal/direction keys may lack focus.
        const navigationKey =
          key !== undefined && /^(Escape|Left|Right|Up|Down)$/i.test(key.trim());
        if (
          request.method === "type_text" ||
          request.method === "paste" ||
          (key !== undefined &&
            commandKey === undefined &&
            modifiersOnly !== true &&
            (before.focused !== undefined || !navigationKey))
        ) {
          /**
           * @param {AppObservation} source
           * @param {AppElement | undefined} expected
           * @returns {boolean}
           */
          const matchesFocus = (source, expected) => {
            if (!expected || !sameDocument(source, fresh) || !findSameElement(expected, source))
              return false;
            const focusedWindow =
              source.title !== fresh.title &&
              source.focusedWindow === true &&
              fresh.focusedWindow === true &&
              fresh.focused !== undefined &&
              expected.index === source.focused?.index &&
              expected.id === fresh.focused.id &&
              expected.url === fresh.focused.url;
            const focused =
              findSameElement(expected, fresh) ??
              (focusedWindow ? fresh.focused : undefined) ??
              (priorFocus &&
                priorFocus.returnToAncestor !== true &&
                findUniqueElement(expected, source) &&
                findUniqueElement(expected, fresh));
            const focusedElement = focused === undefined || focused === false ? undefined : focused;
            if (focusedElement === undefined) return false;
            return (
              focusedElement.cellValueContext === expected.cellValueContext &&
              focusedElement.descendants === expected.descendants &&
              focusedElement.index === fresh.focused?.index &&
              focusedElement.value === expected.value &&
              !focusedElement.disabled
            );
          };
          const observedBefore = before;
          const returnedToAncestor = () => {
            if (
              request.method !== "press_key" ||
              priorFocus?.returnToAncestor !== true ||
              !sameDocument(priorFocus.observation, fresh) ||
              !fresh.focused
            )
              return false;
            const focused = fresh.focused;
            const ancestor = findContextElement(focused, priorFocus.observation);
            if (
              !ancestor ||
              !findSameElement(focused, fresh) ||
              focused.disabled ||
              focused.value !== ancestor.value ||
              focused.cellValueContext !== ancestor.cellValueContext
            )
              return false;
            const elements = new Map(
              priorFocus.observation.elements.map((element) => [element.index, element]),
            );
            for (
              let index = priorFocus.element.parentIndex;
              index !== undefined;
              index = elements.get(index)?.parentIndex
            ) {
              if (index === ancestor.index) return true;
            }
            return false;
          };
          if (
            !(
              priorFocus &&
              priorFocus.returnToAncestor !== true &&
              matchesFocus(priorFocus.observation, priorFocus.element)
            ) &&
            !matchesFocus(observedBefore, observedBefore.focused) &&
            !returnedToAncestor()
          )
            fail(
              "Focused field changed or is unavailable. Observe and verify the intended field before keyboard input.",
            );
        }
        if (request.method === "set_value" && target?.settable !== true)
          fail(
            "The resolved field is not settable. Use host selected-text insertion if supported.",
          );
        if (
          request.method === "perform_secondary_action" &&
          input.action !== "Press" &&
          !(
            target !== undefined &&
            target.secondaryActions.some((listed) => listed === input.action)
          )
        )
          fail("The requested secondary action is not listed on the resolved element.");
        action.before = {
          title: fresh.title,
          url: fresh.url,
          nativeWindowIdentity: fresh.nativeWindowIdentity,
        };
        if (
          commandKey === "w" ||
          (target?.role === "close button" &&
            ((request.method === "click" &&
              [undefined, "left", "l", 0].some((button) => button === input.mouse_button)) ||
              (request.method === "perform_secondary_action" && input.action === "Press")))
        )
          action.closesWindow = true;
        action.dispatched = true;
        action.outcome = "unknown";
        record(action);
        const result = await dispatch({ ...request, args: [input] });
        // Reads can launch an app or reopen its window. Only setValue needs automatic readback;
        // other primitives report native completion and leave effect assertions to the caller.
        if (request.method === "set_value") {
          if (target === undefined) fail("set_value requires a resolved element target.");
          const { observation: after } = await snapshot(input.app);
          const field =
            findContextElement(target, after) ??
            findSameElement(target, after) ??
            (findUniqueElement(target, fresh) && findUniqueElement(target, after));
          if (!sameDocument(fresh, after) || !field || field.value !== input.value)
            fail(
              "setValue readback did not match the exact resolved field value. The edit may have occurred; inspect current state and do not replay.",
            );
          if (field.index === after.focused?.index)
            focusAnchor = { app: canonical(input.app), observation: after, element: field };
          action.verification = "exact-field-value";
        } else {
          if (request.method === "click" && target?.settable === true)
            focusAnchor = { app: canonical(input.app), observation: fresh, element: target };
          else if (
            target &&
            (request.method === "click" ||
              (request.method === "perform_secondary_action" && input.action === "Press"))
          ) {
            focusAnchor = {
              app: canonical(input.app),
              observation: fresh,
              element: target,
              returnToAncestor: true,
            };
          }
          action.verification = "native-returned";
        }
        action.outcome = "completed";
        record(action);
        return result;
      } catch (error) {
        if (action) {
          action.error = error instanceof Error ? error.message : String(error);
          if (action.dispatched) activeRun().mutationBlocked = true;
          record(action);
        }
        throw error;
      } finally {
        publish();
      }
    });
    // Serialize the entire preflight/action/readback, including public reads.
    tail = task.then(
      () => {
        /* Queue continuation is intentional. */
        return null;
      },
      () => {
        /* Queue errors are delivered by the task itself. */
        return null;
      },
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
  if (!(serviceUrl !== undefined && serviceUrl.startsWith("file:")))
    fail("Missing host-resolved Sky service module URL.");
  const load = /** @type {Promise<unknown>} */ (import(serviceUrl));
  const created = load.then((/** @type {unknown} */ module) => {
    if (!isSkyService(module)) throw new Error("Sky service module does not export handleRpc.");
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
