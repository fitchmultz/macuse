import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateEnvelope } from "./cua-guard-service.mjs";

const source = fileURLToPath(new URL("../tools/isolated-executor.swift", import.meta.url));
const maxBytes = 65_536;
const maxCalls = 100;
const minimalEnvironment = { PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" };
let compilation;

async function binary() {
  if (process.platform !== "darwin") throw new Error("The experimental isolated executor requires macOS.");
  compilation ??= (async () => {
    const hash = createHash("sha256").update(await readFile(source)).update(process.arch).digest("hex").slice(0, 20);
    const directory = join(homedir(), "Library", "Caches", "macuse", "isolated-executor");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const target = join(directory, `worker-${hash}`);
    try { await access(target); } catch {
      const temporary = `${target}.${randomUUID()}`;
      try {
        await new Promise((resolve, reject) => {
          const compiler = spawn("/usr/bin/xcrun", ["swiftc", source, "-o", temporary], { env: minimalEnvironment, stdio: ["ignore", "ignore", "pipe"] });
          let diagnostic = "";
          compiler.stderr.on("data", chunk => { diagnostic = (diagnostic + chunk).slice(-8000); });
          compiler.once("error", reject);
          compiler.once("close", code => code === 0 ? resolve() : reject(new Error(`Executor compilation failed: ${diagnostic}`)));
        });
        await rename(temporary, target);
      } finally { await rm(temporary, { force: true }); }
    }
    return { target, directory };
  })().catch(error => { compilation = undefined; throw error; });
  return compilation;
}

function encoded(value) {
  const line = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(line) > maxBytes) throw new Error("Executor protocol message exceeds 65536 bytes.");
  return line;
}

/** Opt-in research primitive only. No production macuse session imports this module. */
export class IsolatedExecutor {
  #capabilities;
  #child;
  #exit;
  #active;
  #tail = Promise.resolve();
  #hostCalls = new Set();
  #mutationBlocked = false;
  #generation = 0;
  #memoryLimitMiB;
  #stopping;
  #monitors = new Set();

