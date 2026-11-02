import {
  DEFAULT_CLIENT,
  DEFAULT_CWD,
  DEFAULT_PROTOCOL_VERSION,
  UsageError,
} from "./probe-codex-core.mjs";

/** @typedef {import("./probe-codex-core.mjs").ProbeOptions} ProbeOptions */
/**
 * @param {string[]} argv
 * @returns {string[]}
 */
export function normalizeArgTokens(argv) {
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
export function parsePositiveInt(name, value) {
  if (value === undefined || value === "") {
    throw new UsageError(`${name} requires a positive integer`);
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new UsageError(`${name} must be a positive integer, got ${value}`);
  }
  return n;
}

/**
 * @param {string[]} argv
 * @returns {ProbeOptions | { help: true }}
 */
export function parseArgs(argv) {
  const tokens = normalizeArgTokens(argv);
  if (tokens.length === 0 || tokens.includes("--help") || tokens.includes("-h")) {
    return { help: true };
  }
  const commandIndex = findCommandIndex(tokens);
  if (commandIndex === -1) {
    throw new UsageError("missing mode; use --help for usage");
  }
  const command = tokens[commandIndex] ?? "";
  const rest = tokens.slice(0, commandIndex).concat(tokens.slice(commandIndex + 1));
  /** @type {ProbeOptions} */
  const options = defaultOptions(command);
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i] ?? "";
    const next = () => {
      i += 1;
      const value = rest[i] ?? "";
      if (i >= rest.length || value.startsWith("--")) {
        throw new UsageError(`${flag} requires a value`);
      }
      return value;
    };
    Object.assign(options, readFlag(flag, next));
  }
  if (!["discover", "apps", "deny", "state", "logs"].includes(command)) {
    throw new UsageError(`unknown mode: ${command}`);
  }
  Object.assign(options, commandRequirements(command, options));
  options.elicitationTimeoutMs ??= options.toolTimeoutMs;
  return options;
}

/**
 * Locate the mode keyword among the tokens, skipping flag values.
 * @param {string[]} tokens
 * @returns {number}
 */
function findCommandIndex(tokens) {
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
  for (let i = 0; i < tokens.length; i += 1) {
    const arg = tokens[i] ?? "";
    if (arg.startsWith("-")) {
      if (valueFlags.has(arg)) {
        i += 1;
      }
      if (booleanFlags.has(arg)) {
        continue;
      }
      continue;
    }
    if (commands.has(arg)) {
      return i;
    }
  }
  return -1;
}

/**
 * Build the environment-aware defaults for a mode.
 * @param {string} command
 * @returns {ProbeOptions}
 */
function defaultOptions(command) {
  const clientEnv = process.env.CODEX_CU_CLIENT;
  const cwdEnv = process.env.CODEX_CU_CWD;
  return {
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
}

/**
 * Read one flag into a partial options update.
 * @param {string} flag
 * @param {() => string} next
 * @returns {Partial<ProbeOptions>}
 */
function readFlag(flag, next) {
  switch (flag) {
    case "--client":
      return { client: next() };
    case "--cwd":
      return { cwd: next() };
    case "--protocol-version":
      return { protocolVersion: next() };
    case "--startup-timeout-ms":
      return { startupTimeoutMs: parsePositiveInt(flag, next()) };
    case "--list-timeout-ms":
      return { listTimeoutMs: parsePositiveInt(flag, next()) };
    case "--tool-timeout-ms":
      return { toolTimeoutMs: parsePositiveInt(flag, next()) };
    case "--elicitation-timeout-ms":
      return { elicitationTimeoutMs: parsePositiveInt(flag, next()) };
    case "--shutdown-timeout-ms":
      return { shutdownTimeoutMs: parsePositiveInt(flag, next()) };
    case "--log-timeout-ms":
      return { logTimeoutMs: parsePositiveInt(flag, next()) };
    case "--max-log-lines":
      return { maxLogLines: parsePositiveInt(flag, next()) };
    case "--app":
      return { app: next() };
    case "--approval":
      return { approval: next() };
    case "--since":
      return { since: next() };
    case "--with-turn-metadata":
      return { withTurnMetadata: true };
    default:
      if (flag.startsWith("-")) {
        throw new UsageError(`unknown option: ${flag}`);
      }
      throw new UsageError(`unexpected argument: ${flag}`);
  }
}

/**
 * Validate mode-specific requirements and derive forced fields.
 * @param {string} command
 * @param {ProbeOptions} options
 * @returns {Partial<ProbeOptions>}
 */
function commandRequirements(command, options) {
  if (command === "deny") {
    if (options.app === undefined || options.app === "") {
      throw new UsageError("deny requires --app <app>");
    }
    return { approval: "deny" };
  }
  if (command === "state") {
    return stateRequirements(options);
  }
  if (command === "logs") {
    logsRequirements(options);
  }
  return {};
}

/**
 * @param {ProbeOptions} options
 * @returns {Partial<ProbeOptions>}
 */
function stateRequirements(options) {
  if (options.app === undefined || options.app === "") {
    throw new UsageError("state requires --app <app>");
  }
  if (options.approval === undefined || options.approval === "") {
    throw new UsageError("state requires --approval interactive|accept-once|deny");
  }
  if (!["interactive", "accept-once", "deny"].includes(options.approval)) {
    throw new UsageError(`unsupported approval mode: ${options.approval}`);
  }
  return {};
}

/**
 * @param {ProbeOptions} options
 */
function logsRequirements(options) {
  if (options.since === undefined || options.since === "") {
    throw new UsageError("logs requires --since <duration>, for example --since 5m");
  }
  if (!/^\d+(?:\.\d+)?[smhd]$/.test(options.since)) {
    throw new UsageError("--since must look like 30s, 5m, 1h, or 1d");
  }
}

/**
 * @param {string | undefined} value
 * @returns {string}
 */
export function shellQuote(value) {
  const s = value ?? "";
  if (/^[A-Za-z0-9_./:=+-]+$/.test(s)) {
    return s;
  }
  return `'${s.replaceAll("'", "'\\''")}'`;
}
