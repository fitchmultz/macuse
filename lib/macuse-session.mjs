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
    if (check?.valid !== true)
      return Promise.resolve(failure(tool, check?.errorMessage ?? `Unknown macuse tool: ${tool}`));
    if (tool === "macuse_reset") return this.reset();
    const clone = structuredClone(input);
    const generation = this.generation;
    const run = async () => {
      if (generation !== this.generation || options.signal?.aborted === true)
        return failure(tool, "Cancelled before dispatch; no new action was sent.");
      const controller = new AbortController();
      this.active = controller;
      const signal = options.signal
        ? AbortSignal.any([options.signal, controller.signal])
        : controller.signal;
      try {
        /** @type {SessionResult | undefined} */
        let result;
        if (tool === "macuse") result = await this.execute(clone, { ...options, signal });
        else if (tool === "macuse_insert_text") {
          const app = clone.app;
          const text = clone.text;
          if (typeof app !== "string" || typeof text !== "string")
            return failure(tool, "macuse_insert_text requires an app and text.");
          const insertInput = {
            app,
            text,
            ...(typeof clone.allowMutating === "boolean"
              ? { allowMutating: clone.allowMutating }
              : {}),
            ...(typeof clone.safetyNote === "string" ? { safetyNote: clone.safetyNote } : {}),
            ...(typeof clone.expectedTitle === "string"
              ? { expectedTitle: clone.expectedTitle }
              : {}),
            ...(typeof clone.expectedUrl === "string" ? { expectedUrl: clone.expectedUrl } : {}),
          };
          /** @type {SessionResult | undefined} */
          let refresh;
          result = await insertText(this.native, insertInput, this.runtime.getObservation(app), {
            signal,
            refreshObservation: async () => {
              const started = Date.now();
              try {
                refresh = await this.execute(
                  { code: `await cua.getApp(${JSON.stringify(app)})`, trackFocus: false },
                  { signal },
                );
                if (refresh.isError)
                  throw new Error(
                    refresh.content
                      .filter((part) => part.type === "text")
                      .map((part) => part.text)
                      .join("\n"),
                  );
                const observation = this.runtime.getObservation(app);
                if (!observation || observation.observedAt < started)
                  throw new Error("A fresh full app snapshot is required before inserting text.");
                return observation;
              } finally {
                // This internal read must never authorize a later action, even if insertion refuses.
                this.runtime.invalidateObservation(app);
              }
            },
          });
          if (refresh) {
            result.details.macuse.refresh = refresh.details.macuse;
            result.details.macuse.kernelReset = refresh.details.macuse.kernelReset;
            const interruption = refresh.details.macuse.interruption;
            if (interruption !== undefined && interruption !== null)
              result.details.macuse.interruption = interruption;
          }
        } else result = await this.auxiliary.callTool(tool, clone, { ...options, signal });
        if (result.details.macuse.kernelReset === true && generation === this.generation)
          this.generation++;
        result.details.macuse.isError = result.isError;
        const savedImage = result.details.macuse.savedImage;
        if (savedImage !== undefined && savedImage !== null)
          result.content.push({
            type: "text",
            text: `Saved screenshot: ${JSON.stringify(savedImage)}`,
          });
        const actions = result.details.macuse.actions;
        if (isUnknownArray(actions) && actions.length > 0)
          result.content.push({
            type: "text",
            text: JSON.stringify({
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
          });
        if (result.isError)
          result.content.push({
            type: "text",
            text: "Execution failed or has an unverified outcome. Inspect fresh state before continuing; never automatically replay a dispatched or unknown-outcome mutation.",
          });
        return result;
      } finally {
        if (this.active === controller) this.active = undefined;
      }
    };
    const result = this.queue.then(run);
    this.queue = result.catch(() => null);
    return result;
  }

  /**
   * @param {Record<string, unknown>} input
   * @param {NonNullable<Parameters<CuaRuntime["execute"]>[1]>} options
   * @returns {Promise<SessionResult>}
   */
  async execute(input, options) {
    const { trackFocus = true, saveImagePath, ...codeInput } = input;
    /** @type {Awaited<ReturnType<SessionNative["beginObservation"]>> | undefined} */
    let observation;
    /** @type {string | undefined} */
    let focusError;
    if (trackFocus === true) {
      try {
        const targets = await Promise.all(
          (isUnknownArray(input.apps) ? input.apps : [])
            .filter((app) => typeof app === "string")
            .map((app) =>
              this.native.resolveApp(app, { signal: options.signal }).catch(() => null),
            ),
        );
        observation = await this.native.beginObservation(
          targets.filter((app) => app !== null).map((app) => app.pid),
          { signal: options.signal },
        );
      } catch (error) {
        focusError = error instanceof Error ? error.message : String(error);
      }
    }
    let result;
    const started = Date.now();
    try {
      result = await this.runtime.execute(codeInput, options);
      // Sky omits TextEdit's focused marker. Join a fresh parent AX identity to
      // one stable ID in the same complete observed document, never guess a field.
      for (const observed of result.details.macuse.observations ?? []) {
        if (observed.focused || observed.observedAt < started || !observed.nativeWindowIdentity)
          continue;
        try {
          const app = await this.native.resolveApp(observed.app, { signal: options.signal });
          const state = await this.native.inspectApp(app.pid, { signal: options.signal });
          const window = state.focusedWindow,
            field = state.focusedElement;
          if (
            !state.accessibilityTrusted ||
            !window ||
            field === null ||
            field.identifier === null ||
            field.identifier === "" ||
            window.title !== observed.title ||
            window.document !== observed.url
          )
            continue;
          const identifier = field.identifier;
          const role = field.roleDescription
            ?.toLowerCase()
            .replace(/^search text field$/, "search");
          const matches = observed.elements.filter(
            (e) =>
              e.id === identifier &&
              (e.role === role || e.role === field.role) &&
              e.value !== undefined &&
              e.value === field.value,
          );
          if (matches.length !== 1) continue;
          const match = matches[0];
          if (match === undefined) continue;
          observed.focused = match;
          result.content.push({
            type: "text",
            text: `Native focused field in ${observed.app}: ${match.role}, ID: ${identifier}.`,
          });
        } catch {
          /* Missing AX evidence leaves insertion unavailable, never authorizes a fallback. */
        }
      }
      if (typeof saveImagePath === "string" && saveImagePath !== "") {
        try {
          const image = result.content.find((part) => part.type === "image");
          if (!image)
            throw new Error(
              "No image was emitted; call getScreenshot or getAXStateAndScreenshot explicitly.",
            );
          const path = resolve(this.cwd, saveImagePath.replace(/^~(?=\/)/, homedir()));
          const bytes = Buffer.from(image.data, "base64");
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
          result.details.macuse.savedImage = {
            path,
            bytes: bytes.length,
            sha256: createHash("sha256").update(bytes).digest("hex"),
            ...imageMetadata(image.data),
          };
        } catch (error) {
          result.isError = true;
          result.content.push({
            type: "text",
            text: `Screenshot export failed: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }
      const last = result.details.macuse.actions?.findLast((action) => Boolean(action.dispatched));
      if (last?.closesWindow === true && last.before) {
        try {
          const app = await this.native.resolveApp(last.app);
          const state = await this.native.inspectApp(app.pid);
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
    } finally {
      if (trackFocus === true) {
        let focus;
        if (observation) {
          try {
            focus = await this.native.endObservation(observation.id);
          } catch (error) {
            focusError = error instanceof Error ? error.message : String(error);
          }
        }
        if (result) {
          result.details.macuse.focus = {
            ...focus,
            observationAvailable: Boolean(focus?.coverage.applicationActivation),
            observationError: focusError ?? null,
            inputAttribution: false,
            isolationGuaranteed: false,
          };
          result.content.push({
            type: "text",
            text: focus
              ? `Focus observation: ${focus.transitions.length} activation/window transition(s). Input attribution unavailable; input isolation is not guaranteed.`
              : `Focus observation unavailable: ${focusError ?? "no observation returned"}.`,
          });
        }
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
