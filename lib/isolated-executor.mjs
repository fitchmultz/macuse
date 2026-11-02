import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateEnvelope } from "./cua-guard-service.mjs";

/**
 * @typedef {import("node:child_process").ChildProcessByStdio<import("node:stream").Writable, import("node:stream").Readable, import("node:stream").Readable>} WorkerProcess
 * A registered host capability invoked inside the sandboxed worker.
 * @typedef {{ invoke: (params: unknown, context: { runId: string, envelope: import("./cua-guard-service.mjs").MacuseEnvelope, signal: AbortSignal }) => unknown, mutating: boolean }} Capability
 * One recorded guest capability call.
 * @typedef {{ method: unknown, callId: unknown, dispatched: boolean, outcome: string, mutating?: boolean, error?: string }} ExecutorAction
 * The active worker run's bookkeeping.
 * @typedef {{ input: import("./cua-guard-service.mjs").MacuseEnvelope, runId: string, actions: ExecutorAction[], controller: AbortController, pending: boolean, ended: boolean, finish?: ((error: Error | null, message?: unknown) => void) | undefined, interruption?: string | undefined }} RunState
 * The settled result of one guest execution.
 * @typedef {{ runId: string, isError: boolean, error?: unknown, value?: unknown, actions: ExecutorAction[], outcomeUnknown: boolean, interruption?: string }} ExecuteResult
 * One memory-monitor probe subprocess.
 * @typedef {{ child: import("node:child_process").ChildProcess, exit?: Promise<void> | undefined }} Monitor
 */

