#!/usr/bin/env node
import { VERSION } from "./macuse-utils.mjs";
import { parseArgs } from "./probe-codex-args.mjs";
import {
  runApps,
  runDiscover,
  runLogs,
  runState,
  printNextDiagnostics,
} from "./probe-codex-commands.mjs";
import {
  DEFAULT_CLIENT,
  DEFAULT_CWD,
  DEFAULT_PROTOCOL_VERSION,
  EXIT,
  ProbeError,
  UsageError,
  sanitizeForLog,
} from "./probe-codex-core.mjs";

/** @typedef {import("./probe-codex-core.mjs").ProbeOptions} ProbeOptions */

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
  if (detailed) {
    process.stderr.write(
      `Details: ${JSON.stringify(sanitizeForLog(probeError.details), null, 2)}\n`,
    );
  }
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