  constructor({ capabilities = {}, memoryLimitMiB = 256 } = {}) {
    if (!Number.isSafeInteger(memoryLimitMiB) || memoryLimitMiB < 32 || memoryLimitMiB > 256) throw new TypeError("memoryLimitMiB must be 32..256.");
    this.#memoryLimitMiB = memoryLimitMiB;
    this.#capabilities = new Map(Object.entries(capabilities).map(([name, capability]) => {
      if (!/^[a-z][a-zA-Z0-9_.]{0,63}$/.test(name) || typeof capability?.invoke !== "function" || typeof capability.mutating !== "boolean") {
        throw new TypeError("Each named capability needs invoke and an explicit mutating boolean.");
      }
      return [name, Object.freeze({ ...capability })];
    }));
  }

  status() {
    return { running: Boolean(this.#active), pid: this.#child?.pid, hostCallsPending: this.#hostCalls.size, mutationBlocked: this.#mutationBlocked };
  }

  async #start() {
    if (this.#child) return;
    const { target, directory } = await binary();
    const fixture = join(directory, `sandbox-probe-${randomUUID()}`);
    await writeFile(fixture, "macuse isolated executor readable sentinel\n", { mode: 0o600, flag: "wx" });
    const child = spawn(target, [fixture], {
      env: { ...minimalEnvironment, JSC_useJIT: "0", JSC_useWasm: "0" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#child = child;
    let stderr = "";
    let buffered = Buffer.alloc(0);
    let readyResolve, readyReject;
    const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    const startup = setTimeout(() => { readyReject(new Error("Executor sandbox startup timed out.")); child.kill("SIGKILL"); }, 10_000);
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-2000); });
    child.stdin.on("error", () => { child.kill("SIGKILL"); });
    this.#exit = new Promise(resolve => child.once("close", (code, signal) => {
      clearTimeout(startup);
      if (this.#child === child) this.#child = undefined;
      readyReject(new Error(`Isolated worker exited (${signal ?? code})${stderr ? `: ${stderr}` : ""}.`));
      this.#active?.finish(new Error(`Isolated worker exited (${signal ?? code}).`));
      resolve();
    }));
    child.once("error", readyReject);
    child.stdout.on("data", chunk => {
      buffered = Buffer.concat([buffered, chunk]);
      let newline;
      while ((newline = buffered.indexOf(10)) !== -1) {
        if (newline >= maxBytes) { child.kill("SIGKILL"); return; }
        const line = buffered.subarray(0, newline);
        buffered = buffered.subarray(newline + 1);
        let message;
        try { message = JSON.parse(line.toString("utf8")); } catch { child.kill("SIGKILL"); return; }
        if (message.type === "ready" && message.sandbox === "seatbelt-deny-default" && !this.#active) {
          clearTimeout(startup); readyResolve();
        } else if (message.type === "call") void this.#dispatch(child, message);
        else if (message.type === "result" && message.runId === this.#active?.runId) this.#active.finish(null, message);
        else { child.kill("SIGKILL"); return; }
      }
      if (buffered.length > maxBytes) child.kill("SIGKILL");
    });
    try { await ready; } catch (error) { child.kill("SIGKILL"); await this.#exit; throw error; }
    finally { await rm(fixture, { force: true }); await rm(`${fixture}.write`, { force: true }); }
  }

  async #dispatch(child, message) {
    const run = this.#active;
    if (!run || run.ended || run.pending || message.runId !== run.runId || message.callId !== run.actions.length + 1 || run.actions.length >= maxCalls) {
      child.kill("SIGKILL"); return;
    }
    const action = { method: message.method, callId: message.callId, dispatched: false, outcome: "rejected" };
    run.actions.push(action);
    const capability = this.#capabilities.get(message.method);
    let response;
    try {
      if (!capability) throw new Error("Capability is not registered.");
      if (!message.params || typeof message.params !== "object" || Array.isArray(message.params)) throw new Error("Capability params must be an object.");
      if (capability.mutating && (this.#mutationBlocked || !run.input.allowMutating || !run.input.apps?.includes(message.params.app))) {
        throw new Error("Mutation denied: trusted envelope, exact app scope, and unblocked execution required.");
      }
      action.mutating = capability.mutating;
      run.pending = true;
      // The guest can supply params, never the trusted run envelope or AbortSignal.
      const task = Promise.resolve().then(() => {
        if (run.ended || run.controller.signal.aborted) throw new Error("Capability cancelled before dispatch.");
        action.dispatched = true;
        action.outcome = "unknown";
        return capability.invoke(structuredClone(message.params), {
          runId: run.runId, envelope: structuredClone(run.input), signal: run.controller.signal,
        });
      });
      this.#hostCalls.add(task);
      let value;
      try { value = await task; } finally { this.#hostCalls.delete(task); run.pending = false; }
      if (run.ended) return;
      response = { value: value ?? null };
      // Serialization is part of settlement: an oversized/circular response never
      // gets represented to guest code as a successful capability acknowledgement.
      encoded({ type: "reply", runId: run.runId, callId: message.callId, ...response });
      action.outcome = "completed";
    } catch (error) {
      action.error = String(error?.message ?? error).slice(0, 2000);
      // A throwing capability may have applied an external effect. Only the host
      // capability/guard can establish anything narrower than unknown.
      if (action.dispatched) this.#mutationBlocked = true;
      response = { error: action.error };
    }
    if (run.ended || this.#child !== child) return;
    child.stdin.write(encoded({ type: "reply", runId: run.runId, callId: message.callId, ...response }));
  }

  execute(input, { signal } = {}) {
    if (this.#stopping) throw new Error("Executor is stopping; no execution admitted.");
    validateEnvelope(input);
    if (typeof input.code !== "string" || !input.code.trim()) throw new TypeError("code must be nonempty.");
    const timeoutMs = input.timeoutMs ?? 5000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 30_000) throw new TypeError("timeoutMs must be 50..30000.");
    const saved = structuredClone({ ...input, timeoutMs });
    encoded({ type: "execute", runId: randomUUID(), code: saved.code });
    const generation = this.#generation;
    const task = this.#tail.then(() => this.#run(saved, signal, generation));
    this.#tail = task.catch(() => {});
    return task;
  }

  async #run(input, signal, generation) {
    if (signal?.aborted || generation !== this.#generation) throw new Error("Execution aborted before dispatch.");
    if (this.#hostCalls.size) throw new Error("A previous host capability is still pending; no execution admitted.");
    await this.#start();
    if (signal?.aborted || generation !== this.#generation) throw new Error("Execution aborted before dispatch.");
    const child = this.#child;
    const run = { input, runId: randomUUID(), actions: [], controller: new AbortController(), pending: false, ended: false };
    let timer, memoryTimer;
    const result = new Promise(resolve => {
      run.finish = (error, message) => {
        if (run.ended) return;
        run.ended = true;
        run.controller.abort();
        clearTimeout(timer); clearTimeout(memoryTimer);
        signal?.removeEventListener("abort", abort);
        const unknown = run.actions.some(action => action.dispatched && action.outcome === "unknown");
        if (unknown) this.#mutationBlocked = true;
        resolve({ runId: run.runId, isError: Boolean(error || !message?.ok || unknown),
          ...(error ? { error: error.message } : message?.ok ? { value: message.value } : { error: message?.error }),
          actions: structuredClone(run.actions), outcomeUnknown: unknown });
      };
    });
    const interrupt = reason => {
      if (run.ended) return;
      run.interruption ??= reason;
      run.controller.abort(); child.kill("SIGKILL");
    };
    const abort = () => interrupt("aborted");
    this.#active = run;
    const monitor = () => {
      if (run.ended) return;
      const ps = spawn("/bin/ps", ["-o", "rss=", "-p", String(child.pid)], { env: minimalEnvironment, stdio: ["ignore", "pipe", "ignore"] });
      const tracked = { child: ps };
      tracked.exit = new Promise(resolve => ps.once("close", () => { this.#monitors.delete(tracked); resolve(); }));
      this.#monitors.add(tracked);
      let output = "";
      ps.stdout.on("data", chunk => { output = (output + chunk).slice(0, 100); });
      ps.once("error", () => interrupt("memory-monitor-failed"));
      ps.once("close", code => {
        if (run.ended) return;
        if (code !== 0 || !/^\s*\d+\s*$/.test(output)) interrupt("memory-monitor-failed");
        else if (Number(output.trim()) > this.#memoryLimitMiB * 1024) interrupt("memory-budget");
        else memoryTimer = setTimeout(monitor, 50);
      });
    };
    signal?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => interrupt("deadline"), input.timeoutMs);
    monitor();
    child.stdin.write(encoded({ type: "execute", runId: run.runId, code: input.code }));
    let completed = await result;
    if (run.interruption) {
      await this.#exit;
      completed = { ...completed, interruption: run.interruption,
        error: "Execution interrupted; inspect fresh app state before continuing. Never replay dispatched calls.", isError: true };
    }
    if (this.#active === run) this.#active = undefined;
    if (completed.isError) { child.kill("SIGKILL"); await this.#exit; }
    await this.#stopMonitors();
    return completed;
  }

  async #stopMonitors() {
    const pending = [...this.#monitors];
    for (const monitor of pending) monitor.child.kill("SIGKILL");
    await Promise.all(pending.map(monitor => monitor.exit));
  }

  async stop() {
    if (this.#stopping) return this.#stopping;
    this.#generation++;
    const settled = this.#tail;
    // Publish the barrier before invoking any user-owned AbortSignal listeners.
    this.#stopping = Promise.resolve().then(async () => {
      if (this.#active) this.#active.interruption ??= "stopped";
      this.#active?.controller.abort();
      this.#child?.kill("SIGKILL");
      await this.#exit;
      await settled;
      // A stop during lazy compilation must also dispose the child started afterward.
      this.#child?.kill("SIGKILL");
      await this.#exit;
      await this.#stopMonitors();
      return { ...this.status(), workerStopped: !this.#child, settled: this.#hostCalls.size === 0 };
    }).finally(() => { this.#stopping = undefined; });
    return this.#stopping;
  }
}
