#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants, statSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import {
  DEFAULT_BUNDLED_COMPUTER_USE_CLIENT,
  DEFAULT_COMPUTER_USE_CLIENT_CWD,
  VERSION,
} from "./macuse-utils.mjs";

const DEFAULT_CLIENT = DEFAULT_BUNDLED_COMPUTER_USE_CLIENT;
const DEFAULT_CWD = DEFAULT_COMPUTER_USE_CLIENT_CWD;
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";

const EXIT = Object.freeze({
  OK: 0,
  FAILURE: 1,
  USAGE: 2,
  MISSING_INSTALL: 3,
  TIMEOUT: 4,
  CHILD_EXIT: 5,
  TOOL_ERROR: 7,
});

const JSON_RPC_ERROR = Object.freeze({
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
});

/**
 * @typedef {{ command: string, help?: boolean, client: string, cwd: string, protocolVersion: string, startupTimeoutMs: number, listTimeoutMs: number, toolTimeoutMs: number, elicitationTimeoutMs: number | undefined, shutdownTimeoutMs: number, logTimeoutMs: number, maxLogLines: number, app: string | undefined, approval: string | undefined, since: string | undefined, withTurnMetadata: boolean }} ProbeOptions
 * @typedef {{ method: string, resolve: (result: unknown) => void, reject: (error: ProbeError) => void, timer: ReturnType<typeof setTimeout> }} PendingRpc
 * @typedef {{ action: "accept" | "decline" | "cancel", content?: unknown }} ElicitationDecision
 * @typedef {(params: unknown, context: { count: number }) => Promise<ElicitationDecision>} ElicitationHandler
 * @typedef {{ serverRequests: number, notifications: number, elicitations: number, accepted: number, declined: number, canceled: number, unknownServerRequests: number, timeouts: number }} ProbeStats
 * @typedef {{ code: number | null, signal: NodeJS.Signals | null }} ExitInfo
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

const SECRET_KEY_RE = /(?:secret|token|password|passwd|authorization|api[-_]?key|cookie|session)/i;
const HEAVY_VALUE_RE = /(?:image|screenshot|bitmap|base64|data|blob|bytes|screen|framebuffer)/i;

class ProbeError extends Error {
  /**
   * @param {string} message
   * @param {number} [exitCode]
   * @param {unknown} [details]
   */
  constructor(message, exitCode = EXIT.FAILURE, details) {
    super(message);
    this.name = this.constructor.name;
    this.exitCode = exitCode;
    this.details = details;
  }
}

class UsageError extends ProbeError {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message, EXIT.USAGE);
  }
}

class TimeoutError extends ProbeError {
  /**
   * @param {string} message
   * @param {unknown} [details]
   */
  constructor(message, details) {
    super(message, EXIT.TIMEOUT, details);
  }
}

class MissingInstallError extends ProbeError {
  /**
   * @param {string} message
   * @param {unknown} [details]
   */
  constructor(message, details) {
    super(message, EXIT.MISSING_INSTALL, details);
  }
}

class ChildExitError extends ProbeError {
  /**
   * @param {string} message
   * @param {unknown} [details]
   */
  constructor(message, details) {
    super(message, EXIT.CHILD_EXIT, details);
  }
}

class ToolResultError extends ProbeError {
  /**
   * @param {string} message
   * @param {unknown} [details]
   */
  constructor(message, details) {
    super(message, EXIT.TOOL_ERROR, details);
  }
}

class JsonRpcResponseError extends ProbeError {
  /**
   * @param {string} method
   * @param {unknown} error
   */
  constructor(method, error) {
    const record = isRecord(error) ? error : undefined;
    const code = record?.code;
    const detail = record?.message;
    const codeText =
      typeof code === "number" || typeof code === "string" ? String(code) : "unknown";
    const detailText = typeof detail === "string" ? detail : "unknown error";
    super(`${method} failed with JSON-RPC error ${codeText}: ${detailText}`, EXIT.FAILURE, error);
    this.method = method;
    this.rpcError = error;
  }
}

/**
 * @param {unknown} value
 * @param {string} key
 * @returns {boolean}
 */
function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/**
 * @param {unknown} value
 * @param {number} [max]
 * @returns {unknown}
 */
