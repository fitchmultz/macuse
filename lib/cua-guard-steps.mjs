import {
  sameDocument,
  findSameElement,
  findUniqueElement,
  findContextElement,
} from "./app-state.mjs";

/** @typedef {import("./cua-guard-service.mjs").SkyRequest} SkyRequest */
/** @typedef {import("./cua-guard-service.mjs").GuardAction} GuardAction */
/** @typedef {import("./cua-guard-service.mjs").MacuseEnvelope} MacuseEnvelope */
/** @typedef {import("./cua-guard-service.mjs").RunRecord} RunRecord */
/** @typedef {import("./cua-guard-service.mjs").FocusAnchor} FocusAnchor */
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
export const supportedMethods = new Set(["list_apps", "get_app_state", ...GUI_METHODS]);
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
export const isRecord = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);
/**
 * @param {unknown} value
 * @returns {value is string}
 */
export const nonempty = (value) => typeof value === "string" && value.trim().length > 0;
/**
 * A declared function (not an arrow const) so tsgo treats calls to it as
 * never-returning and narrows after guard checks.
 * @param {string} message
 * @returns {never}
 */
export function fail(message) {
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
  ) {
    return keys.at(-1);
  }
  return;
}

/**
 * @param {SkyRequest} request
 * @returns {{ method: string, args: unknown[] }}
 */
function requestShape(request) {
  if (
    request.type !== "execute" ||
    request.method === undefined ||
    !supportedMethods.has(request.method)
  ) {
    fail(`Unsupported Computer Use request: ${request.method ?? request.type}.`);
  }
  const { method, args } = request;
  if (args === undefined || !Array.isArray(args)) {
    fail("Sky arguments must be an array.");
  }
  return { method, args };
}

/**
 * @param {string} method
 * @param {unknown[]} args
 * @returns {Record<string, unknown>}
 */
function argObject(method, args) {
  if (args.length !== 1 || !isRecord(args[0])) {
    fail(`${method} requires one argument object.`);
  }
  const input = { ...args[0] };
  for (const key of Object.keys(input)) {
    if (!(operationKeys[method]?.includes(key) ?? false)) {
      fail(`Unsupported ${method} argument: ${key}.`);
    }
  }
  return input;
}

/**
 * @param {string} method
 * @param {Record<string, unknown>} input
 * @returns {string}
 */
function baseInputChecks(method, input) {
  if (!nonempty(input.app)) {
    fail("A nonempty app identifier is required.");
  }
  if (
    input.element_index !== undefined &&
    (!Number.isSafeInteger(input.element_index) || Number(input.element_index) < 0)
  ) {
    fail("element_index must be a nonnegative integer.");
  }
  if (
    ["set_value", "select_text", "perform_secondary_action"].includes(method) &&
    input.element_index === undefined
  ) {
    fail(`${method} requires element_index.`);
  }
  return input.app;
}

/**
 * @param {Record<string, unknown>} input
 * @returns {void}
 */
function coordinateChoice(input) {
  if (input.element_index === undefined) {
    finiteNumber(input, "x");
    finiteNumber(input, "y");
  } else if (input.x !== undefined || input.y !== undefined) {
    fail("Choose an element index or coordinates, not both.");
  }
}

/**
 * @param {Record<string, unknown>} input
 * @param {string} key
 * @returns {void}
 */
function finiteNumber(input, key) {
  if (!Number.isFinite(input[key])) {
    fail(`${key} must be a finite number.`);
  }
}

/**
 * @param {Record<string, unknown>} input
 * @param {string} key
 * @param {boolean} [required]
 * @returns {string | undefined}
 */
function wellFormedString(input, key, required = true) {
  const value = input[key];
  if ((required || value !== undefined) && (typeof value !== "string" || !value.isWellFormed())) {
    fail(`${key} must be a well-formed Unicode string.`);
  }
  return typeof value === "string" ? value : undefined;
}

/**
 * @param {Record<string, unknown>} input
 * @returns {void}
 */
