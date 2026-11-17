import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { VERSION } from "./macuse-utils.mjs";
import { ensureHelperBundle, launchHelperSession } from "./macos-helper-bundle.mjs";

/** @typedef {import("./macos-native.mjs").NativeApplication} NativeApplication */
/** @typedef {import("./macos-native.mjs").NativeWindow} NativeWindow */
/** @typedef {import("./macos-native.mjs").NativeSnapshot} NativeSnapshot */
/** @typedef {import("./macos-native.mjs").NativeObservation} NativeObservation */
/** @typedef {import("./macos-native.mjs").NativeAppState} NativeAppState */
/** @typedef {import("./macos-native.mjs").AccessibilityStatus} AccessibilityStatus */
/** @typedef {import("./macos-native.mjs").NativeRequestOptions} NativeRequestOptions */
/** @typedef {import("./macos-helper-bundle.mjs").HelperSession} HelperSession */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
/** @param {unknown} value @returns {value is NativeApplication} */
const isNativeApplication = (value) =>
  isRecord(value) &&
  typeof value.pid === "number" &&
  typeof value.name === "string" &&
  (value.bundleId === null || typeof value.bundleId === "string") &&
  (value.path === null || typeof value.path === "string");
/** @param {unknown} value @returns {value is NativeWindow} */
const isNativeWindow = (value) =>
  isRecord(value) &&
  typeof value.token === "string" &&
  (value.title === null || typeof value.title === "string") &&
  (value.document === null || typeof value.document === "string");
/** @param {unknown} value @returns {value is NativeSnapshot} */
const isNativeSnapshot = (value) =>
  isRecord(value) &&
  (value.frontmost === null || isNativeApplication(value.frontmost)) &&
  (value.focusedWindow === null || isNativeWindow(value.focusedWindow));
/** @param {unknown} value @returns {value is { id: string, before?: NativeSnapshot | undefined }} */
const isObservationHandle = (value) =>
  isRecord(value) &&
  typeof value.id === "string" &&
  (value.before === undefined || isNativeSnapshot(value.before));
/** @param {unknown} value @returns {value is NativeObservation} */
const isNativeObservation = (value) =>
  isRecord(value) &&
  isNativeSnapshot(value.before) &&
  isNativeSnapshot(value.after) &&
  Array.isArray(value.transitions) &&
  isRecord(value.coverage);
/** @param {Record<string, unknown>} value @returns {boolean} */
const hasNativeWindowsState = (value) =>
  (typeof value.windowsCount === "number" || value.windowsCount === null) &&
  typeof value.windowsError === "number" &&
  (value.windows === null || (Array.isArray(value.windows) && value.windows.every(isNativeWindow)));
/** @param {unknown} value @returns {value is NativeAppState} */
const isNativeAppState = (value) =>
  isRecord(value) &&
  typeof value.pid === "number" &&
  (value.app === null || isNativeApplication(value.app)) &&
  typeof value.accessibilityTrusted === "boolean" &&
  hasNativeWindowsState(value) &&
  (value.focusedWindow === null || isNativeWindow(value.focusedWindow)) &&
  (value.focusedElement === null || isRecord(value.focusedElement));
/** @param {unknown} value @returns {value is AccessibilityStatus} */
const isAccessibilityStatus = (value) =>
  isRecord(value) &&
  typeof value.accessibilityTrusted === "boolean" &&
  typeof value.prompted === "boolean" &&
  (value.bundleId === null || typeof value.bundleId === "string");

const source = fileURLToPath(new URL("./macos-native.swift", import.meta.url));
/** @type {Promise<{ appPath: string, bundleId: string, signingMode: string }> | undefined} */
let compiled;

async function helperBundle() {
  compiled ??= ensureHelperBundle(source, VERSION);
  try {
    return await compiled;
  } catch (error) {
    compiled = undefined;
    throw error;
  }
}

// Verify absence from a successful native window listing, never by reopening the app.
/**
 * @param {{ title: string | null, url: string | null, nativeWindowIdentity: boolean }} before
 * @param {NativeAppState | null} after
 * @returns {boolean}
 */
export function nativeWindowClosed(before, after) {
  if (after !== null && after.windowsCount === 0) {
    return true;
  }
  if (!before.nativeWindowIdentity || after === null) {
    return false;
  }
  if (after.windowsCount === null) {
    return false;
  }
  const windows = after.windows;
  if (windows === null || windows.length === 0) {
    return false;
  }
  return windows.every((window) =>
    before.url !== null && before.url !== ""
      ? window.document !== null && window.document !== before.url
      : before.title !== null && window.title !== null && window.title !== before.title,
  );
}

/** @typedef {{ resolve: (result: unknown) => void, reject: (error: Error) => void, failure?: Error }} PendingCall */
/** One lazy helper session owned by the caller. Launches `MacuseHelper.app` via LaunchServices. */
export class MacOSNative {
  /** @type {HelperSession | undefined} */
  #session;
  /** @type {Promise<HelperSession> | undefined} */
  #starting;
  /** @type {Promise<void> | undefined} */
  #stopping;
  /** @readonly @type {Map<number, PendingCall>} */
  #pending = new Map();
  #nextId = 0;

