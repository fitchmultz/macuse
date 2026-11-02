import { nativeTextUnavailableReason } from "../tools/macos-native.mjs";
import { findSameElement, sameDocument } from "./app-state.mjs";

/** @typedef {import("./native-input.mjs").NativeTextBackend} NativeTextBackend */
/** @typedef {import("../tools/macos-native.mjs").NativeApplication} NativeApplication */
/** @typedef {import("../tools/macos-native.mjs").NativeWindow} NativeWindow */
/** @typedef {NonNullable<import("../tools/macos-native.mjs").NativeAppState["focusedElement"]>} NativeFocusElement */
/** @typedef {import("./app-state.mjs").AppObservation} AppObservation */
/** @typedef {import("./app-state.mjs").AppElement} AppElement */

/** An observation with a validated focused field. */
/** @typedef {AppObservation & { focused: AppElement }} FocusedObservation */

/** A verified native selected-text replacement. */
/** @typedef {{ status: "applied", mutationAttempted: true, verified: true, insertedUTF16Length: number, replacedUTF16Length: number }} AppliedTextResult */

/** Evidence collected while preparing an insertion. */
/** @typedef {{ target?: NativeApplication, observationId?: string, focusError?: string }} InsertEvidence */

/**
 * Unvalidated macuse_insert_text tool input; every field is checked in this
 * function before use.
 * @typedef {{ app?: unknown, allowMutating?: unknown, safetyNote?: unknown, text?: unknown, expectedTitle?: unknown, expectedUrl?: unknown }} InsertTextInput
 */

/**
 * @typedef {{ tool: string, app: unknown, dispatched: boolean, outcome: string, target?: NativeApplication, focus?: Record<string, unknown>, insertedUTF16Length?: number, replacedUTF16Length?: number }} InsertTextDetails
 */

/**
 * @param {string | null | undefined} value
 * @returns {boolean}
 */
const missing = (value) => value === null || value === undefined || value === "";

/**
 * @param {string | null | undefined} value
 * @returns {value is string}
 */
const present = (value) => value !== null && value !== undefined && value !== "";

/**
 * @param {InsertTextInput} input
 * @returns {void}
 */
function requireMutationFlags(input) {
  if (
    input.allowMutating !== true ||
    typeof input.safetyNote !== "string" ||
    input.safetyNote.trim().length === 0
  ) {
    throw new Error(
      "insert_text requires allowMutating:true and a nonempty safetyNote naming the target, intended effect and stop boundary. These flags do not supply user permission.",
    );
  }
}

/**
 * Validate guest input; returns the narrowed input, app identifier and text.
 * @param {InsertTextInput | null | undefined} input
 * @returns {{ input: InsertTextInput, app: string, text: string }}
 */
function requireInsertInput(input) {
  if (typeof input?.app !== "string" || input.app.trim().length === 0) {
    throw new Error("An exact running app name, bundle ID or path is required.");
  }
  requireMutationFlags(input);
  if (typeof input.text !== "string" || !input.text.isWellFormed()) {
    throw new Error("Text must be a well-formed Unicode string (no lone surrogates).");
  }
  /** @type {("expectedTitle" | "expectedUrl")[]} */
  const guardedKeys = ["expectedTitle", "expectedUrl"];
  for (const key of guardedKeys) {
    if (input[key] !== undefined && typeof input[key] !== "string") {
      throw new Error(`${key} must be an exact string.`);
    }
  }
  return { input, app: input.app, text: input.text };
}

/**
 * @param {AppObservation | undefined} observation
 * @returns {observation is AppObservation}
 */
function hasObservedDocument(observation) {
  return (
    observation !== undefined &&
    typeof observation.app === "string" &&
    Number.isFinite(observation.observedAt)
  );
}

/**
 * @param {AppObservation} observation
 * @returns {observation is FocusedObservation}
 */
function hasFocusedField(observation) {
  return (
    observation.focused !== undefined &&
    typeof observation.focused.role === "string" &&
    typeof observation.focused.index === "string"
  );
}

/**
 * CUA's display name can fall back to the ID or role; those are not AX labels.
 * @param {AppElement} focused
 * @returns {string | null | undefined}
 */
function focusedDisplayName(focused) {
  return focused.name !== focused.id && focused.name !== focused.role ? focused.name : undefined;
}

