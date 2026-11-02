import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { validateEnvelope } from "./cua-guard-service.mjs";
import { binary, minimalEnvironment } from "./isolated-binary.mjs";

/**
 * @typedef {import("node:child_process").ChildProcessByStdio<import("node:stream").Writable, import("node:stream").Readable, import("node:stream").Readable>} WorkerProcess
 * A registered host capability invoked inside the sandboxed worker.
 * @typedef {{ invoke: (params: unknown, context: { runId: string, envelope: import("./cua-guard-service.mjs").MacuseEnvelope, signal: AbortSignal }) => unknown, mutating: boolean }} Capability
 * One recorded guest capability call.
 * @typedef {{ method: unknown, callId: unknown, dispatched: boolean, outcome: string, mutating?: boolean, error?: string }} ExecutorAction
 * The active worker run's bookkeeping.
 * @typedef {{ input: import("./cua-guard-service.mjs").MacuseEnvelope, runId: string, actions: ExecutorAction[], controller: AbortController, pending: boolean, ended: boolean, finish?: ((error: Error | null, message?: unknown) => void) | undefined, interruption?: string | undefined, memoryTimer?: ReturnType<typeof setTimeout> | undefined }} RunState
 * The settled result of one guest execution.
 * @typedef {{ runId: string, isError: boolean, error?: unknown, value?: unknown, actions: ExecutorAction[], outcomeUnknown: boolean, interruption?: string }} ExecuteResult
 * One memory-monitor probe subprocess.
 * @typedef {{ child: import("node:child_process").ChildProcess, exit?: Promise<void> | undefined }} Monitor
 */

const maxBytes = 65_536;
const maxCalls = 100;
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

/**
 * A ready handshake deferred shared between startup wiring and message routing.
 * @returns {{ promise: Promise<void>, resolve: () => void, reject: (error: unknown) => void }}
 */
const deferredReady = () => {
  /** @type {() => void} */
  let resolve = () => null;
  /** @type {(error: unknown) => void} */
  let reject = () => null;
  /** @type {Promise<void>} */
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

/**
 * An admitted guest call: live run, matching ids, within budget.
 * @param {RunState | undefined} run
 * @param {Record<string, unknown>} message
 * @returns {run is RunState}
 */
const dispatchAdmitted = (run, message) =>
  run !== undefined &&
  !run.ended &&
  !run.pending &&
  message.runId === run.runId &&
  message.callId === run.actions.length + 1 &&
  run.actions.length < maxCalls;

/**
 * Whether an execution was aborted or superseded before dispatch.
 * @param {AbortSignal | undefined} signal
 * @param {number} generation
 * @param {number} current
 * @returns {boolean}
 */
const executionStale = (signal, generation, current) =>
  signal?.aborted === true || generation !== current;

/**
 * Map a worker settlement message to result fields.
 * @param {Error | null} error
 * @param {Record<string, unknown> | undefined} record
 * @returns {{ error?: unknown, value?: unknown }}
 */
const settlement = (error, record) => {
  if (error !== null) {
    return { error: error.message };
  }
  if (record !== undefined && Boolean(record.ok)) {
    return { value: record.value };
  }
  return { error: record?.error };
};

/**
 * @param {unknown} value
 * @returns {string}
 */
function encoded(value) {
  const line = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(line) > maxBytes) {
    throw new Error("Executor protocol message exceeds 65536 bytes.");
  }
  return line;
}

/** Opt-in research primitive only. No production macuse session imports this module. */
export class IsolatedExecutor {
  /** @readonly @type {Map<string, Capability>} */
  #capabilities;
  /** @type {WorkerProcess | undefined} */
  #child;
  /** @type {Promise<void> | undefined} */
  #exit;
  /** @type {RunState | undefined} */
  #active;
  /** @type {Promise<unknown>} */
  #tail = Promise.resolve();
  /** @readonly @type {Set<Promise<unknown>>} */
  #hostCalls = new Set();
  #mutationBlocked = false;
  #generation = 0;
  /** @readonly */
  #memoryLimitMiB;
  /** @type {Promise<unknown> | undefined} */
  #stopping;
  /** @readonly @type {Set<Monitor>} */
  #monitors = new Set();