function truncate(value, max = 220) {
  if (typeof value !== "string") return value;
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…[${value.length} chars]`;
}

/**
 * @param {unknown} value
 * @param {string} [key]
 * @param {number} [depth]
 * @returns {unknown}
 */
function sanitizeForLog(value, key = "", depth = 0) {
  if (SECRET_KEY_RE.test(key)) return "[redacted]";
  if (HEAVY_VALUE_RE.test(key)) return `[redacted:${typeof value}]`;
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return truncate(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object") return `[${typeof value}]`;
  if (depth >= 5) return `[${Array.isArray(value) ? "array" : "object"}]`;

  if (Array.isArray(value)) {
    const items = value.slice(0, 8).map((item) => sanitizeForLog(item, key, depth + 1));
    if (value.length > items.length) items.push(`… ${value.length - items.length} more`);
    return items;
  }

  if (key === "content" && isRecord(value) && Array.isArray(value.content)) {
    return summarizeContentBlocks(value.content);
  }
  if (!isRecord(value)) return sanitizeForLog(value);

  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    if (childKey === "content" && Array.isArray(childValue)) {
      out[childKey] = summarizeContentBlocks(childValue);
    } else if (
      childKey === "structuredContent" &&
      childValue !== null &&
      childValue !== undefined &&
      typeof childValue === "object"
    ) {
      out[childKey] = { keys: Object.keys(childValue).slice(0, 20), redacted: true };
    } else {
      out[childKey] = sanitizeForLog(childValue, childKey, depth + 1);
    }
  }
  return out;
}

/**
 * @param {unknown} blocks
 * @returns {unknown}
 */
function summarizeContentBlocks(blocks) {
  if (!Array.isArray(blocks)) return sanitizeForLog(blocks);
  return blocks
    .slice(0, 8)
    .map((block) => {
      if (block === null || block === undefined || typeof block !== "object")
        return sanitizeForLog(block);
      const record = isRecord(block) ? block : undefined;
      /** @type {Record<string, unknown>} */
      const summary = { type: record?.type ?? "unknown" };
      if (typeof record?.text === "string") summary.textLength = record.text.length;
      if (typeof record?.mimeType === "string") summary.mimeType = record.mimeType;
      if (typeof record?.uri === "string") summary.uri = truncate(record.uri, 120);
      for (const [key, value] of Object.entries(record ?? {})) {
        if (key === "type" || key === "text" || key === "mimeType" || key === "uri") continue;
        if (HEAVY_VALUE_RE.test(key)) {
          summary[key] = `[redacted:${typeof value}]`;
        }
      }
      return summary;
    })
    .concat(blocks.length > 8 ? [`… ${blocks.length - 8} more`] : []);
}

/**
 * @param {unknown} details
 * @returns {string}
 */
function formatDetails(details) {
  if (details === undefined) return "";
  return ` ${JSON.stringify(sanitizeForLog(details))}`;
}

class EventLogger {
  /**
   * @param {{ quiet?: boolean }} [options]
   */
  constructor({ quiet = false } = {}) {
    this.quiet = quiet;
  }

  /**
   * @param {string} event
   * @param {unknown} [details]
   * @returns {void}
   */
  event(event, details) {
    if (this.quiet) return;
    const timestamp = new Date().toISOString();
    process.stderr.write(`${timestamp} ${event}${formatDetails(details)}\n`);
  }
}

function printHelp() {
  process.stdout.write(`Codex Computer Use MCP probe harness ${VERSION}

Usage:
  node tools/probe-codex-computer-use-mcp.mjs discover [options]
  node tools/probe-codex-computer-use-mcp.mjs apps [options]
  node tools/probe-codex-computer-use-mcp.mjs deny --app <app> [options]
  node tools/probe-codex-computer-use-mcp.mjs state --app <app> --approval interactive|accept-once|deny [options]
  node tools/probe-codex-computer-use-mcp.mjs logs --since <duration> [options]

Modes:
  discover
      Launch SkyComputerUseClient mcp, initialize MCP, run tools/list, and print
      serverInfo plus a compact tool/schema summary.

  apps
      Call the read-only list_apps tool. This exercises the service-backed
      Computer Use path without approving an app-specific get_app_state session.

  deny --app <app>
      Call get_app_state for the app while automatically declining every
      elicitation/create request. This is the safest regression probe for the
      app-approval denial path.

  state --app <app> --approval interactive|accept-once|deny
      Call get_app_state for the app with explicit elicitation handling.
      interactive  prompts on this terminal for accept, decline, or cancel.
      accept-once  accepts the first elicitation only, then declines any later
                   elicitation automatically.
      deny         declines every elicitation automatically.

  logs --since <duration>
      Print filtered macOS unified logs for SkyComputerUseClient and
      SkyComputerUseService. Examples: 30s, 5m, 1h.

Options:
  --client <path>                SkyComputerUseClient executable.
                                 Default: ${DEFAULT_CLIENT}
                                 Env: CODEX_CU_CLIENT
  --cwd <path>                   Plugin cache cwd for the MCP server.
                                 Default: ${DEFAULT_CWD}
                                 Env: CODEX_CU_CWD
  --protocol-version <version>   MCP protocol version for initialize.
                                 Default: ${DEFAULT_PROTOCOL_VERSION}
  --startup-timeout-ms <ms>      initialize timeout. Default: 10000
  --list-timeout-ms <ms>         tools/list timeout. Default: 10000
  --tool-timeout-ms <ms>         service-backed tool call timeout. Default: 45000
  --elicitation-timeout-ms <ms>  interactive prompt timeout. Default: tool timeout
  --with-turn-metadata           Add Codex-like _meta.x-codex-turn-metadata to
                                 service-backed tools/call requests.
  --shutdown-timeout-ms <ms>     child shutdown grace period. Default: 2000
  --log-timeout-ms <ms>          logs command timeout. Default: 15000
  --max-log-lines <n>            max lines printed by logs mode. Default: 300
  -h, --help                     Show this help.

Exit codes:
  0  success
  1  MCP/probe failure
  2  usage error
  3  missing client executable or plugin cwd
  4  timeout
  5  child process exited or failed unexpectedly
  7  tool returned an error or an expected denial path was not observed

Safety:
  This harness only lists tools, calls list_apps/get_app_state, and handles
  app-approval elicitation. It does not click, type, drag, scroll, or mutate GUI state.
  Event logs redact secret-like fields and summarize tool content instead of
  dumping app state text or screenshots.

Examples:
  node tools/probe-codex-computer-use-mcp.mjs discover
  node tools/probe-codex-computer-use-mcp.mjs apps --tool-timeout-ms 90000
  node tools/probe-codex-computer-use-mcp.mjs deny --app Finder
  node tools/probe-codex-computer-use-mcp.mjs state --app "Activity Monitor" --approval interactive
  node tools/probe-codex-computer-use-mcp.mjs state --app "Activity Monitor" --approval accept-once --tool-timeout-ms 90000
  node tools/probe-codex-computer-use-mcp.mjs state --app "Activity Monitor" --approval accept-once --with-turn-metadata
  node tools/probe-codex-computer-use-mcp.mjs logs --since 5m
`);
}

/**
 * @param {string[]} argv
 * @returns {string[]}
 */
function normalizeArgTokens(argv) {
  const tokens = [];
  for (const arg of argv) {
    if (arg.startsWith("--") && arg.includes("=")) {
      const [flag = "", ...rest] = arg.split("=");
      tokens.push(flag, rest.join("="));
    } else {
      tokens.push(arg);
    }
  }
  return tokens;
}

/**
 * @param {string} name
 * @param {string | undefined} value
 * @returns {number}
 */
function parsePositiveInt(name, value) {
  if (value === undefined || value === "")
    throw new UsageError(`${name} requires a positive integer`);
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0)
    throw new UsageError(`${name} must be a positive integer, got ${value}`);
  return n;
}

/**
 * @param {string[]} argv
 * @returns {ProbeOptions | { help: true }}
 */
function parseArgs(argv) {
  const tokens = normalizeArgTokens(argv);
  if (tokens.length === 0 || tokens.includes("--help") || tokens.includes("-h")) {
    return { help: true };
  }

  const commands = new Set(["discover", "apps", "deny", "state", "logs"]);
  const valueFlags = new Set([
    "--client",
    "--cwd",
    "--protocol-version",
    "--startup-timeout-ms",
    "--list-timeout-ms",
    "--tool-timeout-ms",
    "--elicitation-timeout-ms",
    "--shutdown-timeout-ms",
    "--log-timeout-ms",
    "--max-log-lines",
    "--app",
    "--approval",
    "--since",
  ]);
  const booleanFlags = new Set(["--with-turn-metadata"]);
  let commandIndex = -1;
  for (let i = 0; i < tokens.length; i += 1) {
    const arg = tokens[i] ?? "";
    if (arg.startsWith("-")) {
      if (valueFlags.has(arg)) i += 1;
      if (booleanFlags.has(arg)) continue;
      continue;
    }
    if (commands.has(arg)) {
      commandIndex = i;
      break;
    }
  }
  if (commandIndex === -1) throw new UsageError("missing mode; use --help for usage");

  const command = tokens[commandIndex] ?? "";
  const rest = tokens.slice(0, commandIndex).concat(tokens.slice(commandIndex + 1));
  const clientEnv = process.env.CODEX_CU_CLIENT;
  const cwdEnv = process.env.CODEX_CU_CWD;
  /** @type {ProbeOptions} */
  const options = {
    command,
    client: clientEnv !== undefined && clientEnv !== "" ? clientEnv : DEFAULT_CLIENT,
    cwd: cwdEnv !== undefined && cwdEnv !== "" ? cwdEnv : DEFAULT_CWD,
    protocolVersion: DEFAULT_PROTOCOL_VERSION,
    startupTimeoutMs: 10_000,
    listTimeoutMs: 10_000,
    toolTimeoutMs: 45_000,
    elicitationTimeoutMs: undefined,
    shutdownTimeoutMs: 2_000,
    logTimeoutMs: 15_000,
    maxLogLines: 300,
    app: undefined,
    approval: undefined,
    since: undefined,
    withTurnMetadata: false,
  };

  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i] ?? "";
    const next = () => {
      i += 1;
      const value = rest[i] ?? "";
      if (i >= rest.length || value.startsWith("--"))
        throw new UsageError(`${flag} requires a value`);
      return value;
    };

    switch (flag) {
      case "--client":
        options.client = next();
        break;
      case "--cwd":
        options.cwd = next();
        break;
      case "--protocol-version":
        options.protocolVersion = next();
        break;
      case "--startup-timeout-ms":
        options.startupTimeoutMs = parsePositiveInt(flag, next());
        break;
      case "--list-timeout-ms":
        options.listTimeoutMs = parsePositiveInt(flag, next());
        break;
      case "--tool-timeout-ms":
        options.toolTimeoutMs = parsePositiveInt(flag, next());
        break;
      case "--elicitation-timeout-ms":
        options.elicitationTimeoutMs = parsePositiveInt(flag, next());
        break;
      case "--shutdown-timeout-ms":
        options.shutdownTimeoutMs = parsePositiveInt(flag, next());
        break;
      case "--log-timeout-ms":
        options.logTimeoutMs = parsePositiveInt(flag, next());
        break;
      case "--max-log-lines":
        options.maxLogLines = parsePositiveInt(flag, next());
        break;
      case "--app":
        options.app = next();
        break;
      case "--approval":
        options.approval = next();
        break;
      case "--since":
        options.since = next();
        break;
      case "--with-turn-metadata":
        options.withTurnMetadata = true;
        break;
      default:
        if (flag.startsWith("-")) throw new UsageError(`unknown option: ${flag}`);
        throw new UsageError(`unexpected argument: ${flag}`);
    }
  }

  if (!["discover", "apps", "deny", "state", "logs"].includes(command)) {
    throw new UsageError(`unknown mode: ${command}`);
  }

  if (command === "deny") {
    if (options.app === undefined || options.app === "")
      throw new UsageError("deny requires --app <app>");
    options.approval = "deny";
  }

  if (command === "state") {
    if (options.app === undefined || options.app === "")
      throw new UsageError("state requires --app <app>");
    if (options.approval === undefined || options.approval === "")
      throw new UsageError("state requires --approval interactive|accept-once|deny");
    if (!["interactive", "accept-once", "deny"].includes(options.approval)) {
      throw new UsageError(`unsupported approval mode: ${options.approval}`);
    }
  }

  if (command === "logs") {
    if (options.since === undefined || options.since === "")
      throw new UsageError("logs requires --since <duration>, for example --since 5m");
    if (!/^\d+(?:\.\d+)?[smhd]$/.test(options.since)) {
      throw new UsageError("--since must look like 30s, 5m, 1h, or 1d");
    }
  }

  options.elicitationTimeoutMs ??= options.toolTimeoutMs;
  return options;
}

/**
 * @param {ProbeOptions} options
 * @returns {void}
 */
function validateInstall(options) {
  try {
    const stat = statSync(options.client);
    if (!stat.isFile()) throw new Error("not a file");
    accessSync(options.client, constants.X_OK);
  } catch (error) {
    throw new MissingInstallError(
      `SkyComputerUseClient executable is not runnable: ${options.client}`,
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }

  try {
    const stat = statSync(options.cwd);
    if (!stat.isDirectory()) throw new Error("not a directory");
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
function jsonRpcIdKey(id) {
  return typeof id === "string" ? `s:${id}` : `n:${String(id)}`;
}

class JsonRpcStdioClient {
  /**
   * @param {{ command: string, cwd: string, protocolVersion: string, logger: EventLogger, elicitationHandler: ElicitationHandler, shutdownTimeoutMs: number }} options
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
    if (this.child) return;
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
      if (line === "") continue;
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
      if (line !== "") this.logger.event("child.stderr", { line });
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
        if (result.action === "accept") this.stats.accepted += 1;
        if (result.action === "decline") this.stats.declined += 1;
        if (result.action === "cancel") this.stats.canceled += 1;
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
    if (data !== undefined) error.data = data;
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
   * @param {ProbeError} error
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
    if (requestMeta !== undefined) params._meta = requestMeta;
    return this.request("tools/call", params, timeoutMs);
  }

  /**
   * @returns {Promise<void>}
   */
  async close() {
    if (!this.child || this.exited) return;
    const child = this.child;
    /** @type {Promise<void>} */
    const closed = new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
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

/**
 * @param {{ mode: string, elicitationTimeoutMs: number, logger: EventLogger }} options
 * @returns {ElicitationHandler}
 */
function createElicitationHandler({ mode, elicitationTimeoutMs, logger }) {
  let acceptedOnce = false;
  return async (params, context) => {
    const message = isRecord(params) ? params.message : undefined;
    if (mode === "deny") {
      logger.event("elicitation.auto_decision", {
        count: context.count,
        action: "decline",
        message,
      });
      return { action: "decline" };
    }

    if (mode === "accept-once") {
      if (!acceptedOnce) {
        acceptedOnce = true;
        logger.event("elicitation.auto_decision", {
          count: context.count,
          action: "accept",
          message,
        });
        return { action: "accept", content: {} };
      }
      logger.event("elicitation.accept_once_exhausted", {
        count: context.count,
        action: "decline",
        message,
      });
      return { action: "decline" };
    }

    if (mode === "interactive") {
      return promptForElicitation(params, { elicitationTimeoutMs, logger });
    }

    throw new Error(`unsupported elicitation mode: ${mode}`);
  };
}

/**
 * @param {unknown} params
 * @param {{ elicitationTimeoutMs: number, logger: EventLogger }} context
 * @returns {Promise<ElicitationDecision>}
 */
async function promptForElicitation(params, { elicitationTimeoutMs, logger }) {
  const record = isRecord(params) ? params : undefined;
  process.stderr.write("\nMCP elicitation/create request\n");
  const message = typeof record?.message === "string" ? record.message : "(none)";
  process.stderr.write(`Message: ${message}\n`);
  process.stderr.write(
    `Requested schema: ${JSON.stringify(sanitizeForLog(record?.requestedSchema ?? {}))}\n`,
  );
  process.stderr.write(
    'Actions: accept, decline, cancel. Use `accept {"field":"value"}` to provide JSON content if needed.\n',
  );

  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    /** @type {Promise<never>} */
    const timeout = new Promise((_, reject) => {
      setTimeout(() => {
        reject(new TimeoutError(`elicitation prompt timed out after ${elicitationTimeoutMs}ms`));
      }, elicitationTimeoutMs);
    });
    const answer = await Promise.race([rl.question("Elicitation response [decline]: "), timeout]);
    const trimmed = answer.trim();
    if (trimmed === "" || /^d(?:ecline)?$/i.test(trimmed)) {
      logger.event("elicitation.operator_decision", { action: "decline" });
      return { action: "decline" };
    }
    if (/^c(?:ancel)?$/i.test(trimmed)) {
      logger.event("elicitation.operator_decision", { action: "cancel" });
      return { action: "cancel" };
    }
    if (/^a(?:ccept)?(?:\s|$)/i.test(trimmed)) {
      const jsonPart = trimmed.replace(/^a(?:ccept)?/i, "").trim();
      /** @type {Record<string, unknown>} */
      let content = {};
      if (jsonPart !== "") {
        try {
          const parsed = /** @type {unknown} */ (JSON.parse(jsonPart));
          if (isRecord(parsed)) content = parsed;
        } catch (error) {
          throw new Error(
            `invalid accept JSON content: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          );
        }
      }
      logger.event("elicitation.operator_decision", {
        action: "accept",
        contentKeys: Object.keys(content),
      });
      return { action: "accept", content };
    }
    throw new Error(`unknown elicitation response: ${trimmed}`);
  } finally {
    rl.close();
  }
}

