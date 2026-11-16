import { setTimeout as delay } from "node:timers/promises";

/**
 * Concise macOS Computer Use API reference emitted once per CuaRuntime session.
 * Replaces the ~24 KB upstream vendor bootstrap doc that mentions disabled browser/Linux/Windows APIs.
 */
export const MACUSE_API_DOC = `## macuse Computer Use API

Persistent macOS Computer Use JavaScript runtime. Top-level \`await\` works; \`var\` bindings persist across calls until \`macuse_reset\` or a timeout/kernel reset.

### Discovery & observation
- \`await cua.getState(options?)\` — list running apps (\`{ emit?: boolean }\`).
- \`await cua.listApps(options?)\` — list apps (\`{ emit?: boolean }\`).
- \`var app = await cua.getApp(target, options?)\` — bind by app name, path, or bundle ID. Pass \`{ emit: false }\` when rebinding or ending the script with \`await app.getAXState()\` to avoid duplicate dumps.
- \`await app.getAXState(options?)\` — emit and return full AX tree (\`{ emit?: boolean }\`). Snapshots are always full (no diff mode).
- \`await app.getScreenshot(options?)\` — capture and emit screenshot bytes (\`{ emit?: boolean }\`).
- \`await app.getAXStateAndScreenshot(options?)\` — emit and return \`{ state, screenshot }\`.
- \`await app.waitFor(predicate, options?)\` — poll \`getAXState({ emit: false })\` until \`predicate(state)\` returns truthy, then emit and return the matched state once. Options: \`{ timeoutMs = 10000, intervalMs = 250, emit = true }\`.

### Actions (require \`allowMutating: true\`, matching \`apps\`, nonempty \`safetyNote\`)
- \`await app.performSecondaryAction(index, action)\` — invoke AX action (use \`"Press"\` even when omitted from \`Secondary Actions\`).
- \`await app.setValue(index, value)\` — replace entire field value (Unicode supported); verified by exact readback.
- \`await app.paste(text, { format })\` — insert Unicode at focus/selection (\`"text"\` | \`"md"\` | \`"html"\`), restoring clipboard.
- \`await app.typeText(text)\` — ASCII-only at current focus.
- \`await app.pressKey(key, { durationMs })\` — press key or chord (\`"Return"\`, \`"Escape"\`, \`"Tab"\`, \`"super+c"\`, \`"Up"\`).
- \`await app.click(target, { mouseButton, clickCount, key, durationMs })\` — target by \`index\` or \`[x, y]\` screenshot pixels.
- \`await app.drag([x1, y1], [x2, y2])\` — drag in screenshot pixels.
- \`await app.scroll(target, direction, pages?)\` — \`"up"\` | \`"down"\` | \`"left"\` | \`"right"\`, by \`index\` or \`[x, y]\`.
- \`await app.selectText(index, text, { prefix, suffix, selectionType })\` — select text in an editable element.

### Rules
- \`getState\`, \`listApps\`, \`getApp\`, \`getAXState\`, \`getScreenshot\`, \`getAXStateAndScreenshot\`, and \`waitFor\` auto-emit by default; do not \`nodeRepl.write\` the same state again.
- Derive indices from the latest observation. Never replay dispatched or unknown-outcome mutations.`;

export const SUPPRESS_STATE_START = "\x1eMACUSE_OMIT_STATE_START\x1e";
export const SUPPRESS_STATE_END = "\x1eMACUSE_OMIT_STATE_END\x1e";

/**
 * @typedef {{ write: (text: string, itemId?: string) => unknown }} ReplWriter
 * @typedef {{ getAXState: (options?: { emit?: boolean | undefined, disableDiffing?: boolean | undefined }) => Promise<string> }} ObservableApp
 * @typedef {{ getApp: (target: unknown, options?: unknown) => Promise<unknown> }} CuaSurface
 * @typedef {{ timeoutMs?: number | undefined, intervalMs?: number | undefined, emit?: boolean | undefined }} WaitForOptions
 * @typedef {{ emit?: boolean | undefined }} EmitOptions
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const VENDOR_TINYSKY_ALT = "@oai/cua/tinyskyAlt";

/**
 * @param {object} target
 * @param {string} key
 * @returns {unknown}
 */
const readProp = (target, key) => Reflect.get(target, key);

/**
 * @param {unknown} value
 * @returns {value is ObservableApp & Record<string, unknown>}
 */
const isObservableApp = (value) => isRecord(value) && typeof value.getAXState === "function";

/**
 * @param {unknown} value
 * @returns {value is CuaSurface & Record<string, unknown>}
 */
const isCuaSurface = (value) => isRecord(value) && typeof value.getApp === "function";

/**
 * @param {unknown} value
 * @returns {value is ReplWriter}
 */
const isReplWriter = (value) => isRecord(value) && typeof value.write === "function";

/**
 * @param {number | undefined} value
 * @param {number} fallback
 * @returns {number}
 */
function positiveMs(value, fallback) {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved < 1) {
    throw new RangeError("waitFor timeoutMs and intervalMs must be positive finite numbers.");
  }
  return resolved;
}