  /**
   * @param {{ capabilities?: Record<string, unknown>, memoryLimitMiB?: number }} [options]
   */
  constructor({ capabilities = {}, memoryLimitMiB = 256 } = {}) {
    if (!Number.isSafeInteger(memoryLimitMiB) || memoryLimitMiB < 32 || memoryLimitMiB > 256) {
      throw new TypeError("memoryLimitMiB must be 32..256.");
    }
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
    if (this.#child) {
      return;
    }
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
    const ready = deferredReady();
    const startup = setTimeout(() => {
      ready.reject(new Error("Executor sandbox startup timed out."));
      child.kill("SIGKILL");
    }, 10_000);
    this.#wireWorkerLifecycle(child, startup, ready);
    this.#workerMessages(child, startup, ready);
    try {
      await ready.promise;
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
   * Wire worker stderr/stdin/close handling and the class exit promise.
   * @param {WorkerProcess} child
   * @param {ReturnType<typeof setTimeout>} startup
   * @param {{ reject: (error: unknown) => void }} ready
   * @returns {void}
   */
  #wireWorkerLifecycle(child, startup, ready) {
    let stderr = "";
    child.stderr.on("data", (/** @type {Buffer} */ chunk) => {
      stderr = (stderr + chunk.toString()).slice(-2000);
    });
    child.stdin.on("error", () => {
      child.kill("SIGKILL");
    });
    this.#exit = new Promise((resolve) => {
      child.once("close", (code, signal) => {
        clearTimeout(startup);
        if (this.#child === child) {
          this.#child = undefined;
        }
        ready.reject(
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
    child.once("error", ready.reject);
  }

  /**
   * Buffer worker stdout into newline-delimited protocol messages.
   * @param {WorkerProcess} child
   * @param {ReturnType<typeof setTimeout>} startup
   * @param {{ resolve: () => void }} ready
   * @returns {void}
   */
  #workerMessages(child, startup, ready) {
    let buffered = Buffer.alloc(0);
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
        if (!isRecord(parsed) || !this.#handleWorkerMessage(child, parsed, startup, ready)) {
          child.kill("SIGKILL");
          return;
        }
      }
      if (buffered.length > maxBytes) {
        child.kill("SIGKILL");
      }
    });
  }