/**
 * @param {unknown} schema
 * @returns {string}
 */
function summarizeJsonSchemaType(schema) {
  if (!isRecord(schema)) return "unknown";
  if (typeof schema.type === "string") return schema.type;
  if (Array.isArray(schema.type)) return schema.type.join("|");
  if (Array.isArray(schema.anyOf)) return schema.anyOf.map(summarizeJsonSchemaType).join("|");
  if (Array.isArray(schema.oneOf)) return schema.oneOf.map(summarizeJsonSchemaType).join("|");
  if (schema.const !== undefined) return `const(${JSON.stringify(schema.const)})`;
  if (Array.isArray(schema.enum))
    return `enum(${schema.enum.slice(0, 6).join("|")}${schema.enum.length > 6 ? "|…" : ""})`;
  return "unknown";
}

/**
 * @param {unknown} schema
 * @returns {string}
 */
function summarizeInputSchema(schema) {
  if (!isRecord(schema)) return "(no schema)";
  const props = isRecord(schema.properties) ? schema.properties : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const names = Object.keys(props);
  if (names.length === 0) return "(no input properties)";
  return names
    .map(
      (name) => `${name}${required.has(name) ? "*" : ""}:${summarizeJsonSchemaType(props[name])}`,
    )
    .join(", ");
}