/**
 * @param {ObservableApp} app
 * @param {(state: string) => unknown} predicate
 * @param {number} intervalMs
 * @param {AbortSignal} deadline
 * @returns {Promise<{ matched: boolean, state: string }>}
 */
async function pollForMatch(app, predicate, intervalMs, deadline) {
  let lastState = "";
  try {
    while (!deadline.aborted) {
      lastState = await app.getAXState({ emit: false, disableDiffing: true });
      const matched = Boolean(await predicate(lastState));
      if (matched) {
        return { matched: true, state: lastState };
      }
      await delay(intervalMs, undefined, { signal: deadline });
    }
  } catch (error) {
    if (!deadline.aborted) {
      throw error;
    }
  }
  return { matched: false, state: lastState };
}

/**
 * @param {ObservableApp} app
 * @param {(state: string) => unknown} predicate
 * @param {WaitForOptions | undefined} options
 * @param {(text: string) => Promise<unknown>} emitState
 * @returns {Promise<string>}
 */
async function waitForAppState(app, predicate, options, emitState) {
  if (typeof predicate !== "function") {
    throw new TypeError("waitFor requires a predicate function.");
  }
  const timeoutMs = positiveMs(options?.timeoutMs, 10_000);
  const intervalMs = positiveMs(options?.intervalMs, 250);
  const emit = options?.emit !== false;
  const result = await pollForMatch(app, predicate, intervalMs, AbortSignal.timeout(timeoutMs));
  if (emit && result.state !== "") {
    await emitState(result.state);
  }
  if (result.matched) {
    return result.state;
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms.`);
}

/**
 * @param {ObservableApp & Record<string, unknown>} bound
 * @param {(text: string) => Promise<unknown>} writeState
 * @returns {ObservableApp & Record<string, unknown>}
 */
function enhanceBoundApp(bound, writeState) {
  const origGetAXState = bound.getAXState.bind(bound);
  return {
    ...bound,
    async getAXState(/** @type {EmitOptions & Record<string, unknown> | undefined} */ axOptions) {
      const shouldEmit = axOptions?.emit !== false;
      const state = await origGetAXState({ ...axOptions, disableDiffing: true, emit: false });
      if (shouldEmit && state !== "") {
        await writeState(state);
      }
      return state;
    },
    waitFor: (
      /** @type {(state: string) => unknown} */ predicate,
      /** @type {WaitForOptions | undefined} */ waitOptions,
    ) => waitForAppState(bound, predicate, waitOptions, writeState),
  };
}

/**
 * @param {CuaSurface} cua
 * @param {(text: string) => Promise<unknown>} writeState
 * @param {((text: string, itemId?: string) => unknown) | undefined} origWrite
 */
function wrapGetApp(cua, writeState, origWrite) {
  const origGetApp = cua.getApp.bind(cua);
  /** @type {(target: unknown, getOptions?: unknown) => Promise<unknown>} */
  const wrapped = async (target, getOptions) => {
    const suppressEmit = isRecord(getOptions) && getOptions.emit === false;
    if (suppressEmit && origWrite !== undefined) {
      await origWrite(SUPPRESS_STATE_START, "cua.state");
    }
    /** @type {unknown} */
    let bound;
    try {
      bound = await origGetApp(target, getOptions);
    } finally {
      if (origWrite !== undefined) {
        await origWrite(suppressEmit ? SUPPRESS_STATE_END : "\n", "cua.state");
      }
    }
    return isObservableApp(bound) ? enhanceBoundApp(bound, writeState) : bound;
  };
  Reflect.set(cua, "getApp", wrapped);
}

/**
 * Install the macuse runtime banner over `@oai/cua/tinyskyAlt`:
 * - separates sequential `app.getAXState` / `app.waitFor` writes with distinct `item_id`s
 * - adds `{ emit: false }` support to `cua.getApp` (stripped in `CuaRuntime`)
 * - adds `app.waitFor(predicate, options)` to bound macOS apps
 * Note: `globalThis.nodeRepl` and `cua.computer` are non-writable in `node_repl`,
 * so `cua.core` replacement, suppressed `getApp` cleanup, and deduplication run in `CuaRuntime`.
 * @param {{ repl?: unknown, loadVendor?: (() => Promise<unknown>) | undefined, globalObject?: Record<string, unknown> | undefined }} [options]
 * @returns {Promise<void>}
 */
export async function installCuaBanner(options = {}) {
  const root = options.globalObject ?? globalThis;
  const repl = options.repl ?? readProp(root, "nodeRepl");
  let stateSeq = 0;
  const origWrite = isReplWriter(repl) ? repl.write.bind(repl) : undefined;
  const writeState = async (/** @type {string} */ text) =>
    origWrite ? origWrite(text, `cua.state.${++stateSeq}`) : undefined;

  await (options.loadVendor ? options.loadVendor() : import(VENDOR_TINYSKY_ALT));

  const cua = readProp(root, "cua");
  if (isCuaSurface(cua)) {
    wrapGetApp(cua, writeState, origWrite);
  }
}