function validateGetAppState(input) {
  if (input.disableDiff !== undefined && typeof input.disableDiff !== "boolean") {
    fail("disableDiff must be a boolean.");
  }
}

/**
 * @param {Record<string, unknown>} input
 * @returns {void}
 */
function validateClick(input) {
  coordinateChoice(input);
  if (
    input.click_count !== undefined &&
    (!Number.isSafeInteger(input.click_count) || Number(input.click_count) < 1)
  ) {
    fail("click_count must be a positive integer.");
  }
  if (
    input.mouse_button !== undefined &&
    !["left", "right", "middle", "l", "r", "m", 0, 1, 2].some(
      (allowed) => allowed === input.mouse_button,
    )
  ) {
    fail("Invalid mouse_button.");
  }
  wellFormedString(input, "key", false);
  if (input.duration !== undefined) {
    finiteNumber(input, "duration");
  }
}

/**
 * @param {Record<string, unknown>} input
 * @returns {void}
 */
function validateDrag(input) {
  for (const key of ["from_x", "from_y", "to_x", "to_y"]) {
    finiteNumber(input, key);
  }
}

/**
 * @param {Record<string, unknown>} input
 * @returns {void}
 */
function validateScroll(input) {
  coordinateChoice(input);
  if (!["up", "down", "left", "right", "u", "d", "l", "r"].some((d) => d === input.direction)) {
    fail("Invalid scroll direction.");
  }
  if (input.pages !== undefined && (!Number.isFinite(input.pages) || Number(input.pages) <= 0)) {
    fail("pages must be a finite positive number.");
  }
}

/**
 * @param {Record<string, unknown>} input
 * @returns {void}
 */
function validatePressKey(input) {
  if (!nonempty(input.key)) {
    fail("key must be nonempty.");
  }
  if (input.duration !== undefined) {
    finiteNumber(input, "duration");
  }
}

/**
 * @param {Record<string, unknown>} input
 * @returns {void}
 */
function validateSecondaryAction(input) {
  if (!nonempty(input.action)) {
    fail("action must be nonempty.");
  }
}

/**
 * @param {Record<string, unknown>} input
 * @returns {void}
 */
function validateSetValue(input) {
  wellFormedString(input, "value");
}

/**
 * @param {Record<string, unknown>} input
 * @returns {void}
 */
function validatePaste(input) {
  wellFormedString(input, "text");
  if (!["text", "md", "html"].some((format) => format === input.format)) {
    fail("paste format must be text, md or html.");
  }
}

/**
 * @param {Record<string, unknown>} input
 * @returns {void}
 */
function validateTypeText(input) {
  const text = wellFormedString(input, "text");
  if (text !== undefined && /[^\x00-\x7f]/.test(text)) {
    fail(
      "Native typeText corrupts non-ASCII text. Use paste, or setValue for an intended full-field replacement.",
    );
  }
}

/**
 * @param {Record<string, unknown>} input
 * @returns {void}
 */
function validateSelectText(input) {
  wellFormedString(input, "text");
  wellFormedString(input, "prefix", false);
  wellFormedString(input, "suffix", false);
  if (
    input.selection_type !== undefined &&
    !["text", "cursor_before", "cursor_after"].some((kind) => kind === input.selection_type)
  ) {
    fail("Invalid selection_type.");
  }
}

/** @type {Record<string, (input: Record<string, unknown>) => void>} */
const inputValidators = {
  get_app_state: validateGetAppState,
  click: validateClick,
  drag: validateDrag,
  scroll: validateScroll,
  press_key: validatePressKey,
  perform_secondary_action: validateSecondaryAction,
  set_value: validateSetValue,
  paste: validatePaste,
  type_text: validateTypeText,
  select_text: validateSelectText,
};

/**
 * @param {SkyRequest} request
 * @returns {(Record<string, unknown> & { app: string }) | undefined}
 */