/**
 * @param {AppElement} focused
 * @param {string | null | undefined} name
 * @param {AppObservation} observation
 * @returns {void}
 */
function requireFocusedIdentity(focused, name, observation) {
  if ((missing(focused.id) && missing(name)) || !findSameElement(focused, observation)) {
    throw new Error(
      "The observed focused field has no unique cross-source identity. Inspect an identifiable field; no edit was dispatched.",
    );
  }
}

/**
 * Resolve the target app and the focused field's cross-source identity.
 * @param {NativeTextBackend} native
 * @param {string} appName
 * @param {FocusedObservation} observation
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<{ app: NativeApplication, focused: AppElement, name: string | null | undefined }>}
 */
async function resolveInsertionTarget(native, appName, observation, signal) {
  const app = await native.resolveApp(appName, { signal });
  if (![appName, app.bundleId, app.path, app.name].includes(observation.app)) {
    throw new Error(
      "The previous observation belongs to another app. Observe the exact intended app before inserting text.",
    );
  }
  const focused = observation.focused;
  const name = focusedDisplayName(focused);
  requireFocusedIdentity(focused, name, observation);
  return { app, focused, name };
}

/**
 * Start a native focus observation without failing the insertion.
 * @param {NativeTextBackend} native
 * @param {NativeApplication} app
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<{ observationId?: string, focusError?: string }>}
 */