/**
 * @param {unknown} initResult
 * @param {unknown} toolsResult
 * @returns {void}
 */
function printDiscoverSummary(initResult, toolsResult) {
  const init = isRecord(initResult) ? initResult : undefined;
  const tools = isRecord(toolsResult) && Array.isArray(toolsResult.tools) ? toolsResult.tools : [];
  process.stdout.write("Server info:\n");
  process.stdout.write(`${JSON.stringify(sanitizeForLog(init?.serverInfo ?? null), null, 2)}\n`);
  const hasProtocolVersion = Boolean(init?.protocolVersion);
  if (hasProtocolVersion)
    process.stdout.write(`Protocol version: ${String(init?.protocolVersion)}\n`);
  const capabilities = isRecord(init?.capabilities) ? init.capabilities : undefined;
  if (capabilities !== undefined)
    process.stdout.write(
      `Server capability keys: ${
        Object.keys(capabilities).join(", ") !== ""
          ? Object.keys(capabilities).join(", ")
          : "(none)"
      }\n`,
    );
  process.stdout.write(`\nTools (${tools.length}):\n`);
  for (const tool of tools) {
    const record = isRecord(tool) ? tool : undefined;
    const described = Boolean(record?.description);
    const description = described ? ` - ${String(truncate(record?.description, 120))}` : "";
    process.stdout.write(`- ${String(record?.name)}${description}\n`);
    process.stdout.write(`  input: ${summarizeInputSchema(record?.inputSchema)}\n`);
  }
}

