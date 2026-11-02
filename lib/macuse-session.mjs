import { CuaRuntime, imageMetadata } from "./cua-runtime.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { AuxiliaryRuntime } from "./auxiliary-runtime.mjs";
import { insertText } from "./native-input.mjs";
import { MacOSNative, nativeWindowClosed } from "../tools/macos-native.mjs";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { tools } from "./tools.mjs";

/** @typedef {import("./macuse-session.mjs").SessionRuntime} SessionRuntime */
/**
 * @typedef {import("./macuse-session.mjs").SessionNative} SessionNative
 */
/** @typedef {import("./macuse-session.mjs").SessionAuxiliary} SessionAuxiliary */
/** @typedef {import("./macuse-session.mjs").MacuseResult} MacuseResult */
/** @typedef {import("./macuse-session.mjs").SessionResult} SessionResult */
/** @typedef {import("./macuse-session.mjs").SessionAction} SessionAction */
/** @typedef {NonNullable<SessionResult["details"]["macuse"]["observations"]>[number]} ObservedAppSnapshot */

const validator = new AjvJsonSchemaValidator();
const validators = new Map(
  tools.map((tool) => [tool.name, validator.getValidator(tool.inputSchema)]),
);

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
/**
 * @param {unknown} value
 * @returns {value is unknown[]}
 */
const isUnknownArray = (value) => Array.isArray(value);
/**
 * @param {string} tool
 * @param {string} message
 * @returns {MacuseResult}
 */
const failure = (tool, message) => ({
  content: [{ type: "text", text: message }],
  isError: true,
  details: { macuse: { tool, isError: true, dispatched: false, outcome: "not_dispatched" } },
});

/**
 * @param {Record<string, unknown>} clone
 * @returns {import("./native-input.mjs").InsertTextInput}
 */
function buildInsertTextInput(clone) {
  const app = clone.app;
  const text = clone.text;
  if (typeof app !== "string" || typeof text !== "string") {
    throw new Error("macuse_insert_text requires an app and text.");
  }
  return {
    app,
    text,
    ...(typeof clone.allowMutating === "boolean" ? { allowMutating: clone.allowMutating } : {}),
    ...(typeof clone.safetyNote === "string" ? { safetyNote: clone.safetyNote } : {}),
    ...(typeof clone.expectedTitle === "string" ? { expectedTitle: clone.expectedTitle } : {}),
    ...(typeof clone.expectedUrl === "string" ? { expectedUrl: clone.expectedUrl } : {}),
  };
}

/**
 * @param {SessionResult} refresh
 * @returns {{ refresh: Record<string, unknown>, kernelReset: unknown, interruption?: unknown }}
 */
function refreshEvidence(refresh) {
  const interruption = refresh.details.macuse.interruption;
  return {
    refresh: refresh.details.macuse,
    kernelReset: refresh.details.macuse.kernelReset,
    ...(interruption !== undefined && interruption !== null ? { interruption } : {}),
  };
}

/**
 * Collect the saved-image, action-summary, and failure-guidance evidence texts.
 * @param {SessionResult} result
 * @returns {string[]}
 */
function resultEvidenceTexts(result) {
  /** @type {string[]} */
  const texts = [];
  const savedImage = result.details.macuse.savedImage;
  if (savedImage !== undefined && savedImage !== null) {
    texts.push(`Saved screenshot: ${JSON.stringify(savedImage)}`);
  }
  const actions = result.details.macuse.actions;
  if (isUnknownArray(actions) && actions.length > 0) {
    texts.push(
      JSON.stringify({
        status: result.details.macuse.status,
        actionCount: actions.length,
        actions: actions.map((action) => {
          const record = isRecord(action) ? action : undefined;
          return {
            id: record?.id,
            method: record?.method,
            app: record?.app,
            dispatched: record?.dispatched,
            outcome: record?.outcome,
            verification: record?.verification,
          };
        }),
      }),
    );
  }
  if (result.isError) {
    texts.push(
      "Execution failed or has an unverified outcome. Inspect fresh state before continuing; never automatically replay a dispatched or unknown-outcome mutation.",
    );
  }
  return texts;
}

/**
 * Resolve one focus target app, tolerating individual failures.
 * @param {import("./macuse-session.mjs").MacuseSession} session
 * @param {string} app
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<import("../tools/macos-native.mjs").NativeApplication | null>}
 */
const resolveTargetApp = (session, app, signal) =>
  session.native.resolveApp(app, { signal }).catch(() => null);

/**
 * Begin the focus observation for the requested target apps.
 * @param {import("./macuse-session.mjs").MacuseSession} session
 * @param {{ trackFocus?: unknown, apps?: unknown }} input
 * @param {NonNullable<Parameters<CuaRuntime["execute"]>[1]>} options
 * @returns {Promise<{ observation: Awaited<ReturnType<SessionNative["beginObservation"]>> | undefined, focusError: string | undefined }>}
 */
