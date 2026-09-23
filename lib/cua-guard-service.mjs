import { parseAppState, sameDocument, findSameElement } from "./app-state.mjs";

export const GUI_METHODS = ["click", "drag", "perform_secondary_action", "press_key", "scroll", "select_text", "set_value", "type_text"];
const methods = new Set(["list_apps", "get_app_state", ...GUI_METHODS, "paste"]);
const operationKeys = {
  get_app_state: ["app", "disableDiff"],
  click: ["app", "element_index", "x", "y", "mouse_button", "click_count"],
  drag: ["app", "from_x", "from_y", "to_x", "to_y"],
  perform_secondary_action: ["app", "element_index", "action"],
  press_key: ["app", "key"],
  scroll: ["app", "direction", "pages", "element_index", "x", "y"],
  select_text: ["app", "element_index", "text", "prefix", "suffix", "selection_type"],
  set_value: ["app", "element_index", "value"],
  type_text: ["app", "text"],
};
const nonempty = value => typeof value === "string" && value.trim().length > 0;
const fail = message => { throw new Error(message); };

export function validateEnvelope(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("macuse requires an input object.");
  if (input.apps !== undefined && (!Array.isArray(input.apps) || !input.apps.every(nonempty))) fail("apps must contain exact nonempty app identifiers used by the script.");
  for (const key of ["allowMutating", "allowPointer"]) if (input[key] !== undefined && typeof input[key] !== "boolean") fail(`${key} must be a boolean.`);
  if (input.safetyNote !== undefined && typeof input.safetyNote !== "string") fail("safetyNote must be a string.");
  if (input.allowMutating && (!input.apps?.length || !nonempty(input.safetyNote) || input.safetyNote.trim().length < 20)) {
    fail("Mutations require nonempty apps, allowMutating:true and a concrete safetyNote of at least 20 characters. Match apps exactly to the identifiers used in code.");
  }
}

function operation(request) {
  if (request.type !== "execute" || !methods.has(request.method)) fail(`Unsupported Computer Use request: ${request.method ?? request.type}.`);
  const { method, args } = request;
  if (!Array.isArray(args)) fail("Sky arguments must be an array.");
  if (method === "list_apps") {
    if (args.length) fail("list_apps takes no arguments.");
    return undefined;
  }
  if (method === "paste") fail("Clipboard paste is disabled. Use the host selected-text insertion tool, or setValue for an intended full-field replacement.");
  if (args.length !== 1 || !args[0] || typeof args[0] !== "object" || Array.isArray(args[0])) fail(`${method} requires one argument object.`);
  const input = { ...args[0] };
  for (const key of Object.keys(input)) if (!operationKeys[method].includes(key)) fail(`Unsupported ${method} argument: ${key}.`);
  if (!nonempty(input.app)) fail("A nonempty app identifier is required.");
  if (input.element_index !== undefined && (!Number.isSafeInteger(input.element_index) || input.element_index < 0)) fail("element_index must be a nonnegative integer.");
  const string = (key, required = true) => {
    if ((required || input[key] !== undefined) && (typeof input[key] !== "string" || !input[key].isWellFormed())) fail(`${key} must be a well-formed Unicode string.`);
  };
  const finite = key => { if (!Number.isFinite(input[key])) fail(`${key} must be a finite number.`); };
  if (["set_value", "select_text", "perform_secondary_action"].includes(method) && input.element_index === undefined) fail(`${method} requires element_index.`);
  if (["click", "scroll"].includes(method)) {
    if (input.element_index === undefined) { finite("x"); finite("y"); }
    else if (input.x !== undefined || input.y !== undefined) fail("Choose an element index or coordinates, not both.");
  }
  switch (method) {
    case "get_app_state":
      if (input.disableDiff !== undefined && typeof input.disableDiff !== "boolean") fail("disableDiff must be a boolean.");
      break;
    case "click":
      if (input.click_count !== undefined && (!Number.isSafeInteger(input.click_count) || input.click_count < 1)) fail("click_count must be a positive integer.");
      if (input.mouse_button !== undefined && !["left", "right", "middle", "l", "r", "m", 0, 1, 2].includes(input.mouse_button)) fail("Invalid mouse_button.");
      break;
    case "drag": for (const key of ["from_x", "from_y", "to_x", "to_y"]) finite(key); break;
    case "scroll":
      if (!["up", "down", "left", "right", "u", "d", "l", "r"].includes(input.direction)) fail("Invalid scroll direction.");
      if (input.pages !== undefined && (!Number.isFinite(input.pages) || input.pages <= 0)) fail("pages must be a finite positive number.");
      break;
    case "press_key":
      if (!nonempty(input.key)) fail("key must be nonempty.");
      // Paste shortcuts are still clipboard paste, regardless of which primitive carries them.
      {
        const keys = input.key.toLowerCase().split("+").map(key => key.trim());
        if (keys.at(-1) === "v" && keys.some(key => ["super", "cmd", "command", "meta", "ctrl", "control"].includes(key))
          || keys.at(-1) === "insert" && keys.includes("shift")) fail("Clipboard paste is disabled; use host selected-text insertion or intended full-field setValue.");
      }
      break;
    case "perform_secondary_action": if (!nonempty(input.action)) fail("action must be nonempty."); break;
    case "set_value": string("value"); break;
    case "type_text":
      string("text");
      if (/[^\x00-\x7f]/.test(input.text)) fail("Native typeText corrupts non-ASCII text. Use the host selected-text insertion tool, or setValue for an intended full-field replacement.");
      break;
    case "select_text":
      string("text"); string("prefix", false); string("suffix", false);
      if (input.selection_type !== undefined && !["text", "cursor_before", "cursor_after"].includes(input.selection_type)) fail("Invalid selection_type.");
      break;
  }
  return input;
}