export function operation(request) {
  const { method, args } = requestShape(request);
  if (method === "list_apps") {
    if (args.length > 0) {
      fail("list_apps takes no arguments.");
    }
    return;
  }
  const input = argObject(method, args);
  const app = baseInputChecks(method, input);
  const validate = inputValidators[method];
  if (validate === undefined) {
    fail(`Unsupported Computer Use method: ${method}.`);
  }
  validate(input);
  return { ...input, app };
}

/**
 * Create the initial action record for GUI requests.
 * @param {SkyRequest} request
 * @param {GuardAction[]} actions
 * @returns {GuardAction | undefined}
 */
export function guardAction(request, actions) {
  const firstArgument = request.args?.[0];
  if (request.method === undefined || !GUI_METHODS.includes(request.method)) {
    return;
  }
  /** @type {GuardAction} */
  const action = {
    id: actions.length + 1,
    method: request.method,
    app: isRecord(firstArgument) ? firstArgument.app : undefined,
    dispatched: false,
    outcome: "not_dispatched",
    verification: "none",
  };
  actions.push(action);
  return action;
}

/**
 * Gate a mutation: a live action record, no blocked run, and exact scope.
 * @param {MacuseEnvelope} meta
 * @param {Record<string, unknown> & { app: string }} input
 * @param {GuardAction | undefined} action
 * @param {{ run: RunRecord, resolvedApps: Map<string, string> }} scope
 * @returns {GuardAction}
 */
export function mutationGate(meta, input, action, scope) {
  if (action === undefined) {
    fail("GUI action record is missing.");
  }
  if (scope.run.mutationBlocked) {
    fail(
      "A previous dispatched action has an uncertain outcome. Inspect current state; do not replay or continue mutations in this run.",
    );
  }
  const inputApp = scope.resolvedApps.get(input.app) ?? input.app;
  if (
    meta.allowMutating !== true ||
    meta.apps?.some((app) => (scope.resolvedApps.get(app) ?? app) === inputApp) !== true
  ) {
    fail(
      "Mutation app is outside this run's exact apps scope or allowMutating is false. Match apps to the identifiers used in code.",
    );
  }
  return action;
}

/**
 * Resolve and verify an element_index target against before/fresh states.
 * Returns the target and its canonical numeric index for the caller to apply.
 * @param {AppObservation} before
 * @param {AppObservation} fresh
 * @param {Record<string, unknown>} input
 * @returns {{ target: AppElement, index: number } | undefined}
 */
export function resolveTarget(before, fresh, input) {
  if (input.element_index === undefined) {
    return;
  }
  const original = before.elements.find((element) => element.index === String(input.element_index));
  /** @type {AppElement | undefined} */
  const target = original && findSameElement(original, before) && findSameElement(original, fresh);
  // Check cell values before dispatch; setValue can legitimately change its parent cell on readback.
  if (!target || !original || !targetUnchanged(target, original)) {
    fail(
      "Target identity or value changed since the last public observation. Inspect a fresh state before acting.",
    );
  }
  return { target, index: Number(target.index) };
}

/**
 * @param {AppElement} target
 * @param {AppElement} original
 * @returns {boolean}
 */
function targetUnchanged(target, original) {
  return (
    target.cellValueContext === original.cellValueContext &&
    target.descendants === original.descendants &&
    !target.disabled &&
    target.name === original.name &&
    target.value === original.value
  );
}

/**
 * The guest key argument for the methods that can carry one.
 * @param {SkyRequest} request
 * @param {Record<string, unknown>} input
 * @returns {string | undefined}
 */
function requestedKeyFor(request, input) {
  if (request.method !== "press_key" && request.method !== "click") {
    return;
  }
  const key = input.key;
  if (nonempty(key)) {
    return key;
  }
  return;
}

/**
 * @param {{ key: string | undefined, commandKey: string | undefined, modifiersOnly: boolean | undefined, navigationKey: boolean }} focus
 * @param {AppObservation} before
 * @returns {boolean}
 */
function keyboardEditsFocus(focus, before) {
  return (
    focus.key !== undefined &&
    focus.commandKey === undefined &&
    focus.modifiersOnly !== true &&
    (before.focused !== undefined || !focus.navigationKey)
  );
}