/**
 * @param {unknown} result
 * @returns {{ isError: boolean, content: unknown, structuredContentKeys: string[], resultKeys: string[] }}
 */
function summarizeToolResult(result) {
  const record = isRecord(result) ? result : undefined;
  const structured = record?.structuredContent;
  return {
    isError: Boolean(record?.isError),
    content: summarizeContentBlocks(record?.content ?? []),
    structuredContentKeys:
      structured !== null && structured !== undefined && typeof structured === "object"
        ? Object.keys(structured).slice(0, 20)
        : [],
    resultKeys:
      record !== undefined
        ? Object.keys(record).filter((key) => !["content", "structuredContent"].includes(key))
        : [],
  };
}

/**
 * @param {ProbeOptions} options
 * @returns {Record<string, unknown> | undefined}
 */
function buildRequestMeta(options) {
  if (!options.withTurnMetadata) return;
  const id = randomUUID().replaceAll("-", "").slice(0, 12);
  return {
    "x-codex-turn-metadata": {
      session_id: `probe-session-${id}`,
      thread_id: `probe-thread-${id}`,
      turn_id: `probe-turn-${id}`,
      model: "external-probe",
      reasoning_effort: "medium",
      turn_started_at_unix_ms: Date.now(),
    },
  };
}

/**
 * @param {string} toolName
 * @param {unknown} result
 * @param {ProbeStats} stats
 * @returns {void}
 */