async function beginObservationQuietly(native, app, signal) {
  try {
    const observationId = (await native.beginObservation([app.pid], { signal })).id;
    return { observationId };
  } catch (error) {
    return {
      focusError: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * @param {AppElement} target
 * @param {AppElement} focused
 * @param {AppObservation} fresh
 * @returns {boolean}
 */
function targetMatches(target, focused, fresh) {
  return (
    target.cellValueContext === focused.cellValueContext &&
    target.descendants === focused.descendants &&
    target.index === fresh.focused?.index &&
    target.name === focused.name &&
    target.value === focused.value &&
    !target.disabled
  );
}

/**
 * Refresh and verify the document and the focused target element.
 * @param {FocusedObservation} observation
 * @param {AppElement} focused
 * @param {() => Promise<AppObservation | null | undefined>} refreshObservation
 * @returns {Promise<{ fresh: AppObservation }>}
 */
async function refreshedInsertionDocument(observation, focused, refreshObservation) {
  const fresh = await refreshObservation();
  if (!fresh || !sameDocument(observation, fresh)) {
    throw new Error(
      "The app document changed since the last observation. Observe the intended document again.",
    );
  }
  const target = findSameElement(focused, fresh);
  if (!target || !targetMatches(target, focused, fresh)) {
    throw new Error(
      "Focused field changed or is unavailable. Observe and verify the intended field before inserting text.",
    );
  }
  if (!observation.nativeWindowIdentity || !fresh.nativeWindowIdentity) {
    throw new Error(
      "The observed document has no native window identity for selected-text insertion. Use setValue only for an intended full-field replacement.",
    );
  }
  return { fresh };
}

/**
 * Require the inspected native state to match the resolved app.
 * @param {import("../tools/macos-native.mjs").NativeAppState} state
 * @param {NativeApplication} app
 * @returns {void}
 */
function requireSameApp(state, app) {
  if (
    state.pid !== app.pid ||
    !state.app ||
    state.app.bundleId !== app.bundleId ||
    state.app.path !== app.path
  ) {
    throw new Error("The running app identity changed before insertion.");
  }
}

/**
 * @param {NativeWindow} window
 * @param {InsertTextInput} input
 * @returns {void}
 */
function requireWindowGuards(window, input) {
  if (input.expectedTitle !== undefined && window.title !== input.expectedTitle) {
    throw new Error("Window guard failed: expectedTitle does not match the focused window.");
  }
  if (input.expectedUrl !== undefined && window.document !== input.expectedUrl) {
    throw new Error("Document guard failed: expectedUrl does not match the focused document.");
  }
}

/**
 * @param {AppObservation} fresh
 * @param {NativeWindow} window
 * @returns {boolean}
 */
function sameNativeDocument(fresh, window) {
  return fresh.url !== null && fresh.url !== ""
    ? fresh.url === window.document
    : fresh.title !== null && fresh.title === window.title;
}

/**
 * Require an insertable focused window and element, honoring input guards.
 * @param {import("../tools/macos-native.mjs").NativeAppState} state
 * @param {NativeApplication} app
 * @param {InsertTextInput} input
 * @param {AppObservation} fresh
 * @returns {{ window: NativeWindow, field: NativeFocusElement }}
 */
function requireGuardedWindow(state, app, input, fresh) {
  const field = state.focusedElement;
  if (
    !state.accessibilityTrusted ||
    !state.focusedWindow ||
    field === null ||
    !field.selectedTextSettable
  ) {
    throw new Error(nativeTextUnavailableReason(state));
  }
  requireSameApp(state, app);
  const window = state.focusedWindow;
  requireWindowGuards(window, input);
  if (!sameNativeDocument(fresh, window)) {
    throw new Error(
      "The focused window/document changed since the last observation. Observe the intended document again.",
    );
  }
  return { window, field };
}

/**
 * Require the native focused field to match the observed focused element.
 * @param {AppElement} focused
 * @param {string | null | undefined} name
 * @param {NativeFocusElement} field
 * @returns {void}
 */
function requireMatchingField(focused, name, field) {
  const role = field.roleDescription?.toLowerCase().replace(/^search text field$/, "search");
  if (
    (focused.id !== undefined && focused.id !== field.identifier) ||
    ![field.role, role].includes(focused.role) ||
    (present(name) && ![field.title, field.description].includes(name)) ||
    (focused.value !== undefined && focused.value !== field.value)
  ) {
    throw new Error(
      "The focused field or its value changed since the last observation. Observe the intended field again.",
    );
  }
}

/**
 * Run the whole preflight: validated input, resolved target, refreshed
 * document, and a guarded native field. Reports evidence as it is collected
 * so failures keep partial evidence.
 * @param {NativeTextBackend} native
 * @param {{ input: InsertTextInput | null | undefined, observation: AppObservation | undefined, refreshObservation?: (() => Promise<AppObservation | null | undefined>) | undefined, signal: AbortSignal | undefined, onEvidence: (evidence: InsertEvidence) => void }} context
 * @returns {Promise<{ app: NativeApplication, window: NativeWindow, field: NativeFocusElement, text: string }>}
 */
async function prepareInsertion(native, context) {
  const { observation, refreshObservation, signal, onEvidence } = context;
  const { input, app: appName, text } = requireInsertInput(context.input);
  if (!hasObservedDocument(observation)) {
    throw new Error("Observe the intended app and document before inserting text.");
  }
  if (!hasFocusedField(observation)) {
    throw new Error(
      "The previous observation did not identify a focused field. Get a fresh full getAXState before inserting text; use setValue only for intended full-field replacement.",
    );
  }
  signal?.throwIfAborted();
  const { app, focused, name } = await resolveInsertionTarget(native, appName, observation, signal);
  onEvidence({ target: app });
  const started = await beginObservationQuietly(native, app, signal);
  if (started.observationId !== undefined) {
    onEvidence({ observationId: started.observationId });
  }
  if (started.focusError !== undefined) {
    onEvidence({ focusError: started.focusError });
  }
  signal?.throwIfAborted();
  if (typeof refreshObservation !== "function") {
    throw new Error("insertText requires a refreshObservation callback.");
  }
  const { fresh } = await refreshedInsertionDocument(observation, focused, refreshObservation);
  signal?.throwIfAborted();
  const state = await native.inspectApp(app.pid, { signal });
  const { window, field } = requireGuardedWindow(state, app, input, fresh);
  requireMatchingField(focused, name, field);
  signal?.throwIfAborted();
  return { app, window, field, text };
}

/**
 * Dispatch the selected-text replacement, report dispatch evidence, then
 * require a verified readback.
 * @param {NativeTextBackend} native
 * @param {{ app: NativeApplication, window: NativeWindow, field: NativeFocusElement, text: string, signal: AbortSignal | undefined }} context
 * @param {(edit: import("../tools/macos-native.mjs").NativeTextResult) => void} onDispatched
 * @returns {Promise<AppliedTextResult>}
 */
async function performEdit(native, context, onDispatched) {
  const { app, window, field, text, signal } = context;
  const edit = await native.replaceSelectedText(
    {
      pid: app.pid,
      text,
      expected: {
        windowToken: window.token,
        windowTitle: window.title,
        document: window.document,
        elementToken: field.token,
        value: field.value,
      },
    },
    { signal },
  );
  onDispatched(edit);
  if (edit.status !== "applied") {
    throw new Error(edit.reason);
  }
  return edit;
}

/**
 * Settle a failed insertion: reset dispatch evidence and stop on uncertainty.
 * @param {NativeTextBackend} native
 * @param {unknown} error
 * @param {boolean} requestPending
 * @param {boolean} dispatched
 * @returns {Promise<{ message: string, notDispatched: boolean, clearObservationId: boolean, focus?: Record<string, unknown> }>}
 */
async function insertFailure(native, error, requestPending, dispatched) {
  const notDispatched =
    typeof error === "object" &&
    error !== null &&
    "dispatched" in error &&
    error.dispatched === false;
  /** @type {{ message: string, notDispatched: boolean, clearObservationId: boolean, focus?: Record<string, unknown> }} */
  const failure = { notDispatched, clearObservationId: false, message: "" };
  if (requestPending) {
    await native.stop();
    failure.clearObservationId = true;
    failure.focus = {
      observationAvailable: false,
      observationError:
        "Native helper settled after an uncertain edit; focus observation is unavailable.",
      inputAttribution: false,
    };
  }
  failure.message = `${dispatched ? "An edit was dispatched, but its outcome is unknown. Do not replay; inspect the intended field." : "No edit was dispatched."} ${
    error instanceof Error ? error.message : String(error)
  }`;
  return failure;
}

/**
 * @param {NativeTextBackend} native
 * @param {string} observationId
 * @returns {Promise<Record<string, unknown>>}
 */
async function settleObservation(native, observationId) {
  try {
    return {
      observationAvailable: true,
      ...(await native.endObservation(observationId)),
    };
  } catch (error) {
    return {
      observationAvailable: false,
      observationError: error instanceof Error ? error.message : String(error),
      inputAttribution: false,
    };
  }
}

// The parent serializes this entire preflight/edit/readback with its other GUI operations.
/**
 * @param {NativeTextBackend} native
 * @param {InsertTextInput | null | undefined} input
 * @param {AppObservation | undefined} observation
 * @param {{ signal?: AbortSignal, refreshObservation?: () => Promise<AppObservation | null | undefined> }} [options]
 */
export async function insertText(native, input, observation, { signal, refreshObservation } = {}) {
  /** @type {InsertTextDetails} */
  const details = {
    tool: "insert_text",
    app: input?.app,
    dispatched: false,
    outcome: "not_dispatched",
  };
  /** @type {string | undefined} */
  let observationId;
  let requestPending = false;
  let message;
  /** @param {InsertEvidence} evidence */
  const applyEvidence = (evidence) => {
    if (evidence.target !== undefined) {
      details.target = evidence.target;
    }
    if (evidence.observationId !== undefined) {
      observationId = evidence.observationId;
    }
    if (evidence.focusError !== undefined) {
      details.focus = {
        observationAvailable: false,
        observationError: evidence.focusError,
        inputAttribution: false,
      };
    }
  };
  try {
    const prepared = await prepareInsertion(native, {
      input,
      observation,
      refreshObservation,
      signal,
      onEvidence: applyEvidence,
    });
    details.dispatched = true;
    details.outcome = "unknown";
    requestPending = true;
    const edit = await performEdit(native, { ...prepared, signal }, (result) => {
      requestPending = false;
      Object.assign(details, {
        dispatched: result.mutationAttempted,
        outcome: result.mutationAttempted ? "unknown" : "not_dispatched",
      });
    });
    Object.assign(details, {
      outcome: "verified",
      insertedUTF16Length: edit.insertedUTF16Length,
      replacedUTF16Length: edit.replacedUTF16Length,
    });
    message =
      "Selected text replaced and verified on the edited field. No keyboard events or clipboard writes were used.";
  } catch (error) {
    const failure = await insertFailure(native, error, requestPending, details.dispatched);
    Object.assign(
      details,
      failure.notDispatched ? { dispatched: false, outcome: "not_dispatched" } : {},
      failure.focus !== undefined ? { focus: failure.focus } : {},
    );
    if (failure.clearObservationId) {
      observationId = undefined;
    }
    message = failure.message;
  } finally {
    if (observationId !== undefined) {
      details.focus = await settleObservation(native, observationId);
    }
  }
  return {
    content: [{ type: "text", text: message }],
    isError: details.outcome !== "verified",
    details: { macuse: details },
  };
}
