import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

/** @typedef {import("./macos-native.mjs").NativeApplication} NativeApplication */
/** @typedef {import("./macos-native.mjs").NativeWindow} NativeWindow */
/** @typedef {import("./macos-native.mjs").NativeSnapshot} NativeSnapshot */
/** @typedef {import("./macos-native.mjs").NativeObservation} NativeObservation */
/** @typedef {import("./macos-native.mjs").NativeAppState} NativeAppState */
/** @typedef {import("./macos-native.mjs").NativeRequestOptions} NativeRequestOptions */
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
const source = fileURLToPath(new URL("./macos-native.swift", import.meta.url));
/** @type {Promise<string> | undefined} */
let compiled;
async function executable() {
  if (process.platform !== "darwin") {
    throw new Error("Native Accessibility requires macOS");
  }
  if (!compiled) {
    compiled = (async () => {
      const hash = createHash("sha256")
        .update(await readFile(source))
        .update(process.arch)
        .digest("hex")
        .slice(0, 20);
      const directory = join(homedir(), "Library", "Caches", "macuse", "native");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const binary = join(directory, `macos-native-${hash}`);
      try {
        await access(binary);
        return binary;
      } catch {
        /* Compile once per source revision. */
      }
      const temporary = `${binary}.${process.pid}.tmp`;
      try {
        /** @type {Promise<void>} */
        const compilation = new Promise((resolve, reject) => {
          const compiler = spawn("/usr/bin/xcrun", ["swiftc", source, "-o", temporary], {
            stdio: ["ignore", "ignore", "pipe"],
          });
          let stderr = "";
          compiler.stderr.on("data", (chunk) => {
            if (!Buffer.isBuffer(chunk)) {
              return;
            }
            stderr = (stderr + chunk.toString()).slice(-8000);
          });
          compiler.once("error", reject);
          compiler.once("exit", (code) =>
            code === 0
              ? resolve()
              : reject(
                  new Error(
                    `Native helper compilation failed: ${stderr}. Ensure xcrun swiftc is available from your Xcode or Command Line Tools installation.`,
                  ),
                ),
          );
        });
        await compilation;
        await rename(temporary, binary);
      } finally {
        await rm(temporary, { force: true });
      }
      return binary;
    })();
  }
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
/** One lazy child owned by the caller's session. Every request only reads native state. */
export class MacOSNative {
  /** @type {import("node:child_process").ChildProcessByStdio<import("node:stream").Writable, import("node:stream").Readable, import("node:stream").Readable> | undefined} */
  #child;
  /** @type {Promise<import("node:child_process").ChildProcessByStdio<import("node:stream").Writable, import("node:stream").Readable, import("node:stream").Readable>> | undefined} */
  #starting;
  /** @type {Promise<void> | undefined} */
  #stopping;
  /** @readonly @type {Map<number, PendingCall>} */
  #pending = new Map();
  #nextId = 0;

  async #start() {
    if (this.#stopping) {
      await this.#stopping;
    }
    if (this.#child) {
      return this.#child;
    }
    if (!this.#starting) {
      this.#starting = (async () => {
        const child = spawn(await executable(), [], { stdio: ["pipe", "pipe", "pipe"] });
        let stderr = "";
        child.stderr.on("data", (chunk) => {
          if (!Buffer.isBuffer(chunk)) {
            return;
          }
          stderr = (stderr + chunk.toString()).slice(-4000);
        });
        const terminateQuietly = () => {
          this.stop().catch(() => null);
        };
        /**
         * @param {Error} error
         * @param {boolean} [closed]
         */
        const fail = (error, closed = false) => {
          if (this.#child !== child) {
            return;
          }
          if (!closed && child.pid !== undefined) {
            for (const pending of this.#pending.values()) {
              pending.failure ??= error;
            }
            terminateQuietly();
            return;
          }
          this.#child = undefined;
          for (const pending of this.#pending.values()) {
            pending.reject(pending.failure ?? error);
          }
        };
        child.once("error", fail);
        child.once("close", (code, signal) => {
          fail(
            new Error(
              `Native helper stopped (${signal ?? code ?? "unknown"})${stderr !== "" ? `: ${stderr}` : ""}.`,
            ),
            true,
          );
        });
        child.stdin.on("error", fail);
        createInterface({ input: child.stdout }).on("line", (line) => {
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
        this.#child = child;
        return child;
      })().finally(() => {
        this.#starting = undefined;
      });
    }
    return this.#starting;
  }

  /**
   * @param {string} method
   * @param {Record<string, unknown>} [args]
   * @param {NativeRequestOptions} [options]
   * @returns {Promise<unknown>}
   */
  async #request(method, args = {}, { signal } = {}) {
    /** @type {import("node:child_process").ChildProcessByStdio<import("node:stream").Writable, import("node:stream").Readable, import("node:stream").Readable> | undefined} */
    let child;
    try {
      signal?.throwIfAborted();
      child = await this.#start();
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
        // Reject only after the owned process has exited.
        this.stop().catch(() => null);
      };
      const aborted = () => cancel("aborted");
      const timer = setTimeout(() => cancel("timed out"), 15_000);
      const terminateQuietly = () => {
        this.stop().catch(() => null);
      };
      /** @type {PendingCall} */
      const pending = {
        resolve: (result) => finish(null, result),
        reject: (error) => finish(error),
      };
      this.#pending.set(id, pending);
      signal?.addEventListener("abort", aborted, { once: true });
      child.stdin.write(`${JSON.stringify({ id, method, ...args })}\n`, (error) => {
        if (error !== null && error !== undefined && this.#pending.has(id)) {
          pending.failure = error;
          terminateQuietly();
        }
      });
    });
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
    const child = this.#child;
    if (child === undefined) {
      return;
    }
    /** @type {Promise<void>} */
    const exited = new Promise((resolve) => {
      const timer = setTimeout(() => child.kill("SIGKILL"), 1000);
      child.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill();
    });
    this.#stopping = exited.finally(() => {
      this.#stopping = undefined;
    });
    return this.#stopping;
  }
}