const source = fileURLToPath(new URL("../tools/isolated-executor.swift", import.meta.url));
const maxBytes = 65_536;
const maxCalls = 100;
const minimalEnvironment = { PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" };
/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
/**
 * @param {unknown} value
 * @returns {value is Capability["invoke"]}
 */
const isCapabilityInvoke = (value) => typeof value === "function";
/**
 * @param {unknown} error
 * @returns {void}
 */
const logDispatchFailure = (error) => {
  process.stderr.write(`macuse isolated-executor: dispatch failed: ${String(error)}\n`);
};
/** @type {Promise<{ target: string, directory: string }> | undefined} */
let compilation;

async function binary() {
  if (process.platform !== "darwin")
    throw new Error("The experimental isolated executor requires macOS.");
  compilation ??= (async () => {
    const hash = createHash("sha256")
      .update(await readFile(source))
      .update(process.arch)
      .digest("hex")
      .slice(0, 20);
    const directory = join(homedir(), "Library", "Caches", "macuse", "isolated-executor");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const target = join(directory, `worker-${hash}`);
    try {
      await access(target);
    } catch {
      const temporary = `${target}.${randomUUID()}`;
      try {
        /** @type {Promise<void>} */
        const compiled = new Promise((resolve, reject) => {
          const compiler = spawn("/usr/bin/xcrun", ["swiftc", source, "-o", temporary], {
            env: minimalEnvironment,
            stdio: ["ignore", "ignore", "pipe"],
          });
          let diagnostic = "";
          compiler.stderr.on("data", (/** @type {Buffer} */ chunk) => {
            diagnostic = (diagnostic + chunk.toString()).slice(-8000);
          });
          compiler.once("error", reject);
          compiler.once("close", (code) =>
            code === 0
              ? resolve()
              : reject(new Error(`Executor compilation failed: ${diagnostic}`)),
          );
        });
        await compiled;
        await rename(temporary, target);
      } finally {
        await rm(temporary, { force: true });
      }
    }
    return { target, directory };
  })().catch((/** @type {unknown} */ error) => {
    compilation = undefined;
    throw error;
  });
  return compilation;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function encoded(value) {
  const line = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(line) > maxBytes)
    throw new Error("Executor protocol message exceeds 65536 bytes.");
  return line;
}

/** Opt-in research primitive only. No production macuse session imports this module. */
export class IsolatedExecutor {
  /** @type {Map<string, Capability>} */
  // oxlint-disable-next-line typescript/prefer-readonly -- .mjs private fields cannot express readonly (TS8009)
  #capabilities;
  /** @type {WorkerProcess | undefined} */
  #child;
  /** @type {Promise<void> | undefined} */
  #exit;
  /** @type {RunState | undefined} */
  #active;
  /** @type {Promise<unknown>} */
  #tail = Promise.resolve();
  /** @type {Set<Promise<unknown>>} */
  // oxlint-disable-next-line typescript/prefer-readonly -- .mjs private fields cannot express readonly (TS8009)
  #hostCalls = new Set();
  #mutationBlocked = false;
  #generation = 0;
  // oxlint-disable-next-line typescript/prefer-readonly -- .mjs private fields cannot express readonly (TS8009)
  #memoryLimitMiB;
  /** @type {Promise<unknown> | undefined} */
  #stopping;
  /** @type {Set<Monitor>} */
  // oxlint-disable-next-line typescript/prefer-readonly -- .mjs private fields cannot express readonly (TS8009)
  #monitors = new Set();

  /**
   * @param {{ capabilities?: Record<string, unknown>, memoryLimitMiB?: number }} [options]
   */
  constructor({ capabilities = {}, memoryLimitMiB = 256 } = {}) {
    if (!Number.isSafeInteger(memoryLimitMiB) || memoryLimitMiB < 32 || memoryLimitMiB > 256)
      throw new TypeError("memoryLimitMiB must be 32..256.");
    this.#memoryLimitMiB = memoryLimitMiB;
    this.#capabilities = new Map(
      Object.entries(capabilities).map(([name, capability]) => {
        const record = isRecord(capability) ? capability : undefined;
        const invoke = record?.invoke;
        const mutating = record?.mutating;
        if (
          !/^[a-z][a-zA-Z0-9_.]{0,63}$/.test(name) ||
          !isCapabilityInvoke(invoke) ||
          typeof mutating !== "boolean"
        ) {
          throw new TypeError(
            "Each named capability needs invoke and an explicit mutating boolean.",
          );
        }
        /** @type {Capability} */
        const registered = { invoke, mutating };
        return [name, Object.freeze(registered)];
      }),
    );
  }

  status() {
    return {
      running: Boolean(this.#active),
      pid: this.#child?.pid,
      hostCallsPending: this.#hostCalls.size,
      mutationBlocked: this.#mutationBlocked,
    };
  }

  async #start() {
    if (this.#child) return;
    const { target, directory } = await binary();
    const fixture = join(directory, `sandbox-probe-${randomUUID()}`);
    await writeFile(fixture, "macuse isolated executor readable sentinel\n", {
      mode: 0o600,
      flag: "wx",
    });
    const child = spawn(target, [fixture], {
      env: { ...minimalEnvironment, JSC_useJIT: "0", JSC_useWasm: "0" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#child = child;
    let stderr = "";
    let buffered = Buffer.alloc(0);
    /** @type {() => void} */
    let readyResolve = () => null;
    /** @type {(error: unknown) => void} */
    let readyReject = () => null;
    /** @type {Promise<void>} */
    const ready = new Promise((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    const startup = setTimeout(() => {
      readyReject(new Error("Executor sandbox startup timed out."));
      child.kill("SIGKILL");
    }, 10_000);
    child.stderr.on("data", (/** @type {Buffer} */ chunk) => {
      stderr = (stderr + chunk.toString()).slice(-2000);
    });
    child.stdin.on("error", () => {
      child.kill("SIGKILL");
    });
    this.#exit = new Promise((resolve) => {
      child.once("close", (code, signal) => {
        clearTimeout(startup);
        if (this.#child === child) this.#child = undefined;
        readyReject(
          new Error(
            `Isolated worker exited (${String(signal ?? code)})${
              stderr !== "" ? `: ${stderr}` : ""
            }.`,
          ),
        );
        this.#active?.finish?.(new Error(`Isolated worker exited (${String(signal ?? code)}).`));
        resolve();
      });
    });
    child.once("error", readyReject);
    child.stdout.on("data", (/** @type {Buffer} */ chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      let newline;
      while ((newline = buffered.indexOf(10)) !== -1) {
        if (newline >= maxBytes) {
          child.kill("SIGKILL");
          return;
        }
        const line = buffered.subarray(0, newline);
        buffered = buffered.subarray(newline + 1);
        let parsed;
        try {
          parsed = /** @type {unknown} */ (JSON.parse(line.toString("utf8")));
        } catch {
          child.kill("SIGKILL");
          return;
        }
        if (!isRecord(parsed)) {
          child.kill("SIGKILL");
          return;
        }
        const message = parsed;
        if (
          message.type === "ready" &&
          message.sandbox === "seatbelt-deny-default" &&
          !this.#active
        ) {
          clearTimeout(startup);
          readyResolve();
        } else if (message.type === "call")
          this.#dispatch(child, message).catch(logDispatchFailure);
        else if (
          message.type === "result" &&
          this.#active !== undefined &&
          message.runId === this.#active.runId
        )
          this.#active.finish?.(null, message);
        else {
          child.kill("SIGKILL");
          return;
        }
      }
      if (buffered.length > maxBytes) child.kill("SIGKILL");
    });
    try {
      await ready;
    } catch (error) {
      child.kill("SIGKILL");
      await this.#exit;
      throw error;
    } finally {
      await rm(fixture, { force: true });
      await rm(`${fixture}.write`, { force: true });
    }
  }

  /**
   * @param {WorkerProcess} child
   * @param {Record<string, unknown>} message
   * @returns {Promise<void>}
   */
  async #dispatch(child, message) {
    const run = this.#active;
    if (
      !run ||
      run.ended ||
      run.pending ||
      message.runId !== run.runId ||
      message.callId !== run.actions.length + 1 ||
      run.actions.length >= maxCalls
    ) {
      child.kill("SIGKILL");
      return;
    }
    const ended = () => run.ended;
    /** @type {ExecutorAction} */
    const action = {
      method: message.method,
      callId: message.callId,
      dispatched: false,
      outcome: "rejected",
    };
    run.actions.push(action);
    const method = message.method;
    const capability = typeof method === "string" ? this.#capabilities.get(method) : undefined;
    let response;
    try {
      if (!capability) throw new Error("Capability is not registered.");
      if (!isRecord(message.params)) throw new Error("Capability params must be an object.");
      const params = message.params;
      const appAllowed =
        typeof params.app === "string" ? run.input.apps?.includes(params.app) === true : false;
      if (
        capability.mutating &&
        (this.#mutationBlocked || run.input.allowMutating !== true || !appAllowed)
      ) {
        throw new Error(
          "Mutation denied: trusted envelope, exact app scope, and unblocked execution required.",
        );
      }
      action.mutating = capability.mutating;
      run.pending = true;
      // The guest can supply params, never the trusted run envelope or AbortSignal.
      const task = Promise.resolve().then(() => {
        if (run.ended || run.controller.signal.aborted)
          throw new Error("Capability cancelled before dispatch.");
        action.dispatched = true;
        action.outcome = "unknown";
        return capability.invoke(structuredClone(params), {
          runId: run.runId,
          envelope: structuredClone(run.input),
          signal: run.controller.signal,
        });
      });
      this.#hostCalls.add(task);
      let value;
      try {
        value = await task;
      } finally {
        this.#hostCalls.delete(task);
        run.pending = false;
      }
      if (ended()) return;
      response = { value: value ?? null };
      // Serialization is part of settlement: an oversized/circular response never
      // gets represented to guest code as a successful capability acknowledgement.
      encoded({ type: "reply", runId: run.runId, callId: message.callId, ...response });
      action.outcome = "completed";
    } catch (error) {
      const detail = isRecord(error) && typeof error.message === "string" ? error.message : error;
      action.error = String(detail).slice(0, 2000);
      // A throwing capability may have applied an external effect. Only the host
      // capability/guard can establish anything narrower than unknown.
      if (action.dispatched) this.#mutationBlocked = true;
      response = { error: action.error };
    }
    if (ended() || this.#child !== child) return;
    child.stdin.write(
      encoded({ type: "reply", runId: run.runId, callId: message.callId, ...response }),
    );
  }

  /**
   * @param {unknown} input
   * @param {{ signal?: AbortSignal }} [options]
   * @returns {Promise<ExecuteResult>}
   */
  execute(input, { signal } = {}) {
    if (this.#stopping !== undefined)
      throw new Error("Executor is stopping; no execution admitted.");
    validateEnvelope(input);
    if (typeof input.code !== "string" || input.code.trim() === "")
      throw new TypeError("code must be nonempty.");
    const timeoutMs = input.timeoutMs ?? 5000;
    if (
      typeof timeoutMs !== "number" ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 50 ||
      timeoutMs > 30_000
    )
      throw new TypeError("timeoutMs must be 50..30000.");
    const saved = structuredClone({ ...input, timeoutMs });
    encoded({ type: "execute", runId: randomUUID(), code: saved.code });
    const generation = this.#generation;
    const task = this.#tail.then(() => this.#run(saved, signal, generation));
    this.#tail = task.catch(() => null);
    return task;
  }

  /**
   * @param {import("./cua-guard-service.mjs").MacuseEnvelope} input
   * @param {AbortSignal | undefined} signal
   * @param {number} generation
   * @returns {Promise<ExecuteResult>}
   */
  async #run(input, signal, generation) {
    const deadline = typeof input.timeoutMs === "number" ? input.timeoutMs : 5000;
    const aborted = () => signal?.aborted === true;
    if (aborted() || generation !== this.#generation)
      throw new Error("Execution aborted before dispatch.");
    if (this.#hostCalls.size > 0)
      throw new Error("A previous host capability is still pending; no execution admitted.");
    await this.#start();
    if (aborted() || generation !== this.#generation)
      throw new Error("Execution aborted before dispatch.");
    const child = this.#child;
    if (child === undefined) throw new Error("Isolated worker is not running.");
    /** @type {RunState} */
    const run = {
      input,
      runId: randomUUID(),
      actions: [],
      controller: new AbortController(),
      pending: false,
      ended: false,
    };
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let memoryTimer;
    /**
     * @param {Error | null} error
     * @param {Record<string, unknown> | undefined} record
     * @returns {{ error?: unknown, value?: unknown }}
     */
    const settlement = (error, record) => {
      if (error !== null) return { error: error.message };
      if (record !== undefined && Boolean(record.ok)) return { value: record.value };
      return { error: record?.error };
    };
    /** @type {Promise<ExecuteResult>} */
    const result = new Promise((resolve) => {
      run.finish = (error, message) => {
        if (run.ended) return;
        run.ended = true;
        run.controller.abort();
        clearTimeout(timer);
        clearTimeout(memoryTimer);
        signal?.removeEventListener("abort", abort);
        const unknown = run.actions.some(
          (action) => action.dispatched && action.outcome === "unknown",
        );
        if (unknown) this.#mutationBlocked = true;
        const record = isRecord(message) ? message : undefined;
        const acknowledged = record !== undefined && Boolean(record.ok);
        resolve({
          runId: run.runId,
          isError: error !== null || !acknowledged || unknown,
          ...settlement(error, record),
          actions: structuredClone(run.actions),
          outcomeUnknown: unknown,
        });
      };
    });
    const interrupt = (/** @type {string} */ reason) => {
      if (run.ended) return;
      run.interruption ??= reason;
      run.controller.abort();
      child.kill("SIGKILL");
    };
    const abort = () => interrupt("aborted");
    this.#active = run;
    const monitor = () => {
      if (run.ended) return;
      const ps = spawn("/bin/ps", ["-o", "rss=", "-p", String(child.pid)], {
        env: minimalEnvironment,
        stdio: ["ignore", "pipe", "ignore"],
      });
      /** @type {Monitor} */
      const tracked = { child: ps };
      /** @type {Promise<void>} */
      const exit = new Promise((resolve) => {
        ps.once("close", () => {
          this.#monitors.delete(tracked);
          resolve();
        });
      });
      tracked.exit = exit;
      this.#monitors.add(tracked);
      let output = "";
      ps.stdout.on("data", (/** @type {Buffer} */ chunk) => {
        output = (output + chunk.toString()).slice(0, 100);
      });
      ps.once("error", () => interrupt("memory-monitor-failed"));
      ps.once("close", (code) => {
        if (run.ended) return;
        if (code !== 0 || !/^\s*\d+\s*$/.test(output)) interrupt("memory-monitor-failed");
        else if (Number(output.trim()) > this.#memoryLimitMiB * 1024) interrupt("memory-budget");
        else memoryTimer = setTimeout(monitor, 50);
      });
    };
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => interrupt("deadline"), deadline);
    monitor();
    child.stdin.write(encoded({ type: "execute", runId: run.runId, code: input.code }));
    let completed = await result;
    if (run.interruption !== undefined) {
      await this.#exit;
      completed = {
        ...completed,
        interruption: run.interruption,
        error:
          "Execution interrupted; inspect fresh app state before continuing. Never replay dispatched calls.",
        isError: true,
      };
    }
    if (this.#active === run) this.#active = undefined;
    if (completed.isError) {
      child.kill("SIGKILL");
      await this.#exit;
    }
    await this.#stopMonitors();
    return completed;
  }

  async #stopMonitors() {
    const pending = [...this.#monitors];
    for (const monitor of pending) monitor.child.kill("SIGKILL");
    await Promise.all(pending.map((monitor) => monitor.exit ?? Promise.resolve()));
  }

  async stop() {
    if (this.#stopping) return this.#stopping;
    this.#generation++;
    const settled = this.#tail;
    // Publish the barrier before invoking any user-owned AbortSignal listeners.
    this.#stopping = Promise.resolve()
      .then(async () => {
        if (this.#active) this.#active.interruption ??= "stopped";
        this.#active?.controller.abort();
        this.#child?.kill("SIGKILL");
        await this.#exit;
        await settled;
        // A stop during lazy compilation must also dispose the child started afterward.
        this.#child?.kill("SIGKILL");
        await this.#exit;
        await this.#stopMonitors();
        return {
          ...this.status(),
          workerStopped: !this.#child,
          settled: this.#hostCalls.size === 0,
        };
      })
      .finally(() => {
        this.#stopping = undefined;
      });
    return this.#stopping;
  }
}
