import { JsonRpcStdioClient, validateInstall } from "./probe-codex-client.mjs";
import { createElicitationHandler } from "./probe-codex-elicitation.mjs";
import {
  buildRequestMeta,
  printDiscoverSummary,
  printGenericToolResultSummary,
  printToolResultSummary,
  summarizeToolResult,
} from "./probe-codex-report.mjs";
import { spawn } from "node:child_process";
import { shellQuote } from "./probe-codex-args.mjs";
import {
  DEFAULT_CLIENT,
  DEFAULT_CWD,
  EventLogger,
  EXIT,
  MissingInstallError,
  ProbeError,
  TimeoutError,
  ToolResultError,
  isRecord,
} from "./probe-codex-core.mjs";

/** @typedef {import("./probe-codex-core.mjs").ExitInfo} ExitInfo */
/** @typedef {import("./probe-codex-core.mjs").ProbeOptions} ProbeOptions */
/** @typedef {import("./probe-codex-core.mjs").ProbeStats} ProbeStats */
/**
 * @template T
 * @param {ProbeOptions} options
 * @param {string} approvalMode
 * @param {(client: JsonRpcStdioClient) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withMcpClient(options, approvalMode, fn) {
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
    if (signalHandler !== undefined) {
      process.off("SIGINT", signalHandler);
    }
    await client.close();
  }
}

/**
 * @param {ProbeOptions} options
 * @returns {Promise<number>}
 */
export async function runDiscover(options) {
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
export async function runApps(options) {
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
export async function runState(options) {
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
export async function runLogs(options) {
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

  const stdoutRemainder = streamLines(child.stdout, (line) => printLine(line, "stdout"));
  const stderrRemainder = streamLines(child.stderr, (line) => printLine(line, "stderr"));

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

  if (stdoutRemainder() !== "") {
    printLine(stdoutRemainder(), "stdout");
  }
  if (stderrRemainder() !== "") {
    printLine(stderrRemainder(), "stderr");
  }

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
 * Split a text stream into newline-delimited lines; returns the remainder accessor.
 * @param {import("node:stream").Readable} stream
 * @param {(line: string) => void} onLine
 * @returns {() => string}
 */
function streamLines(stream, onLine) {
  let buffer = "";
  stream.on("data", (/** @type {string} */ chunk) => {
    buffer += chunk;
    let newlineIndex;
    while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      onLine(line);
    }
  });
  return () => buffer;
}

/**
 * Suggest the retry command for a timed-out probe.
 * @param {ProbeOptions | undefined} parsed
 * @returns {string}
 */
function retryCommand(parsed) {
  if (parsed?.command === "state" || parsed?.command === "deny") {
    return `${parsed.command} --app ${shellQuote(parsed.app)}${
      parsed.command === "state" ? ` --approval ${String(parsed.approval)}` : ""
    } --tool-timeout-ms 90000`;
  }
  if (parsed?.command === "apps") {
    return "apps --tool-timeout-ms 90000";
  }
  return "discover --startup-timeout-ms 30000 --list-timeout-ms 30000";
}

/**
 * @param {unknown} error
 * @param {ProbeOptions | { help: true } | undefined} options
 * @returns {void}
 */
export function printNextDiagnostics(error, options) {
  const script = "tools/probe-codex-computer-use-mcp.mjs";
  const parsed = parsedOptions(options);
  process.stderr.write("\nNext diagnostics:\n");
  printGeneralDiagnostics(script, parsed);
  if (error instanceof TimeoutError) {
    process.stderr.write(`  node ${script} ${retryCommand(parsed)}\n`);
  }
  if (error instanceof MissingInstallError) {
    printMissingInstallDiagnostics();
  }
}

/**
 * @param {ProbeOptions | { help: true } | undefined} options
 * @returns {ProbeOptions | undefined}
 */
function parsedOptions(options) {
  return options !== undefined && "command" in options && typeof options.command === "string"
    ? options
    : undefined;
}

/**
 * @param {string} script
 * @param {ProbeOptions | undefined} parsed
 */
function printGeneralDiagnostics(script, parsed) {
  if (parsed?.command !== "logs") {
    printModeDiagnostics(script, parsed);
  }
  const client = shellQuote(parsed?.client ?? DEFAULT_CLIENT);
  process.stderr.write(`  ${client} --help\n`);
  process.stderr.write(`  ${client} help mcp\n`);
}

/**
 * @param {string} script
 * @param {ProbeOptions | undefined} parsed
 */
function printModeDiagnostics(script, parsed) {
  process.stderr.write(`  node ${script} logs --since 5m\n`);
  process.stderr.write(
    `  node ${script} discover --client ${shellQuote(parsed?.client ?? DEFAULT_CLIENT)} --cwd ${shellQuote(parsed?.cwd ?? DEFAULT_CWD)}\n`,
  );
}

/**
 * Print the install-verification commands for a missing install.
 */
function printMissingInstallDiagnostics() {
  process.stderr.write(
    '  find "$CODEX_HOME/plugins/cache/openai-bundled/computer-use" -maxdepth 3 -name .mcp.json -print\n',
  );
  process.stderr.write(
    '  find "$CODEX_HOME/computer-use" -iname SkyComputerUseClient -type f -print\n',
  );
}

/**
 * @param {string | undefined} value
 * @returns {string}
 */