function printGenericToolResultSummary(toolName, result, stats) {
  process.stdout.write(`${toolName} result:\n`);
  process.stdout.write(`${JSON.stringify(summarizeToolResult(result), null, 2)}\n`);
  process.stdout.write(
    `Elicitation stats: ${JSON.stringify({
      seen: stats.elicitations,
      accepted: stats.accepted,
      declined: stats.declined,
      canceled: stats.canceled,
      unknownServerRequests: stats.unknownServerRequests,
    })}\n`,
  );
}

/**
 * @param {string} app
 * @param {unknown} result
 * @param {ProbeStats} stats
 * @returns {void}
 */
function printToolResultSummary(app, result, stats) {
  process.stdout.write(`get_app_state result for ${app}:\n`);
  process.stdout.write(`${JSON.stringify(summarizeToolResult(result), null, 2)}\n`);
  process.stdout.write(
    `Elicitation stats: ${JSON.stringify({
      seen: stats.elicitations,
      accepted: stats.accepted,
      declined: stats.declined,
      canceled: stats.canceled,
      unknownServerRequests: stats.unknownServerRequests,
    })}\n`,
  );
}

/**
 * @template T
 * @param {ProbeOptions} options
 * @param {string} approvalMode
 * @param {(client: JsonRpcStdioClient) => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withMcpClient(options, approvalMode, fn) {
  validateInstall(options);
  const logger = new EventLogger();
  const client = new JsonRpcStdioClient({
    command: options.client,
    cwd: options.cwd,
    protocolVersion: options.protocolVersion,
    logger,
    shutdownTimeoutMs: options.shutdownTimeoutMs,
    elicitationHandler: createElicitationHandler({
      mode: approvalMode,
      elicitationTimeoutMs: options.elicitationTimeoutMs ?? options.toolTimeoutMs,
      logger,
    }),
  });

  /** @type {(() => void) | undefined} */
  let signalHandler;
  try {
    client.start();
    signalHandler = () => {
      logger.event("process.signal", { signal: "SIGINT" });
      client
        .close()
        .finally(() => process.exit(130))
        .catch(() => null);
    };
    process.once("SIGINT", signalHandler);
    const result = await fn(client);
    return result;
  } finally {
    if (signalHandler !== undefined) process.off("SIGINT", signalHandler);
    await client.close();
  }
}