  /** @returns {void} */
  #terminateQuietly() {
    this.stop().catch(() => null);
  }

  async #start() {
    if (this.#stopping) {
      await this.#stopping;
    }
    if (this.#session) {
      return this.#session;
    }
    if (!this.#starting) {
      this.#starting = (async () => {
        const bundle = await helperBundle();
        /** @type {{ current: HelperSession | undefined }} */
        const holder = { current: undefined };
        /** @param {Error} error */
        const fail = (error) => {
          if (holder.current === undefined || this.#session !== holder.current) {
            return;
          }
          for (const pending of this.#pending.values()) {
            pending.failure ??= error;
          }
          this.#terminateQuietly();
        };
        const session = await launchHelperSession(bundle.appPath, fail);
        holder.current = session;
        this.#wireMessages(session);
        this.#session = session;
        return session;
      })().finally(() => {
        this.#starting = undefined;
      });
    }
    return this.#starting;
  }

  /**
   * @param {HelperSession} session
   * @returns {void}
   */
  #wireMessages(session) {
    createInterface({ input: session.socket }).on("line", (line) => {
      /** @type {unknown} */
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (!isRecord(message)) {
        return;
      }
      const messageId = message.id;
      const pending = typeof messageId === "number" ? this.#pending.get(messageId) : undefined;
      if (pending === undefined || pending.failure !== undefined) {
        return;
      }
      const result = message.result;
      if (isRecord(result) && typeof result.error === "string" && result.error !== "") {
        pending.reject(new Error(result.error));
      } else {
        pending.resolve(result);
      }
    });
  }

  /**
   * @param {string} method
   * @param {Record<string, unknown>} [args]
   * @param {NativeRequestOptions} [options]
   * @returns {Promise<unknown>}
   */
  async #request(method, args = {}, { signal } = {}) {
    /** @type {HelperSession | undefined} */
    let session;
    try {
      signal?.throwIfAborted();
      session = await this.#start();
      signal?.throwIfAborted();
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error), { cause: error });
    }
    const id = ++this.#nextId;
    return new Promise((resolve, reject) => {
      /**
       * @param {Error | null} error
       * @param {unknown} [result]
       */
      const finish = (error, result) => {
        this.#pending.delete(id);
        clearTimeout(timer);
        signal?.removeEventListener("abort", aborted);
        if (error !== null) {
          reject(error);
        } else {
          resolve(result);
        }
      };
      /** @param {string} reason */
      const cancel = (reason) => {
        pending.failure = new Error(`Native ${method} ${reason}.`);
        this.#terminateQuietly();
      };
      const aborted = () => cancel("aborted");
      const timer = setTimeout(() => cancel("timed out"), 15_000);
      /** @type {PendingCall} */
      const pending = {
        resolve: (result) => finish(null, result),
        reject: (error) => finish(error),
      };
      this.#pending.set(id, pending);
      signal?.addEventListener("abort", aborted, { once: true });
      session.socket.write(`${JSON.stringify({ id, method, ...args })}\n`, (error) => {
        if (error !== null && error !== undefined && this.#pending.has(id)) {
          pending.failure = error;
          this.#terminateQuietly();
        }
      });
    });
  }

  /**
   * @param {NativeRequestOptions & { prompt?: boolean | undefined }} [options]
   * @returns {Promise<AccessibilityStatus>}
   */
  async ensureAccessibility({ prompt = false, signal } = {}) {
    const result = await this.#request("requestAccessibility", { prompt }, { signal });
    if (!isAccessibilityStatus(result)) {
      throw new Error("Native helper returned an invalid accessibility status.");
    }
    return result;
  }

  /**
   * @param {NativeRequestOptions} [options]
   * @returns {Promise<NativeSnapshot>}
   */
  async snapshot(options) {
    const result = await this.#request("snapshot", {}, options);
    if (!isNativeSnapshot(result)) {
      throw new Error("Native helper returned an invalid snapshot.");
    }
    return result;
  }
  /**
   * @param {string} identifier
   * @param {NativeRequestOptions} [options]
   * @returns {Promise<NativeApplication>}
   */
  async resolveApp(identifier, options) {
    const result = await this.#request("resolveApp", { identifier }, options);
    if (!isNativeApplication(result)) {
      throw new Error("Native helper returned an invalid app identity.");
    }
    return result;
  }
  /**
   * @param {number[]} [pids]
   * @param {NativeRequestOptions} [options]
   * @returns {Promise<{ id: string, before?: NativeSnapshot | undefined }>}
   */
  async beginObservation(pids = [], options) {
    const result = await this.#request("beginObservation", { pids }, options);
    if (!isObservationHandle(result)) {
      throw new Error("Native helper returned an invalid observation handle.");
    }
    return result;
  }
  /**
   * @param {string} id
   * @param {NativeRequestOptions} [options]
   * @returns {Promise<NativeObservation>}
   */
  async endObservation(id, options) {
    const result = await this.#request("endObservation", { observationId: id }, options);
    if (!isNativeObservation(result)) {
      throw new Error("Native helper returned an invalid observation.");
    }
    return result;
  }
  /**
   * @param {number} pid
   * @param {NativeRequestOptions} [options]
   * @returns {Promise<NativeAppState>}
   */
  async inspectApp(pid, options) {
    const result = await this.#request("inspectApp", { pid }, options);
    if (!isNativeAppState(result)) {
      throw new Error("Native helper returned an invalid app state.");
    }
    return result;
  }

  /** @returns {Promise<void>} */
  async stop() {
    if (this.#starting !== undefined) {
      await this.#starting.catch(() => null);
    }
    if (this.#stopping !== undefined) {
      return this.#stopping;
    }
    const session = this.#session;
    if (session === undefined) {
      return;
    }
    this.#session = undefined;
    const failure = new Error("Native helper stopped.");
    const pendingList = [...this.#pending.values()];
    this.#stopping = this.#closeSession(session, pendingList, failure).finally(() => {
      this.#stopping = undefined;
    });
    return this.#stopping;
  }

  /**
   * @param {HelperSession} session
   * @param {PendingCall[]} pendingList
   * @param {Error} failure
   * @returns {Promise<void>}
   */
  async #closeSession(session, pendingList, failure) {
    await session.close();
    for (const pending of pendingList) {
      pending.reject(pending.failure ?? failure);
    }
  }
}