export function createGuard({ dispatch, context = () => globalThis.nodeRepl, diagnostic = () => {} }) {
  const observations = new Map();
  const publicObservations = new Map();
  const resolvedApps = new Map();
  const canonical = app => resolvedApps.get(app) ?? app;
  let run;
  let tail = Promise.resolve();
  const publish = () => {
    context().setResponseMeta({ macuse: { runId: run.runId, actions: run.actions, observations: [...observations.values()], resolvedApps: Object.fromEntries(resolvedApps), mutationBlocked: run.mutationBlocked } });
  };
  const record = action => { publish(); diagnostic({ runId: run.runId, ...action }); };
  const snapshot = async app => {
    const result = await dispatch({ type: "execute", method: "get_app_state", args: [{ app, disableDiff: true }] });
    if (typeof result?.text !== "string" || /^(?:The following is a diff|There has been no change)/m.test(result.text)) fail("Native service did not return a full app snapshot.");
    // CUA binds subsequent calls to the native app path returned by getApp.
    if (nonempty(result.app)) resolvedApps.set(app, result.app);
    const observation = parseAppState(canonical(app), result.text);
    observations.set(observation.app, observation);
    publish();
    return { result, observation };
  };
  return function handleRpc(request) {
    // Capture trusted caller metadata before joining the queue. Guest arguments never supply gates.
    const meta = context()?.requestMeta?.macuse;
    const task = tail.then(async () => {
      if (!context()?.setResponseMeta || !meta || !nonempty(meta.runId)) fail("Missing trusted macuse run metadata.");
      validateEnvelope(meta);
      if (run?.runId !== meta.runId) {
        if (run?.mutationBlocked) publicObservations.clear();
        for (const app of meta.invalidatedApps ?? []) { observations.delete(canonical(app)); publicObservations.delete(canonical(app)); }
        run = { runId: meta.runId, actions: [], mutationBlocked: false };
      }
      publish();
      if (request.type === "setup") {
        const result = await dispatch(request);
        if (result.target !== "mac") fail("macuse requires the native macOS Sky service.");
        return { ...result, methods: result.methods.filter(method => methods.has(method)) };
      }
      let action;
      try {
        if (GUI_METHODS.includes(request.method) || request.method === "paste") {
          action = { id: run.actions.length + 1, method: request.method, app: request.args?.[0]?.app, dispatched: false, outcome: "not_dispatched", verification: "none" };
          run.actions.push(action);
        }
        const input = operation(request);
        if (request.method === "list_apps") return await dispatch(request);
        if (request.method === "get_app_state") {
          const { result, observation } = await snapshot(input.app);
          publicObservations.set(observation.app, observation);
          return result;
        }
        if (run.mutationBlocked) fail("A previous dispatched action has an uncertain outcome. Inspect current state; do not replay or continue mutations in this run.");
        if (!meta.allowMutating || !meta.apps?.some(app => canonical(app) === canonical(input.app))) fail("Mutation app is outside this run's exact apps scope or allowMutating is false. Match apps to the identifiers used in code.");
        if ((["click", "drag"].includes(request.method) || request.method === "scroll" && input.element_index === undefined) && !meta.allowPointer) fail("Pointer input requires allowPointer:true. Prefer an accessible secondary action or element-targeted scroll.");
        const before = publicObservations.get(canonical(input.app));
        if (!before) fail("Observe this exact app with getApp/getAXState before mutating it.");
        const { observation: fresh } = await snapshot(input.app);
        if (!sameDocument(before, fresh)) fail("The app document changed since the last public observation. Inspect a fresh state before acting.");
        let target;
        if (input.element_index !== undefined) {
          const original = before.elements.find(element => element.index === String(input.element_index));
          target = original && findSameElement(original, before) && findSameElement(original, fresh);
          if (!target || target.disabled || target.name !== original.name || target.value !== original.value) fail("Target identity or value changed since the last public observation. Inspect a fresh state before acting.");
          input.element_index = Number(target.index);
          action.target = { index: target.index, id: target.id, role: target.role, name: target.name };
        }
        if (request.method === "type_text") {
          const focused = before.focused && findSameElement(before.focused, before) && findSameElement(before.focused, fresh);
          if (!focused || focused.index !== fresh.focused?.index || focused.value !== before.focused.value || focused.disabled) fail("Focused field changed or is unavailable. Observe and verify the intended field before typing.");
        }
        if (request.method === "set_value" && !target.settable) fail("The resolved field is not settable. Use host selected-text insertion if supported.");
        if (request.method === "perform_secondary_action" && input.action !== "Press" && !target.secondaryActions.includes(input.action)) fail("The requested secondary action is not listed on the resolved element.");
        action.before = { title: fresh.title, url: fresh.url };
        if (request.method === "press_key" && /^super\+(?:shift\+)?w$/i.test(input.key)
          || target?.role === "close button" && (request.method === "click" && [undefined, "left", "l", 0].includes(input.mouse_button)
            || request.method === "perform_secondary_action" && input.action === "Press")) action.closesWindow = true;
        action.dispatched = true;
        action.outcome = "unknown";
        record(action);
        const result = await dispatch({ ...request, args: [input] });
        // Reads can launch an app or reopen its window. Only setValue needs automatic readback;
        // other primitives report native completion and leave effect assertions to the caller.
        if (request.method === "set_value") {
          const { observation: after } = await snapshot(input.app);
          const field = findSameElement(target, after);
          if (!sameDocument(fresh, after) || !field || field.value !== input.value) fail("setValue readback did not match the exact resolved field value. The edit may have occurred; inspect current state and do not replay.");
          action.verification = "exact-field-value";
        } else action.verification = "native-returned";
        action.outcome = "completed";
        record(action);
        return result;
      } catch (error) {
        if (action) {
          action.error = error instanceof Error ? error.message : String(error);
          if (action.dispatched) run.mutationBlocked = true;
          record(action);
        }
        throw error;
      } finally { publish(); }
    });
    // Serialize the entire preflight/action/readback, including public reads.
    tail = task.then(() => {}, () => {});
    return task;
  };
}

let guard;
export async function handleRpc(request) {
  if (!guard) {
    const serviceUrl = process.env.MACUSE_SKY_SERVICE_URL;
    if (!serviceUrl?.startsWith("file:")) fail("Missing host-resolved Sky service module URL.");
    guard = import(serviceUrl).then(({ handleRpc: dispatch }) => createGuard({ dispatch, diagnostic: event => process.stderr.write(`MACUSE_CUA_EVENT ${JSON.stringify(event)}\n`) }));
  }
  return (await guard)(request);
}