/**
 * @param {ProbeOptions} options
 * @returns {Promise<number>}
 */
async function runDiscover(options) {
  await withMcpClient(options, "deny", async (client) => {
    const initResult = await client.initialize(options.startupTimeoutMs);
    const toolsResult = await client.listTools(options.listTimeoutMs);
    printDiscoverSummary(initResult, toolsResult);
  });
  return EXIT.OK;
}

/**
 * @param {ProbeOptions} options
 * @returns {Promise<number>}
 */
async function runApps(options) {
  const result = await withMcpClient(options, "deny", async (client) => {
    await client.initialize(options.startupTimeoutMs);
    const toolResult = await client.callTool(
      "list_apps",
      {},
      options.toolTimeoutMs,
      buildRequestMeta(options),
    );
    printGenericToolResultSummary("list_apps", toolResult, client.stats);
    return { toolResult, stats: client.stats };
  });

  const failed = isRecord(result.toolResult) && Boolean(result.toolResult.isError);
  if (failed) {
    throw new ToolResultError(
      "list_apps returned an MCP tool error",
      summarizeToolResult(result.toolResult),
    );
  }

  return EXIT.OK;
}

/**
 * @param {ProbeOptions} options
 * @returns {Promise<number>}
 */
async function runState(options) {
  const result = await withMcpClient(options, options.approval ?? "deny", async (client) => {
    await client.initialize(options.startupTimeoutMs);
    const toolResult = await client.callTool(
      "get_app_state",
      { app: options.app },
      options.toolTimeoutMs,
      buildRequestMeta(options),
    );
    printToolResultSummary(options.app ?? "", toolResult, client.stats);
    return { toolResult, stats: client.stats };
  });

  if (options.approval === "deny") {
    if (result.stats.declined > 0) {
      process.stdout.write(
        "Safe denial path exercised: at least one elicitation/create request was declined.\n",
      );
      return EXIT.OK;
    }
    throw new ToolResultError(
      "deny mode did not observe an elicitation/create request to decline; the app may already be approved or the call failed before app approval",
      {
        app: options.app,
        stats: result.stats,
      },
    );
  }

  const failed = isRecord(result.toolResult) && Boolean(result.toolResult.isError);
  if (failed) {
    throw new ToolResultError(
      "get_app_state returned an MCP tool error",
      summarizeToolResult(result.toolResult),
    );
  }

  return EXIT.OK;
}

/**
 * @param {ProbeOptions} options
 * @returns {Promise<number>}
 */
async function runLogs(options) {
  if (process.platform !== "darwin") {
    throw new ProbeError("logs mode requires macOS unified logging (`log show`)", EXIT.FAILURE);
  }

  const predicate =
    'process == "SkyComputerUseClient" OR process == "SkyComputerUseService" OR eventMessage CONTAINS[c] "SkyComputerUseClient" OR eventMessage CONTAINS[c] "SkyComputerUseService"';
  const args = [
    "show",
    "--style",
    "compact",
    "--last",
    options.since ?? "",
    "--predicate",
    predicate,
    "--info",
    "--debug",
  ];
  const logger = new EventLogger();
  logger.event("logs.spawn", { command: "log", args, maxLogLines: options.maxLogLines });

  const child = spawn("log", args, { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  let stdoutBuffer = "";
  let stderrBuffer = "";
  let stdoutLines = 0;
  let stderrLines = 0;
  let truncated = false;

  /**
   * @param {string} line
   * @param {"stdout" | "stderr"} stream
   * @returns {void}
   */
  const printLine = (line, stream) => {
    if (stream === "stdout") {
      if (stdoutLines < options.maxLogLines) {
        process.stdout.write(`${line}\n`);
      } else if (!truncated) {
        truncated = true;
        process.stdout.write(
          `… log output truncated after ${options.maxLogLines} lines; rerun with --max-log-lines for more.\n`,
        );
      }
      stdoutLines += 1;
    } else {
      process.stderr.write(`${line}\n`);
      stderrLines += 1;
    }
  };

  child.stdout.on("data", (/** @type {string} */ chunk) => {
    stdoutBuffer += chunk;
    let newlineIndex;
    while ((newlineIndex = stdoutBuffer.indexOf("\n")) !== -1) {
      const line = stdoutBuffer.slice(0, newlineIndex);
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      printLine(line, "stdout");
    }
  });
  child.stderr.on("data", (/** @type {string} */ chunk) => {
    stderrBuffer += chunk;
    let newlineIndex;
    while ((newlineIndex = stderrBuffer.indexOf("\n")) !== -1) {
      const line = stderrBuffer.slice(0, newlineIndex);
      stderrBuffer = stderrBuffer.slice(newlineIndex + 1);
      printLine(line, "stderr");
    }
  });

  /** @type {Promise<ExitInfo>} */
  const exitPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(
        new TimeoutError(`log show timed out after ${options.logTimeoutMs}ms`, {
          since: options.since,
        }),
      );
    }, options.logTimeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new ProbeError(`failed to run log show: ${error.message}`, EXIT.FAILURE));
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
  const exitInfo = await exitPromise;

  if (stdoutBuffer !== "") printLine(stdoutBuffer, "stdout");
  if (stderrBuffer !== "") printLine(stderrBuffer, "stderr");

  logger.event("logs.exit", { ...exitInfo, stdoutLines, stderrLines, truncated });
  if (exitInfo.code !== 0) {
    throw new ProbeError(
      `log show failed with code=${String(exitInfo.code)} signal=${String(exitInfo.signal)}`,
      EXIT.FAILURE,
    );
  }
  return EXIT.OK;
}