  /**
   * Route one decoded worker protocol message. False stops line processing.
   * @param {WorkerProcess} child
   * @param {Record<string, unknown>} message
   * @param {ReturnType<typeof setTimeout>} startup
   * @param {{ resolve: () => void }} ready
   * @returns {boolean}
   */
  #handleWorkerMessage(child, message, startup, ready) {
    if (message.type === "ready" && message.sandbox === "seatbelt-deny-default" && !this.#active) {
      clearTimeout(startup);
      ready.resolve();
      return true;
    }
    if (message.type === "call") {
      this.#dispatch(child, message).catch(logDispatchFailure);
      return true;
    }
    if (
      message.type === "result" &&
      this.#active !== undefined &&
      message.runId === this.#active.runId
    ) {
      this.#active.finish?.(null, message);
      return true;
    }
    child.kill("SIGKILL");
    return false;
  }

  /**
   * @param {WorkerProcess} child
   * @param {Record<string, unknown>} message
   * @returns {Promise<void>}
   */
  async #dispatch(child, message) {
    const run = this.#active;
    if (!dispatchAdmitted(run, message)) {
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
    let response;
    try {
      const value = await this.#invokeCapability(message);
      if (ended()) {
        return;
      }
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
      if (action.dispatched) {
        this.#mutationBlocked = true;
      }
      response = { error: action.error };
    }
    if (ended() || this.#child !== child) {
      return;
    }
    child.stdin.write(
      encoded({ type: "reply", runId: run.runId, callId: message.callId, ...response }),
    );
  }

  /**
   * The registered capability a guest message names.
   * @param {Record<string, unknown>} message
   * @returns {Capability | undefined}
   */
  #capabilityFor(message) {
    return typeof message.method === "string" ? this.#capabilities.get(message.method) : undefined;
  }

  /**
   * Whether a capability call is denied under the trusted run envelope.
   * @param {RunState} run
   * @param {Capability} capability
   * @param {Record<string, unknown>} params
   * @returns {boolean}
   */
  #mutationDenied(run, capability, params) {
    const appAllowed =
      typeof params.app === "string" ? run.input.apps?.includes(params.app) === true : false;
    return (
      capability.mutating &&
      (this.#mutationBlocked || run.input.allowMutating !== true || !appAllowed)
    );
  }

  /**
   * The active run, or a throw if no run is active.
   * @returns {RunState}
   */
  #activeRun() {
    const run = this.#active;
    if (run === undefined) {
      throw new Error("No active worker run.");
    }
    return run;
  }

  /**
   * The newest recorded action of a run.
   * @param {RunState} run
   * @returns {ExecutorAction}
   */
  #currentAction(run) {
    const action = run.actions[run.actions.length - 1];
    if (action === undefined) {
      throw new Error("No recorded action for this call.");
    }
    return action;
  }

  /**
   * Validate and invoke one admitted guest capability call.
   * @param {Record<string, unknown>} message
   * @returns {Promise<unknown>}
   */
  async #invokeCapability(message) {
    const run = this.#activeRun();
    const action = this.#currentAction(run);
    const capability = this.#capabilityFor(message);
    if (!capability) {
      throw new Error("Capability is not registered.");
    }
    if (!isRecord(message.params)) {
      throw new Error("Capability params must be an object.");
    }
    const params = message.params;
    if (this.#mutationDenied(run, capability, params)) {
      throw new Error(
        "Mutation denied: trusted envelope, exact app scope, and unblocked execution required.",
      );
    }
    action.mutating = capability.mutating;
    run.pending = true;
    // The guest can supply params, never the trusted run envelope or AbortSignal.
    const task = Promise.resolve().then(() => {
      if (run.ended || run.controller.signal.aborted) {
        throw new Error("Capability cancelled before dispatch.");
      }
      action.dispatched = true;
      action.outcome = "unknown";
      return capability.invoke(structuredClone(params), {
        runId: run.runId,
        envelope: structuredClone(run.input),
        signal: run.controller.signal,
      });
    });
    this.#hostCalls.add(task);
    try {
      return await task;
    } finally {
      this.#hostCalls.delete(task);
      run.pending = false;
    }
  }

  /**
   * @param {unknown} input
   * @param {{ signal?: AbortSignal }} [options]
   * @returns {Promise<ExecuteResult>}
   */
  execute(input, { signal } = {}) {
    if (this.#stopping !== undefined) {
      throw new Error("Executor is stopping; no execution admitted.");
    }
    validateEnvelope(input);
    if (typeof input.code !== "string" || input.code.trim() === "") {
      throw new TypeError("code must be nonempty.");
    }
    const timeoutMs = input.timeoutMs ?? 5000;
    if (
      typeof timeoutMs !== "number" ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 50 ||
      timeoutMs > 30_000
    ) {
      throw new TypeError("timeoutMs must be 50..30000.");
    }
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
    if (executionStale(signal, generation, this.#generation)) {
      throw new Error("Execution aborted before dispatch.");
    }
    if (this.#hostCalls.size > 0) {
      throw new Error("A previous host capability is still pending; no execution admitted.");
    }
    await this.#start();
    if (executionStale(signal, generation, this.#generation)) {
      throw new Error("Execution aborted before dispatch.");
    }
    const child = this.#child;
    if (child === undefined) {
      throw new Error("Isolated worker is not running.");
    }
    /** @type {RunState} */
    const run = {
      input,
      runId: randomUUID(),
      actions: [],
      controller: new AbortController(),
      pending: false,
      ended: false,
    };
    const interrupt = (/** @type {string} */ reason) => {
      if (run.ended) {
        return;
      }
      run.interruption ??= reason;
      run.controller.abort();
      child.kill("SIGKILL");
    };
    const abort = () => interrupt("aborted");
    /** @type {Promise<ExecuteResult>} */
    const result = new Promise((resolve) => {
      run.finish = (error, message) => {
        if (run.ended) {
          return;
        }
        run.ended = true;
        run.controller.abort();
        clearTimeout(timer);
        clearTimeout(run.memoryTimer);
        signal?.removeEventListener("abort", abort);
        const unknown = run.actions.some(
          (action) => action.dispatched && action.outcome === "unknown",
        );
        if (unknown) {
          this.#mutationBlocked = true;
        }
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
    this.#active = run;
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => interrupt("deadline"), deadline);
    this.#startMonitor(child, interrupt);
    child.stdin.write(encoded({ type: "execute", runId: run.runId, code: input.code }));
    return this.#settleRun(run, child, await result);
  }

  /**
   * Apply interruption and cleanup to a settled worker result.
   * @param {RunState} run
   * @param {WorkerProcess} child
   * @param {ExecuteResult} completed
   * @returns {Promise<ExecuteResult>}
   */
  async #settleRun(run, child, completed) {
    let settled = completed;
    if (run.interruption !== undefined) {
      await this.#exit;
      settled = {
        ...completed,
        interruption: run.interruption,
        error:
          "Execution interrupted; inspect fresh app state before continuing. Never replay dispatched calls.",
        isError: true,
      };
    }
    if (this.#active === run) {
      this.#active = undefined;
    }
    if (settled.isError) {
      child.kill("SIGKILL");
      await this.#exit;
    }
    await this.#stopMonitors();
    return settled;
  }

  /**
   * Poll worker RSS against the memory budget until the run ends.
   * @param {WorkerProcess} child
   * @param {(reason: string) => void} interrupt
   * @returns {void}
   */
  #startMonitor(child, interrupt) {
    const run = this.#activeRun();
    const poll = () => {
      if (run.ended) {
        return;
      }
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
        if (run.ended) {
          return;
        }
        if (code !== 0 || !/^\s*\d+\s*$/.test(output)) {
          interrupt("memory-monitor-failed");
        } else if (Number(output.trim()) > this.#memoryLimitMiB * 1024) {
          interrupt("memory-budget");
        } else {
          run.memoryTimer = setTimeout(poll, 50);
        }
      });
    };
    poll();
  }

  async #stopMonitors() {
    const pending = [...this.#monitors];
    for (const monitor of pending) {
      monitor.child.kill("SIGKILL");
    }
    await Promise.all(pending.map((monitor) => monitor.exit ?? Promise.resolve()));
  }

  async stop() {
    if (this.#stopping) {
      return this.#stopping;
    }
    this.#generation++;
    const settled = this.#tail;
    // Publish the barrier before invoking any user-owned AbortSignal listeners.
    this.#stopping = Promise.resolve()
      .then(async () => {
        if (this.#active) {
          this.#active.interruption ??= "stopped";
        }
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
