import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { resolveVendorCodex } from "./vendor-installation.mjs";
import { failure, isObject, isUnknownArray, version } from "./auxiliary-schema.mjs";
import {
  elicitationApproved,
  errorResultOf,
  logStopFailure,
  newCallContext,
  resources,
  respondToServer,
  resolvePending,
  retryableFailure,
  serverExposesTool,
  serverForTool,
  threadConfig,
  toolReport,
  writeMessage,
} from "./auxiliary-transport.mjs";

export { auxiliaryTools, validateAuxiliaryArguments } from "./auxiliary-schema.mjs";

/** @typedef {import("./auxiliary-transport.mjs").AuxiliaryResult} AuxiliaryResult */
/** @typedef {import("./auxiliary-transport.mjs").PendingRequest} PendingRequest */
/** @typedef {import("./auxiliary-transport.mjs").CallContext} CallContext */

export class AuxiliaryRuntime {
  /** @type {import("node:child_process").ChildProcess | null} */
  #proc = null;
  /** @type {Promise<void> | null} */
  #exited = null;
  /** @type {Promise<void> | null} */
  #stopping = null;
  /** @type {string | null} */
  #threadId = null;
  /** @readonly @type {Map<number, PendingRequest>} */
  #pending = new Map();
  #nextId = 1;
  /** @type {Promise<void>} */
  #queue = Promise.resolve();
  /** @type {CallContext | null} */
  #active = null;
  #stderr = "";

  /**
   * @param {{ cwd?: string, codexBin?: string | null }} [options]
   */
  constructor({
    cwd = process.cwd(),
    codexBin = process.env.CODEX_BIN !== undefined && process.env.CODEX_BIN !== ""
      ? process.env.CODEX_BIN
      : null,
  } = {}) {
    this.cwd = cwd;
    this.codexBin = codexBin;
  }

  status() {
    return {
      running: Boolean(
        this.#proc && this.#proc.exitCode === null && this.#proc.signalCode === null,
      ),
      processPid: this.#proc?.pid ?? null,
      threadId: this.#threadId,
      pendingRequests: this.#pending.size,
      cwd: this.cwd,
      codexBin: this.codexBin,
      stderrTail: this.#stderr,
    };
  }

  /**
   * @param {string} tool
   * @param {Record<string, unknown>} [input]
   * @param {{ signal?: AbortSignal | undefined, timeoutMs?: number | undefined }} [options]
   * @returns {Promise<AuxiliaryResult>}
   */
  callTool(tool, input = {}, { signal, timeoutMs = 90_000 } = {}) {
    const init = newCallContext(tool, input, timeoutMs);
    if (init.error !== undefined || init.args === undefined) {
      return Promise.resolve(errorResultOf(init.context, init.error));
    }
    const context = init.context;
    const args = init.args;
    return new Promise((resolve) => {
      let active = false;
      let finished = false;
      const finish = (/** @type {AuxiliaryResult} */ result) => {
        if (finished) {
          return;
        }
        finished = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        context.controller.signal.removeEventListener("abort", onCancel);
        resolve(result);
      };
      const onCancel = () => {
        if (active) {
          this.#stopProcess().catch(logStopFailure);
        } else {
          finish(errorResultOf(context, context.controller.signal.reason));
        }
      };
      const onAbort = () =>
        context.controller.abort(failure("aborted", "Auxiliary call was aborted."));
      const timer = setTimeout(
        () =>
          context.controller.abort(
            failure("timeout", `Auxiliary call timed out after ${timeoutMs}ms.`),
          ),
        timeoutMs,
      );
      context.controller.signal.addEventListener("abort", onCancel, { once: true });
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted === true) {
        onAbort();
      }
      const run = async () => {
        if (finished) {
          return;
        }
        active = true;
        this.#active = context;
        try {
          finish(await this.#call(args, context));
        } catch (error) {
          await this.#stopProcess();
          finish(
            errorResultOf(
              context,
              context.controller.signal.aborted ? context.controller.signal.reason : error,
            ),
          );
        } finally {
          this.#active = null;
        }
      };
      this.#queue = this.#queue.then(run);
    });
  }