/**
 * @param {unknown} error
 * @param {ProbeOptions | { help: true } | undefined} options
 * @returns {void}
 */
function printNextDiagnostics(error, options) {
  const script = "tools/probe-codex-computer-use-mcp.mjs";
  const parsed =
    options !== undefined && "command" in options && typeof options.command === "string"
      ? options
      : undefined;
  process.stderr.write("\nNext diagnostics:\n");
  if (parsed?.command !== "logs") {
    process.stderr.write(`  node ${script} logs --since 5m\n`);
    process.stderr.write(
      `  node ${script} discover --client ${shellQuote(parsed?.client ?? DEFAULT_CLIENT)} --cwd ${shellQuote(parsed?.cwd ?? DEFAULT_CWD)}\n`,
    );
  }
  if (error instanceof TimeoutError) {
    /**
     * @returns {string}
     */
    const retryCommand = () => {
      if (parsed?.command === "state" || parsed?.command === "deny")
        return `${parsed.command} --app ${shellQuote(parsed.app)}${
          parsed.command === "state" ? ` --approval ${String(parsed.approval)}` : ""
        } --tool-timeout-ms 90000`;
      if (parsed?.command === "apps") return "apps --tool-timeout-ms 90000";
      return "discover --startup-timeout-ms 30000 --list-timeout-ms 30000";
    };
    process.stderr.write(`  node ${script} ${retryCommand()}\n`);
  }
  if (error instanceof MissingInstallError) {
    process.stderr.write(
      '  find "$CODEX_HOME/plugins/cache/openai-bundled/computer-use" -maxdepth 3 -name .mcp.json -print\n',
    );
    process.stderr.write(
      '  find "$CODEX_HOME/computer-use" -iname SkyComputerUseClient -type f -print\n',
    );
  }
  process.stderr.write(`  ${shellQuote(parsed?.client ?? DEFAULT_CLIENT)} --help\n`);
  process.stderr.write(`  ${shellQuote(parsed?.client ?? DEFAULT_CLIENT)} help mcp\n`);
}

/**
 * @param {string | undefined} value
 * @returns {string}
 */
function shellQuote(value) {
  const s = value ?? "";
  if (/^[A-Za-z0-9_./:=+-]+$/.test(s)) return s;
  return `'${s.replaceAll("'", "'\\''")}'`;
}

/**
 * @returns {Promise<number>}
 */
async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help === true) {
    printHelp();
    return EXIT.OK;
  }

  switch (options.command) {
    case "discover":
      return runDiscover(options);
    case "apps":
      return runApps(options);
    case "deny":
    case "state":
      return runState(options);
    case "logs":
      return runLogs(options);
    default:
      throw new UsageError(`unknown mode: ${options.command}`);
  }
}

try {
  const code = await main();
  process.exitCode = code;
} catch (error) {
  const probeError = error instanceof ProbeError ? error : undefined;
  const exitCode = probeError !== undefined ? probeError.exitCode : EXIT.FAILURE;
  process.stderr.write(`ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
  const detailed = probeError !== undefined && Boolean(probeError.details);
  if (detailed)
    process.stderr.write(
      `Details: ${JSON.stringify(sanitizeForLog(probeError.details), null, 2)}\n`,
    );
  if (!(error instanceof UsageError)) {
    /** @type {ProbeOptions | { help: true } | undefined} */
    let parsedOptions;
    try {
      parsedOptions = parseArgs(process.argv.slice(2));
    } catch {
      parsedOptions = undefined;
    }
    printNextDiagnostics(error, parsedOptions);
  } else {
    process.stderr.write("Run with --help for usage.\n");
  }
  process.exitCode = exitCode;
}
