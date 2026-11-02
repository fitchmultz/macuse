import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import {
  ChildExitError,
  JSON_RPC_ERROR,
  JsonRpcResponseError,
  MissingInstallError,
  TimeoutError,
  hasOwn,
  isRecord,
  sanitizeForLog,
  truncate,
} from "./probe-codex-core.mjs";
import { VERSION } from "./macuse-utils.mjs";

/** @typedef {import("./probe-codex-core.mjs").ElicitationHandler} ElicitationHandler */
/** @typedef {import("./probe-codex-core.mjs").ExitInfo} ExitInfo */
/** @typedef {import("./probe-codex-core.mjs").PendingRpc} PendingRpc */
/** @typedef {import("./probe-codex-core.mjs").ProbeStats} ProbeStats */
/**
 * @param {import("./probe-codex-core.mjs").ProbeOptions} options
 * @returns {void}
 */
export function validateInstall(options) {
  try {
    const stat = statSync(options.client);
    if (!stat.isFile()) {
      throw new Error("not a file");
    }
    accessSync(options.client, constants.X_OK);
  } catch (error) {
    throw new MissingInstallError(
      `SkyComputerUseClient executable is not runnable: ${options.client}`,
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }

  try {
    const stat = statSync(options.cwd);
    if (!stat.isDirectory()) {
      throw new Error("not a directory");
    }
  } catch (error) {
    throw new MissingInstallError(`Computer Use plugin cwd is not available: ${options.cwd}`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * @param {unknown} id
 * @returns {string}
 */
export function jsonRpcIdKey(id) {
  return typeof id === "string" ? `s:${id}` : `n:${String(id)}`;
}

export class JsonRpcStdioClient {
  /**
   * @param {{ command: string, cwd: string, protocolVersion: string, logger: import("./probe-codex-core.mjs").EventLogger, elicitationHandler: ElicitationHandler, shutdownTimeoutMs: number }} options
   */
  constructor({ command, cwd, protocolVersion, logger, elicitationHandler, shutdownTimeoutMs }) {
    this.command = command;
    this.cwd = cwd;
    this.protocolVersion = protocolVersion;
    this.logger = logger;
    this.elicitationHandler = elicitationHandler;
    this.shutdownTimeoutMs = shutdownTimeoutMs;
    this.args = ["mcp"];
    /** @type {import("node:child_process").ChildProcessByStdio<import("node:stream").Writable, import("node:stream").Readable, import("node:stream").Readable> | undefined} */
    this.child = undefined;
    this.nextId = 1;
    /** @type {Map<string, PendingRpc>} */
    this.pending = new Map();
    this.stdoutBuffer = "";
    this.stderrBuffer = "";
    this.exited = false;
    /** @type {ExitInfo | undefined} */
    this.exitInfo = undefined;
    /** @type {ProbeStats} */
    this.stats = {
      serverRequests: 0,
      notifications: 0,
      elicitations: 0,
      accepted: 0,
      declined: 0,
      canceled: 0,
      unknownServerRequests: 0,
      timeouts: 0,
    };
  }

  start() {
    if (this.child) {
      return;
    }
    this.logger.event("child.spawn", { command: this.command, args: this.args, cwd: this.cwd });
    this.child = spawn(this.command, this.args, {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");

    this.child.stdout.on("data", (/** @type {string} */ chunk) => this.handleStdout(chunk));
    this.child.stderr.on("data", (/** @type {string} */ chunk) => this.handleStderr(chunk));
    this.child.on("error", (error) => {
      this.logger.event("child.error", { message: error.message });
      this.rejectAllPending(
        new ChildExitError(`child process error: ${error.message}`, { error: error.message }),
      );
    });
    this.child.on("exit", (code, signal) => {
      this.exited = true;
      this.exitInfo = { code, signal };
      this.logger.event("child.exit", this.exitInfo);
      this.rejectAllPending(
        new ChildExitError(
          `child process exited while requests were pending: code=${String(code)} signal=${String(
            signal,
          )}`,
          this.exitInfo,
        ),
      );
    });
  }

  /**
   * @param {string} chunk
   * @returns {void}
   */
  handleStdout(chunk) {
    this.stdoutBuffer += chunk;
    let newlineIndex;
    while ((newlineIndex = this.stdoutBuffer.indexOf("\n")) !== -1) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line === "") {
        continue;
      }
      this.handleProtocolLine(line).catch((/** @type {unknown} */ error) => {
        this.logger.event("server.line_handler_error", {
          message: error instanceof Error ? error.message : String(error),
        });
      });
    }
  }

  /**
   * @param {string} chunk
   * @returns {void}
   */
  handleStderr(chunk) {
    this.stderrBuffer += chunk;
    let newlineIndex;
    while ((newlineIndex = this.stderrBuffer.indexOf("\n")) !== -1) {
      const line = this.stderrBuffer.slice(0, newlineIndex).trim();
      this.stderrBuffer = this.stderrBuffer.slice(newlineIndex + 1);
      if (line !== "") {
        this.logger.event("child.stderr", { line });
      }
    }
  }

  /**
   * @param {string} line
   * @returns {Promise<void>}
   */
  async handleProtocolLine(line) {
    let parsed;
    try {
      parsed = /** @type {unknown} */ (JSON.parse(line));
    } catch (error) {
      this.logger.event("server.stdout_non_json", {
        line: truncate(line, 500),
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    if (!isRecord(parsed)) {
      this.logger.event("server.invalid_jsonrpc", { message: parsed });
      return;
    }
    const message = parsed;

    if (hasOwn(message, "method")) {
      if (hasOwn(message, "id")) {
        this.stats.serverRequests += 1;
        this.logger.event("s->c request", {
          id: message.id,
          method: message.method,
          params: message.params,
        });
        await this.handleServerRequest(message);
      } else {
        this.stats.notifications += 1;
        this.logger.event("s->c notification", { method: message.method, params: message.params });
      }
      return;
    }

    if (hasOwn(message, "id")) {
      this.logger.event("s->c response", sanitizeForLog(message));
      const key = jsonRpcIdKey(message.id);
      const pending = this.pending.get(key);
      if (!pending) {
        this.logger.event("server.unmatched_response", { id: message.id });
        return;
      }
      this.pending.delete(key);
      clearTimeout(pending.timer);
      if (hasOwn(message, "error")) {
        pending.reject(new JsonRpcResponseError(pending.method, message.error));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    this.logger.event("server.invalid_jsonrpc", { message });
  }

  /**
   * @param {Record<string, unknown>} message
   * @returns {Promise<void>}
   */
  async handleServerRequest(message) {
    const { id, method, params } = message;
    try {
      if (method === "elicitation/create") {
        this.stats.elicitations += 1;
        const result = await this.elicitationHandler(params, { count: this.stats.elicitations });
        if (!["accept", "decline", "cancel"].includes(result.action)) {
          throw new Error(`elicitation handler returned invalid action: ${JSON.stringify(result)}`);
        }
        if (result.action === "accept") {
          this.stats.accepted += 1;
        }
        if (result.action === "decline") {
          this.stats.declined += 1;
        }
        if (result.action === "cancel") {
          this.stats.canceled += 1;
        }
        this.sendResponse(id, result);
        return;
      }

      if (method === "ping") {
        this.sendResponse(id, {});
        return;
      }

      if (method === "roots/list") {
        this.sendResponse(id, { roots: [] });
        return;
      }

      this.stats.unknownServerRequests += 1;
      this.logger.event("server.unknown_request_method", { id, method, params });
      this.sendError(
        id,
        JSON_RPC_ERROR.METHOD_NOT_FOUND,
        `Method not found by probe harness: ${String(method)}`,
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.event("server.request_handler_error", { id, method, message: detail });
      this.sendError(
        id,
        JSON_RPC_ERROR.INTERNAL_ERROR,
        `Probe harness failed to handle ${String(method)}: ${detail}`,
      );
    }
  }

  /**
   * @param {string} method
   * @param {unknown} params
   * @param {number} timeoutMs
   * @returns {Promise<unknown>}
   */
  request(method, params, timeoutMs) {
    if (!this.child || this.exited) {
      return Promise.reject(
        new ChildExitError(`cannot send ${method}; child is not running`, this.exitInfo),
      );
    }

    const id = this.nextId;
    this.nextId += 1;
    const message = { jsonrpc: "2.0", id, method, params };
    const key = jsonRpcIdKey(id);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        this.stats.timeouts += 1;
        const error = new TimeoutError(`${method} timed out after ${timeoutMs}ms`, {
          method,
          id,
          timeoutMs,
        });
        this.logger.event("timeout", error.details);
        reject(error);
      }, timeoutMs);

      this.pending.set(key, { method, resolve, reject, timer });
      this.sendObject(message, "c->s request");
    });
  }

  /**
   * @param {string} method
   * @param {Record<string, unknown>} [params]
   * @returns {void}
   */
  notify(method, params = {}) {
    if (!this.child || this.exited) {
      throw new ChildExitError(`cannot send ${method}; child is not running`, this.exitInfo);
    }
    this.sendObject({ jsonrpc: "2.0", method, params }, "c->s notification");
  }

  /**
   * @param {unknown} id
   * @param {unknown} result
   * @returns {void}
   */
  sendResponse(id, result) {
    this.sendObject({ jsonrpc: "2.0", id, result }, "c->s response");
  }

  /**
   * @param {unknown} id
   * @param {number} code
   * @param {string} message
   * @param {unknown} [data]
   * @returns {void}
   */
  sendError(id, code, message, data) {
    /** @type {Record<string, unknown>} */
    const error = { code, message };
    if (data !== undefined) {
      error.data = data;
    }
    this.sendObject({ jsonrpc: "2.0", id, error }, "c->s response_error");
  }

  /**
   * @param {Record<string, unknown>} message
   * @param {string} eventName
   * @returns {void}
   */
  sendObject(message, eventName) {
    if (this.child === undefined || !this.child.stdin.writable) {
      throw new ChildExitError("child stdin is not writable", this.exitInfo);
    }
    this.logger.event(eventName, message);
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  /**
   * @param {import("./probe-codex-core.mjs").ProbeError} error
   * @returns {void}
   */
  rejectAllPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  /**
   * @param {number} timeoutMs
   * @returns {Promise<unknown>}
   */
  async initialize(timeoutMs) {
    const result = await this.request(
      "initialize",
      {
        protocolVersion: this.protocolVersion,
        capabilities: {
          elicitation: { form: {} },
        },
        clientInfo: {
          name: "codex-computer-use-mcp-probe",
          version: VERSION,
        },
      },
      timeoutMs,
    );
    this.notify("notifications/initialized", {});
    return result;
  }

  /**
   * @param {number} timeoutMs
   * @returns {Promise<unknown>}
   */
  async listTools(timeoutMs) {
    return this.request("tools/list", {}, timeoutMs);
  }

  /**
   * @param {string} name
   * @param {Record<string, unknown>} args
   * @param {number} timeoutMs
   * @param {Record<string, unknown>} [requestMeta]
   * @returns {Promise<unknown>}
   */
  async callTool(name, args, timeoutMs, requestMeta) {
    /** @type {Record<string, unknown>} */
    const params = { name, arguments: args };
    if (requestMeta !== undefined) {
      params._meta = requestMeta;
    }
    return this.request("tools/call", params, timeoutMs);
  }

  /**
   * @returns {Promise<void>}
   */
  async close() {
    if (!this.child || this.exited) {
      return;
    }
    const child = this.child;
    /** @type {Promise<void>} */
    const closed = new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) {
          return;
        }
        done = true;
        resolve();
      };
      child.once("exit", finish);
      try {
        child.stdin.end();
      } catch {
        // ignore shutdown errors
      }
      const timer = setTimeout(() => {
        if (!this.exited) {
          this.logger.event("child.terminate", { signal: "SIGTERM" });
          child.kill("SIGTERM");
        }
        setTimeout(() => {
          if (!this.exited) {
            this.logger.event("child.kill", { signal: "SIGKILL" });
            child.kill("SIGKILL");
          }
          finish();
        }, 500).unref();
      }, this.shutdownTimeoutMs);
      timer.unref();
    });
    await closed;
  }
}