  /**
   * The running call's mutable context. It is set for the whole duration of
   * #call, so mutations target the class-owned state instead of parameters.
   * @returns {CallContext}
   */
  #activeCall() {
    const active = this.#active;
    if (active === null) {
      throw new Error("No active auxiliary call.");
    }
    return active;
  }

  /**
   * @param {Record<string, unknown>} args
   * @param {CallContext} context
   * @returns {Promise<AuxiliaryResult>}
   */
  async #call(args, context) {
    const { tool, controller } = context;
    for (;;) {
      controller.signal.throwIfAborted();
      this.#activeCall().attempts++;
      try {
        await this.#ensureThread(context);
        const server = serverForTool(tool);
        this.#activeCall().missingTools = [`${server}/${tool}`];
        await this.#awaitToolReady(server, tool, context);
        const result = await this.#request(
          "mcpServer/tool/call",
          { threadId: this.#threadId, server, tool, arguments: args },
          context,
        );
        controller.signal.throwIfAborted();
        const reported = toolReport(result, tool, context);
        if (reported !== undefined) {
          return reported;
        }
      } catch (error) {
        if (!retryableFailure(tool, context, error)) {
          throw error;
        }
      }
      await this.#stopProcess();
    }
  }

  /**
   * Wait until the owning server exposes the tool.
   * @param {string} server
   * @param {string} tool
   * @param {CallContext} context
   * @returns {Promise<void>}
   */
  async #awaitToolReady(server, tool, context) {
    for (;;) {
      let cursor;
      do {
        const page = await this.#toolStatusPage(cursor, context);
        if (serverExposesTool(page.entries, server, tool)) {
          this.#activeCall().missingTools = [];
          break;
        }
        cursor = page.nextCursor;
      } while (cursor !== undefined && cursor !== "");
      if (context.missingTools.length === 0) {
        return;
      }
      await delay(100, undefined, { signal: context.controller.signal });
    }
  }

  /**
   * One page of auxiliary MCP server status entries.
   * @param {string | undefined} cursor
   * @param {CallContext} context
   * @returns {Promise<{ entries: unknown[], nextCursor: string | undefined }>}
   */
  async #toolStatusPage(cursor, context) {
    const status = await this.#request(
      "mcpServerStatus/list",
      {
        threadId: this.#threadId,
        detail: "toolsAndAuthOnly",
        limit: 100,
        ...(cursor !== undefined && cursor !== "" ? { cursor } : {}),
      },
      context,
    );
    const entries = isObject(status) && isUnknownArray(status.data) ? status.data : [];
    const next = isObject(status) ? status.nextCursor : undefined;
    return { entries, nextCursor: typeof next === "string" ? next : undefined };
  }

  /**
   * @param {CallContext} context
   * @returns {Promise<void>}
   */
  async #ensureThread(context) {
    if (this.#stopping) {
      await this.#stopping;
    }
    context.controller.signal.throwIfAborted();
    if (this.#threadId !== null) {
      return;
    }
    this.#spawnProcess();
    await this.#startThread(context);
  }

  /**
   * Spawn the app-server subprocess and wire its transport.
   * @returns {void}
   */
  #spawnProcess() {
    this.codexBin ??= resolveVendorCodex(resources).path;
    const proc = spawn(
      this.codexBin,
      [
        "app-server",
        "--disable",
        "apps",
        "--enable",
        "computer_use",
        "--enable",
        "plugins",
        "--enable",
        "tool_call_mcp_elicitation",
      ],
      { cwd: this.cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] },
    );
    this.#proc = proc;
    this.#stderr = "";
    /** @type {unknown} */
    let spawnError;
    this.#exited = new Promise((resolve) => {
      proc.on("error", (error) => {
        if (proc.pid === undefined) {
          spawnError = error;
        }
      });
      proc.once("close", (code, signal) => {
        const error =
          spawnError instanceof Error
            ? spawnError
            : failure(
                "transport-closed",
                `Auxiliary app-server transport closed (code=${String(code)}, signal=${String(signal)}).`,
              );
        for (const pending of this.#pending.values()) {
          pending.reject(error);
        }
        this.#pending.clear();
        if (this.#proc === proc) {
          this.#proc = null;
          this.#threadId = null;
        }
        resolve();
      });
    });
    proc.stdin.on("error", () => {
      this.#stopProcess().catch(logStopFailure);
    });
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (/** @type {string} */ chunk) => {
      this.#stderr = (this.#stderr + chunk).slice(-4000);
    });
    createInterface({ input: proc.stdout }).on("line", (line) => this.#onLine(line, proc));
  }

  /**
   * Initialize the app-server session and start the auxiliary thread.
   * @param {CallContext} context
   * @returns {Promise<void>}
   */
  async #startThread(context) {
    await this.#request(
      "initialize",
      {
        clientInfo: { name: "macuse-auxiliary", version },
        capabilities: { experimentalApi: true, requestAttestation: false },
      },
      context,
    );
    this.#write({ jsonrpc: "2.0", method: "initialized", params: {} });
    const configRead = await this.#request(
      "config/read",
      { cwd: this.cwd, includeLayers: false },
      context,
    );
    if (!isObject(configRead) || !isObject(configRead.config)) {
      throw new Error("config/read response did not include config.");
    }
    const start = await this.#request(
      "thread/start",
      threadConfig(configRead.config, this.cwd),
      context,
    );
    const thread = isObject(start) ? start.thread : undefined;
    const threadId = isObject(thread) && typeof thread.id === "string" ? thread.id : undefined;
    if (threadId === undefined || threadId === "") {
      throw new Error("thread/start response did not include thread.id.");
    }
    context.controller.signal.throwIfAborted();
    this.#threadId = threadId;
  }

  /**
   * @param {unknown} message
   * @returns {void}
   */
  #write(message) {
    writeMessage(this.#proc, message);
  }

  /**
   * @param {string} method
   * @param {unknown} params
   * @param {CallContext} context
   * @returns {Promise<unknown>}
   */
  #request(method, params, context) {
    context.controller.signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const id = this.#nextId++;
      this.#pending.set(id, { resolve, reject, method });
      try {
        this.#write({ jsonrpc: "2.0", id, method, params });
        if (method === "mcpServer/tool/call") {
          this.#activeCall().dispatched = true;
        }
      } catch (error) {
        this.#pending.delete(id);
        reject(error);
      }
    });
  }

  /**
   * @param {string} line
   * @param {import("node:child_process").ChildProcess} proc
   * @returns {void}
   */
  #onLine(line, proc) {
    if (proc !== this.#proc) {
      return;
    }
    let parsed;
    try {
      parsed = /** @type {unknown} */ (JSON.parse(line));
    } catch {
      return;
    }
    if (!isObject(parsed)) {
      return;
    }
    const message = parsed;
    if (resolvePending(this.#pending, message)) {
      return;
    }
    respondToServer(
      message,
      proc,
      (reply) => this.#write(reply),
      elicitationApproved(this.#active, this.#pending),
    );
  }

  async stop() {
    this.#active?.controller.abort(failure("stopped", "Auxiliary runtime was stopped."));
    await this.#stopProcess();
  }

  async #stopProcess() {
    if (this.#stopping) {
      return this.#stopping;
    }
    const proc = this.#proc;
    if (!proc) {
      return;
    }
    this.#threadId = null;
    const exited = this.#exited;
    const stopping = (async () => {
      // EOF lets app-server close its own clients. Escalate only this subprocess.
      const term = setTimeout(() => {
        if (proc.exitCode === null && proc.signalCode === null) {
          proc.kill("SIGTERM");
        }
      }, 1000);
      const force = setTimeout(() => {
        if (proc.exitCode === null && proc.signalCode === null) {
          proc.kill("SIGKILL");
        }
      }, 3000);
      proc.stdin?.end();
      try {
        await exited;
      } finally {
        clearTimeout(term);
        clearTimeout(force);
      }
    })();
    this.#stopping = stopping;
    try {
      await stopping;
    } finally {
      if (this.#stopping === stopping) {
        this.#stopping = null;
      }
    }
  }
}