async function beginFocusObservation(session, input, options) {
  if ((input.trackFocus ?? true) !== true) {
    return { observation: undefined, focusError: undefined };
  }
  try {
    const targets = await Promise.all(
      (isUnknownArray(input.apps) ? input.apps : [])
        .filter((app) => typeof app === "string")
        .map((app) => resolveTargetApp(session, app, options.signal)),
    );
    const observation = await session.native.beginObservation(
      targets.filter((app) => app !== null).map((app) => app.pid),
      { signal: options.signal },
    );
    return { observation, focusError: undefined };
  } catch (error) {
    return {
      observation: undefined,
      focusError: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Whether the inspected state plausibly owns the observed focused document.
 * @param {import("../tools/macos-native.mjs").NativeAppState} state
 * @param {ObservedAppSnapshot} observed
 * @returns {boolean}
 */
function focusedMarkerCandidate(state, observed) {
  const window = state.focusedWindow;
  const field = state.focusedElement;
  return (
    state.accessibilityTrusted &&
    window !== null &&
    field !== null &&
    field.identifier !== null &&
    field.identifier !== "" &&
    window.title === observed.title &&
    window.document === observed.url
  );
}

/**
 * Find the single observed element matching the native focused field.
 * @param {ObservedAppSnapshot} observed
 * @param {import("../tools/macos-native.mjs").NativeAppState["focusedElement"]} field
 * @returns {{ match: ObservedAppSnapshot["elements"][number], identifier: string } | undefined}
 */
function matchFocusedElement(observed, field) {
  const identifier = field?.identifier ?? "";
  const role = field?.roleDescription?.toLowerCase().replace(/^search text field$/, "search");
  const matches = observed.elements.filter(
    (e) =>
      e.id === identifier &&
      (e.role === role || e.role === field?.role) &&
      e.value !== undefined &&
      e.value === field?.value,
  );
  const match = matches.length === 1 ? matches[0] : undefined;
  return match === undefined ? undefined : { match, identifier };
}

/**
 * Join fresh parent AX identities to stable element IDs in the same complete
 * observed documents; never guess a field. Returns the joins to apply.
 * @param {import("./macuse-session.mjs").MacuseSession} session
 * @param {SessionResult["details"]["macuse"]["observations"]} observations
 * @param {number} started
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<Array<{ observed: ObservedAppSnapshot, match: ObservedAppSnapshot["elements"][number], text: string }>>}
 */
async function focusedMarkerJoins(session, observations, started, signal) {
  /** @type {Array<{ observed: ObservedAppSnapshot, match: ObservedAppSnapshot["elements"][number], text: string }>} */
  const joins = [];
  for (const observed of observations ?? []) {
    if (observed.focused || observed.observedAt < started || !observed.nativeWindowIdentity) {
      continue;
    }
    try {
      const app = await session.native.resolveApp(observed.app, { signal });
      const state = await session.native.inspectApp(app.pid, { signal });
      if (!focusedMarkerCandidate(state, observed)) {
        continue;
      }
      const found = matchFocusedElement(observed, state.focusedElement);
      if (found === undefined) {
        continue;
      }
      joins.push({
        observed,
        match: found.match,
        text: `Native focused field in ${observed.app}: ${found.match.role}, ID: ${found.identifier}.`,
      });
    } catch {
      /* Missing AX evidence leaves insertion unavailable, never authorizes a fallback. */
    }
  }
  return joins;
}

/**
 * Export the first emitted image to the requested path as a new private file.
 * Throws when the export fails; returns undefined when no path was requested.
 * @param {import("./macuse-session.mjs").MacuseSession} session
 * @param {SessionResult} result
 * @param {unknown} saveImagePath
 * @returns {Promise<Record<string, unknown> | undefined>}
 */
async function saveImageArtifact(session, result, saveImagePath) {
  if (typeof saveImagePath !== "string" || saveImagePath === "") {
    return;
  }
  const image = result.content.find((part) => part.type === "image");
  if (!image) {
    throw new Error(
      "No image was emitted; call getScreenshot or getAXStateAndScreenshot explicitly.",
    );
  }
  const path = resolve(session.cwd, saveImagePath.replace(/^~(?=\/)/, homedir()));
  const bytes = Buffer.from(image.data, "base64");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  return {
    path,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    ...imageMetadata(image.data),
  };
}

/**
 * Confirm a dispatched window close against native Accessibility state.
 * @param {import("./macuse-session.mjs").MacuseSession} session
 * @param {SessionResult} result
 */
async function verifyNativeClose(session, result) {
  const last = result.details.macuse.actions?.findLast((action) => Boolean(action.dispatched));
  if (last?.closesWindow !== true || !last.before) {
    return;
  }
  try {
    const app = await session.native.resolveApp(last.app);
    const state = await session.native.inspectApp(app.pid);
    if (state.accessibilityTrusted && nativeWindowClosed(last.before, state)) {
      last.verification = "native-window-closed";
      result.content.push({
        type: "text",
        text: "Native Accessibility confirms the target window is closed. No app-state read reopened it. Do not replay the close.",
      });
    }
  } catch (error) {
    result.content.push({
      type: "text",
      text: `Native close verification unavailable: ${error instanceof Error ? error.message : String(error)}. Do not replay the close.`,
    });
  }
}

/**
 * Finish the focus observation and build the details and evidence text.
 * @param {import("./macuse-session.mjs").MacuseSession} session
 * @param {Awaited<ReturnType<SessionNative["beginObservation"]>> | undefined} observation
 * @param {string | undefined} focusError
 * @returns {Promise<{ details: Record<string, unknown>, text: string }>}
 */
async function finishFocusObservation(session, observation, focusError) {
  const outcome = await endFocusObservation(session, observation, focusError);
  const focus = outcome.focus;
  return {
    details: {
      ...focus,
      observationAvailable: Boolean(focus?.coverage.applicationActivation),
      observationError: outcome.focusError ?? null,
      inputAttribution: false,
      isolationGuaranteed: false,
    },
    text: focus
      ? `Focus observation: ${focus.transitions.length} activation/window transition(s). Input attribution unavailable; input isolation is not guaranteed.`
      : `Focus observation unavailable: ${outcome.focusError ?? "no observation returned"}.`,
  };
}

/**
 * End the focus observation and collect its outcome for the caller to apply.
 * @param {import("./macuse-session.mjs").MacuseSession} session
 * @param {Awaited<ReturnType<SessionNative["beginObservation"]>> | undefined} observation
 * @param {string | undefined} focusError
 * @returns {Promise<{ focus: Awaited<ReturnType<SessionNative["endObservation"]>> | undefined, focusError: string | undefined }>}
 */
async function endFocusObservation(session, observation, focusError) {
  if (observation === undefined) {
    return { focus: undefined, focusError };
  }
  try {
    const focus = await session.native.endObservation(observation.id);
    return { focus, focusError };
  } catch (error) {
    return { focus: undefined, focusError: error instanceof Error ? error.message : String(error) };
  }
}

// One desktop session owns code execution, AX insertion, and their observations.
export class MacuseSession {
  /** @type {AbortController | undefined} */
  active = undefined;

  /**
   * @param {{ cwd?: string | undefined, runtime?: SessionRuntime, native?: SessionNative, auxiliary?: SessionAuxiliary }} [options]
   */
  constructor({
    cwd = process.cwd(),
    runtime = new CuaRuntime({ cwd }),
    native = new MacOSNative(),
    auxiliary = new AuxiliaryRuntime({ cwd }),
  } = {}) {
    this.cwd = cwd;
    this.runtime = runtime;
    this.native = native;
    this.auxiliary = auxiliary;
    /** @type {Promise<unknown>} */
    this.queue = Promise.resolve();
    this.generation = 0;
  }

  /**
   * @param {string} tool
   * @param {Record<string, unknown>} [input]
   * @param {{ signal?: AbortSignal, timeoutMs?: number, onUpdate?: (result: MacuseResult) => void }} [options]
   * @returns {Promise<MacuseResult>}
   */
  callTool(tool, input = {}, options = {}) {
    const check = validators.get(tool)?.(input);
    if (check?.valid !== true) {
      return Promise.resolve(failure(tool, check?.errorMessage ?? `Unknown macuse tool: ${tool}`));
    }
    if (tool === "macuse_reset") {
      return this.reset();
    }
    const clone = structuredClone(input);
    const generation = this.generation;
    const run = async () => {
      if (generation !== this.generation || options.signal?.aborted === true) {
        return failure(tool, "Cancelled before dispatch; no new action was sent.");
      }
      const controller = new AbortController();
      this.active = controller;
      const signal = options.signal
        ? AbortSignal.any([options.signal, controller.signal])
        : controller.signal;
      try {
        const result = await this.#dispatchTool(tool, clone, options, signal);
        if (result.details.macuse.kernelReset === true && generation === this.generation) {
          this.generation++;
        }
        result.details.macuse.isError = result.isError;
        for (const text of resultEvidenceTexts(result)) {
          result.content.push({ type: "text", text });
        }
        return result;
      } finally {
        if (this.active === controller) {
          this.active = undefined;
        }
      }
    };
    const result = this.queue.then(run);
    this.queue = result.catch(() => null);
    return result;
  }

  /**
   * Dispatch a validated macuse tool to its owning backend.
   * @param {string} tool
   * @param {Record<string, unknown>} clone
   * @param {{ signal?: AbortSignal, timeoutMs?: number, onUpdate?: (result: MacuseResult) => void }} options
   * @param {AbortSignal} signal
   * @returns {Promise<SessionResult>}
   */
  async #dispatchTool(tool, clone, options, signal) {
    if (tool === "macuse") {
      return this.execute(clone, { ...options, signal });
    }
    if (tool === "macuse_insert_text") {
      return this.#runInsertText(tool, clone, signal);
    }
    return this.auxiliary.callTool(tool, clone, { ...options, signal });
  }

  /**
   * Replace the selected text of a focused field through the native backend.
   * @param {string} tool
   * @param {Record<string, unknown>} clone
   * @param {AbortSignal} signal
   * @returns {Promise<SessionResult>}
   */
  async #runInsertText(tool, clone, signal) {
    /** @type {import("./native-input.mjs").InsertTextInput} */
    let insertInput;
    try {
      insertInput = buildInsertTextInput(clone);
    } catch {
      return failure(tool, "macuse_insert_text requires an app and text.");
    }
    const app = insertInput.app;
    /** @type {SessionResult | undefined} */
    let refresh;
    /** @type {SessionResult} */
    const result = await insertText(this.native, insertInput, this.runtime.getObservation(app), {
      signal,
      refreshObservation: async () => {
        const started = Date.now();
        try {
          refresh = await this.execute(
            { code: `await cua.getApp(${JSON.stringify(app)})`, trackFocus: false },
            { signal },
          );
          if (refresh.isError) {
            throw new Error(
              refresh.content
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join("\n"),
            );
          }
          const observation = this.runtime.getObservation(app);
          if (!observation || observation.observedAt < started) {
            throw new Error("A fresh full app snapshot is required before inserting text.");
          }
          return observation;
        } finally {
          // This internal read must never authorize a later action, even if insertion refuses.
          this.runtime.invalidateObservation(app);
        }
      },
    });
    if (refresh) {
      const evidence = refreshEvidence(refresh);
      result.details.macuse.refresh = evidence.refresh;
      result.details.macuse.kernelReset = evidence.kernelReset;
      if (evidence.interruption !== undefined) {
        result.details.macuse.interruption = evidence.interruption;
      }
    }
    return result;
  }

  /**
   * @param {Record<string, unknown>} input
   * @param {NonNullable<Parameters<CuaRuntime["execute"]>[1]>} options
   * @returns {Promise<SessionResult>}
   */
  async execute(input, options) {
    const { trackFocus = true, saveImagePath, ...codeInput } = input;
    const begun = await beginFocusObservation(this, input, options);
    /** @type {Awaited<ReturnType<SessionNative["beginObservation"]>> | undefined} */
    const observation = begun.observation;
    /** @type {string | undefined} */
    const focusError = begun.focusError;
    let result;
    const started = Date.now();
    try {
      result = await this.runtime.execute(codeInput, options);
      // Sky omits TextEdit's focused marker. Join a fresh parent AX identity to
      // one stable ID in the same complete observed document, never guess a field.
      const joins = await focusedMarkerJoins(
        this,
        result.details.macuse.observations,
        started,
        options.signal,
      );
      for (const join of joins) {
        join.observed.focused = join.match;
        result.content.push({ type: "text", text: join.text });
      }
      try {
        const savedImage = await saveImageArtifact(this, result, saveImagePath);
        if (savedImage !== undefined) {
          result.details.macuse.savedImage = savedImage;
        }
      } catch (error) {
        result.isError = true;
        result.content.push({
          type: "text",
          text: `Screenshot export failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      await verifyNativeClose(this, result);
    } finally {
      if (trackFocus === true && result) {
        const focus = await finishFocusObservation(this, observation, focusError);
        result.details.macuse.focus = focus.details;
        result.content.push({ type: "text", text: focus.text });
      }
    }
    return result;
  }

  /**
   * @returns {Promise<MacuseResult>}
   */
  reset() {
    this.generation++;
    this.active?.abort();
    const result = this.queue.then(async () => {
      await this.runtime.reset();
      /** @type {MacuseResult} */
      const outcome = {
        content: [
          {
            type: "text",
            text: "JavaScript bindings and app observations cleared. Applications are unchanged. Observe before acting; no previous action was replayed.",
          },
        ],
        isError: false,
        details: { macuse: { tool: "macuse_reset", isError: false } },
      };
      return outcome;
    });
    this.queue = result.catch(() => null);
    return result;
  }

  status() {
    return { computer: this.runtime.status(), auxiliary: this.auxiliary.status() };
  }

  /**
   * @returns {Promise<void>}
   */
  async stop() {
    this.generation++;
    this.active?.abort();
    const result = this.queue.then(() =>
      Promise.all([this.runtime.stop(), this.native.stop(), this.auxiliary.stop()]),
    );
    this.queue = result.catch(() => null);
    await result;
  }
}