/**
 * Decide whether a request requires a verified focused field.
 * @param {SkyRequest} request
 * @param {Record<string, unknown>} input
 * @param {AppObservation} before
 * @returns {{ needsFocus: boolean, commandKey: string | undefined }}
 */
export function focusRequirements(request, input, before) {
  const key = requestedKeyFor(request, input);
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
  const navigationKey = key !== undefined && /^(Escape|Left|Right|Up|Down)$/i.test(key.trim());
  const needsFocus =
    request.method === "type_text" ||
    request.method === "paste" ||
    keyboardEditsFocus({ key, commandKey, modifiersOnly, navigationKey }, before);
  return { needsFocus, commandKey };
}

/**
 * @param {AppElement} expected
 * @param {AppObservation} source
 * @param {AppObservation} fresh
 * @returns {boolean}
 */
function focusedWindowMatch(expected, source, fresh) {
  return (
    source.title !== fresh.title &&
    source.focusedWindow === true &&
    fresh.focusedWindow === true &&
    fresh.focused !== undefined &&
    expected.index === source.focused?.index &&
    expected.id === fresh.focused.id &&
    expected.url === fresh.focused.url
  );
}

/**
 * @param {AppElement} expected
 * @param {AppObservation} fresh
 * @param {FocusAnchor | undefined} priorFocus
 * @param {AppObservation} source
 * @returns {AppElement | undefined}
 */
function focusedCandidate(expected, fresh, priorFocus, source) {
  const focusedWindow = focusedWindowMatch(expected, source, fresh);
  const focused =
    findSameElement(expected, fresh) ??
    (focusedWindow ? fresh.focused : undefined) ??
    (priorFocus &&
      priorFocus.returnToAncestor !== true &&
      findUniqueElement(expected, source) &&
      findUniqueElement(expected, fresh));
  if (focused === undefined || focused === false) {
    return;
  }
  return focused;
}

/**
 * Verify a focus candidate against the expected field identity.
 * @param {AppElement | undefined} expected
 * @param {AppObservation} source
 * @param {AppObservation} fresh
 * @param {FocusAnchor | undefined} priorFocus
 * @returns {boolean}
 */
export function matchesFocus(expected, source, fresh, priorFocus) {
  if (!expected || !sameDocument(source, fresh) || !findSameElement(expected, source)) {
    return false;
  }
  const focusedElement = focusedCandidate(expected, fresh, priorFocus, source);
  if (focusedElement === undefined) {
    return false;
  }
  return (
    focusedElement.cellValueContext === expected.cellValueContext &&
    focusedElement.descendants === expected.descendants &&
    focusedElement.index === fresh.focused?.index &&
    focusedElement.value === expected.value &&
    !focusedElement.disabled
  );
}

/**
 * Walk the prior focus element's ancestor chain for the focused context.
 * @param {FocusAnchor} priorFocus
 * @param {AppElement} ancestor
 * @returns {boolean}
 */
function ancestorChainContains(priorFocus, ancestor) {
  const elements = new Map(
    priorFocus.observation.elements.map((element) => [element.index, element]),
  );
  for (
    let index = priorFocus.element.parentIndex;
    index !== undefined;
    index = elements.get(index)?.parentIndex
  ) {
    if (index === ancestor.index) {
      return true;
    }
  }
  return false;
}

/**
 * Detect a press_key return to the anchored ancestor context.
 * @param {SkyRequest} request
 * @param {FocusAnchor | undefined} priorFocus
 * @param {AppObservation} fresh
 * @returns {boolean}
 */
export function returnedToAncestor(request, priorFocus, fresh) {
  if (
    request.method !== "press_key" ||
    priorFocus?.returnToAncestor !== true ||
    !sameDocument(priorFocus.observation, fresh) ||
    !fresh.focused
  ) {
    return false;
  }
  const focused = fresh.focused;
  const ancestor = findContextElement(focused, priorFocus.observation);
  if (!ancestor || !ancestorHolds(focused, fresh, ancestor)) {
    return false;
  }
  return ancestorChainContains(priorFocus, ancestor);
}

/**
 * @param {AppElement} focused
 * @param {AppObservation} fresh
 * @param {AppElement} ancestor
 * @returns {boolean}
 */
function ancestorHolds(focused, fresh, ancestor) {
  return (
    Boolean(findSameElement(focused, fresh)) &&
    !focused.disabled &&
    focused.value === ancestor.value &&
    focused.cellValueContext === ancestor.cellValueContext
  );
}

/**
 * Require a verified focused field before keyboard input.
 * @param {SkyRequest} request
 * @param {AppObservation} before
 * @param {AppObservation} fresh
 * @param {FocusAnchor | undefined} priorFocus
 * @returns {void}
 */
export function verifyFocusedField(request, before, fresh, priorFocus) {
  const priorHolds =
    priorFocus !== undefined &&
    priorFocus.returnToAncestor !== true &&
    matchesFocus(priorFocus.element, priorFocus.observation, fresh, priorFocus);
  const beforeHolds = matchesFocus(before.focused, before, fresh, priorFocus);
  if (!priorHolds && !beforeHolds && !returnedToAncestor(request, priorFocus, fresh)) {
    fail(
      "Focused field changed or is unavailable. Observe and verify the intended field before keyboard input.",
    );
  }
}

/**
 * Enforce settable fields and listed secondary actions.
 * @param {SkyRequest} request
 * @param {Record<string, unknown>} input
 * @param {AppElement | undefined} target
 * @returns {void}
 */
export function guardTargetAction(request, input, target) {
  if (request.method === "set_value" && target?.settable !== true) {
    fail("The resolved field is not settable. Use paste or typeText at the focused field instead.");
  }
  if (
    request.method === "perform_secondary_action" &&
    input.action !== "Press" &&
    !(target !== undefined && target.secondaryActions.some((listed) => listed === input.action))
  ) {
    fail("The requested secondary action is not listed on the resolved element.");
  }
}

/**
 * @param {SkyRequest} request
 * @param {Record<string, unknown>} input
 * @param {AppElement | undefined} target
 * @param {string | undefined} commandKey
 * @returns {boolean}
 */
export function closesWindow(request, input, target, commandKey) {
  return (
    commandKey === "w" ||
    (target?.role === "close button" &&
      ((request.method === "click" &&
        [undefined, "left", "l", 0].some((button) => button === input.mouse_button)) ||
        (request.method === "perform_secondary_action" && input.action === "Press")))
  );
}

/**
 * Verify the setValue readback against the resolved field.
 * @param {Record<string, unknown> & { app: string }} input
 * @param {AppElement | undefined} target
 * @param {AppObservation} fresh
 * @param {AppObservation} after
 * @returns {AppElement}
 */
export function setValueVerification(input, target, fresh, after) {
  if (target === undefined) {
    fail("set_value requires a resolved element target.");
  }
  const field =
    findContextElement(target, after) ??
    findSameElement(target, after) ??
    (findUniqueElement(target, fresh) && findUniqueElement(target, after));
  if (!sameDocument(fresh, after) || !field || field.value !== input.value) {
    fail(
      "setValue readback did not match the exact resolved field value. The edit may have occurred; inspect current state and do not replay.",
    );
  }
  return field;
}

/**
 * Focus anchor to keep after a dispatched mutation.
 * @param {SkyRequest} request
 * @param {Record<string, unknown>} input
 * @param {{ fresh: AppObservation, target: AppElement | undefined, app: string }} context
 * @returns {FocusAnchor | undefined}
 */
export function postDispatchAnchor(request, input, context) {
  const { fresh, target, app } = context;
  if (request.method === "click" && target?.settable === true) {
    return { app, observation: fresh, element: target };
  }
  if (
    target &&
    (request.method === "click" ||
      (request.method === "perform_secondary_action" && input.action === "Press"))
  ) {
    return {
      app,
      observation: fresh,
      element: target,
      returnToAncestor: true,
    };
  }
  return;
}
