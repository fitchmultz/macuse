#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { accessSync, constants, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_BUNDLED_COMPUTER_USE_PLUGIN_DIR, DEFAULT_CODEX_BIN, MCP_SERVERS, VERSION, mcpServerConfigs } from './macuse-utils.mjs';
import {
  contentText,
  appServerSessionRecoverySummary,
  filterToolResult,
  getMousePosition,
  normalizeToolArguments,
  resolveElementTarget as resolveElementTargetHelper,
  restoreMousePosition,
  sanitizeRecoverableComputerUseText,
  targetsElement,
  toolResultText,
  truncateString,
  updateElementCache,
  withReadOnlyComputerUseRecovery,
} from './cu-helpers.mjs';

const DEFAULT_TOOL_TIMEOUT_MS = 90000;
const DEFAULT_STARTUP_TIMEOUT_MS = 15000;
const DEFAULT_THREAD_TIMEOUT_MS = 45000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 3000;
const DEFAULT_MAX_TEXT_CHARS = 20000;
const FEATURE_FLAGS = ['computer_use', 'plugins', 'tool_call_mcp_elicitation'];
const EXPECTED_COMPUTER_USE_TOOLS = MCP_SERVERS['computer-use'].tools;

const EXIT = Object.freeze({
  OK: 0,
  FAILURE: 1,
  USAGE: 2,
  MISSING_INSTALL: 3,
  TIMEOUT: 4,
  CHILD_EXIT: 5,
});

const JSON_RPC_ERROR = Object.freeze({
  METHOD_NOT_FOUND: -32601,
  INTERNAL_ERROR: -32603,
});

const READ_ONLY_TOOLS = new Set(['list_apps', 'get_app_state']);
const AUTO_RECOVERY_TOOLS = new Set([...READ_ONLY_TOOLS, 'event_stream_status', 'computer_history_status', 'computer_history_get_settings']);

process.stdout.on('error', (error) => {
  if (error.code === 'EPIPE') process.exit(0);
  throw error;
});

class CliError extends Error {
  constructor(message, exitCode = EXIT.FAILURE, details = undefined) {
    super(message);
    this.name = this.constructor.name;
    this.exitCode = exitCode;
    this.details = details;
  }
}

class UsageError extends CliError {
  constructor(message) {
    super(message, EXIT.USAGE);
  }
}

class TimeoutError extends CliError {
  constructor(message, details = undefined) {
    super(message, EXIT.TIMEOUT, details);
  }
}

class MissingInstallError extends CliError {
  constructor(message, details = undefined) {
    super(message, EXIT.MISSING_INSTALL, details);
  }
}

class ChildExitError extends CliError {
  constructor(message, details = undefined) {
    super(message, EXIT.CHILD_EXIT, details);
  }
}

function printHelp() {
  process.stdout.write(`Codex Computer Use app-server bridge ${VERSION}\n\nUsage:\n  node tools/codex-computer-use-appserver.mjs status [--full] [options]\n  node tools/codex-computer-use-appserver.mjs list-apps [options]\n  node tools/codex-computer-use-appserver.mjs get-state --app <app> [--approval inherit|accept-all|accept-once|deny] [options]\n  node tools/codex-computer-use-appserver.mjs call --server <server> --tool <tool> --arguments-json <json> [options]\n  node tools/codex-computer-use-appserver.mjs sequence --steps-json <json-array> [options]\n\nModes:\n  status\n      Start Codex app-server and print all three public MCP inventories:\n      computer-use (10), event-stream (3), and computer-history (5).\n      Pass --full to print every app-server MCP server for diagnostics.\n\n  list-apps\n      Call the read-only Computer Use list_apps tool through Codex app-server.\n      This is the safest positive service-backed regression probe.\n\n  get-state --app <app> [--approval inherit|accept-all|accept-once|deny]\n      Call the read-only get_app_state tool through Codex app-server.\n      Default approval=inherit auto-accepts Computer Use app-approval\n      elicitations, matching Codex's Any App setting for this external bridge.\n\n  call --server <server> --tool <tool> --arguments-json <json>\n      Call any of the 18 public tools. App mutation, recording starts/resumes,\n      and settings changes have separate guards. Status/get_settings calls may\n      expose activity, artifact, or privacy metadata.\n\n  sequence --steps-json <json-array>\n      Run multiple Computer Use tool calls in one app-server thread. Each step\n      is {\"tool\":\"get_app_state\",\"arguments\":{\"app\":\"Activity Monitor\"}}.\n      Steps may include label, expectText, expectAbsentText, and allowError.\n      Element-targeted tools accept element_index as a string or number,\n      element as an alias, stable elementId / element_id values, or exact\n      elementDescription / element_description matches. press_key accepts\n      xdotool-style combos or key plus modifiers, e.g. key=\",\" with COMMAND\n      normalizes to super+comma. The bridge refreshes app state before\n      resolving stable targets and coerces indexes to strings.\n      Use this for get_app_state -> action -> get_app_state validation.\n\nOptions:\n  --codex <path>                 Codex CLI/app-server binary.\n                                 Default: ${DEFAULT_CODEX_BIN}\n                                 Env: CODEX_BIN\n  --cwd <path>                   Thread cwd. Default: current directory.\n  --app <name|bundle|path>       App for get-state.\n  --server <name>                computer-use (default), event-stream, or computer-history.
  --tool <name>                  Tool for call mode.\n  --arguments-json <json>        JSON object arguments for call mode.\n  --steps-json <json-array>      JSON array of sequence steps.\n  --approval <mode>              inherit, accept-all, accept-once, or deny. Default: inherit.\n  --running-only                 For list-apps, return only currently running apps.\n  --filter <text>                For list-apps, substring-filter app name/path/bundle lines.\n  --include-image                Keep image blocks in JSON output. Default: omit.\n  --save-image <path>            Save the first returned image block to a file.\n  --max-text-chars <n>           Truncate each text block in output. Default: ${DEFAULT_MAX_TEXT_CHARS}\n  --tool-timeout-ms <ms>         Tool call timeout. Default: ${DEFAULT_TOOL_TIMEOUT_MS}\n  --startup-timeout-ms <ms>      initialize timeout. Default: ${DEFAULT_STARTUP_TIMEOUT_MS}\n  --thread-timeout-ms <ms>       thread/start timeout. Default: ${DEFAULT_THREAD_TIMEOUT_MS}\n  --shutdown-timeout-ms <ms>     app-server shutdown grace period. Default: ${DEFAULT_SHUTDOWN_TIMEOUT_MS}\n  --allow-mutating               Permit app-control mutation.
  --allow-recording              Required for event_stream_start and computer_history_resume.
  --allow-privacy-change         Required for computer_history_update_settings.
  --safety-note <text>           Required with recording/privacy allow flags.\n  --preserve-mouse               Restore mouse cursor position after the call/sequence.\n  --no-auto-restart-computer-use Disable one-shot app-server session restart/retry for read-only stopped-session/transport failures.\n  --full                         For status mode, include every app-server MCP server.\n  --pretty                       Pretty-print JSON output.\n  --quiet                        Suppress stderr event logs.\n  -h, --help                     Show this help.\n\nExit codes:\n  0  success\n  1  bridge/app-server failure\n  2  usage error\n  3  missing Codex app-server binary\n  4  timeout\n  5  child process exited unexpectedly\n\nSafety:\n  list-apps and get-state are read-only Computer Use tools, though get-state can\n  reveal screen/app contents and may launch or foreground an app. Mutating tools\n  are blocked unless --allow-mutating is explicitly passed.\n\nExamples:\n  node tools/codex-computer-use-appserver.mjs status --pretty\n  node tools/codex-computer-use-appserver.mjs status --full --pretty\n  node tools/codex-computer-use-appserver.mjs list-apps --running-only --filter "Activity Monitor" --pretty\n  node tools/codex-computer-use-appserver.mjs get-state --app "Activity Monitor" --pretty\n  node tools/codex-computer-use-appserver.mjs get-state --app "Activity Monitor" --include-image --save-image .scratch/activity-monitor.jpg\n  node tools/codex-computer-use-appserver.mjs call --tool list_apps --arguments-json '{}' --pretty\n  node tools/codex-computer-use-appserver.mjs sequence --allow-mutating --steps-json '[{\"tool\":\"get_app_state\",\"arguments\":{\"app\":\"Activity Monitor\"}},{\"tool\":\"perform_secondary_action\",\"arguments\":{\"app\":\"Activity Monitor\",\"elementDescription\":\"Memory\",\"action\":\"Press\"}},{\"tool\":\"get_app_state\",\"arguments\":{\"app\":\"Activity Monitor\"}}]'\n`);
}
function normalizeArgTokens(argv) {
  const tokens = [];
  for (const arg of argv) {
    if (arg.startsWith('--') && arg.includes('=')) {
      const [flag, ...rest] = arg.split('=');
      tokens.push(flag, rest.join('='));
    } else {
      tokens.push(arg);
    }
  }
  return tokens;
}

function parsePositiveInt(name, value) {
  if (value === undefined || value === '') throw new UsageError(`${name} requires a positive integer`);
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new UsageError(`${name} must be a positive integer, got ${value}`);
  return n;
}

function parseJsonObject(name, value) {
  if (value === undefined) throw new UsageError(`${name} requires a JSON object`);
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new UsageError(`${name} must be valid JSON: ${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new UsageError(`${name} must be a JSON object`);
  }
  return parsed;
}

function parseJsonArray(name, value) {
  if (value === undefined) throw new UsageError(`${name} requires a JSON array`);
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new UsageError(`${name} must be valid JSON: ${error.message}`);
  }
  if (!Array.isArray(parsed)) throw new UsageError(`${name} must be a JSON array`);
  return parsed;
}

function filteredAppListLines(content, opts = {}) {
  let lines = contentText(content).split('\n').map((line) => line.trim()).filter(Boolean);
  if (opts.runningOnly) lines = lines.filter((line) => /\[(?:[^\]]*,\s*)?(?:frontmost,\s*)?running(?:[,\]])/.test(line) || line.includes('[frontmost, running'));
  if (opts.filter) {
    const needle = String(opts.filter).toLowerCase();
    lines = lines.filter((line) => line.toLowerCase().includes(needle));
  }
  return lines;
}

function parseAppListLine(line) {
  const [left, flagsPart = ''] = line.split(/\s+\[([^\]]+)\]\s*$/).filter((part) => part !== undefined);
  const parts = (left || line).split(' — ').map((part) => part.trim());
  const flags = flagsPart.split(',').map((flag) => flag.trim()).filter(Boolean);
  const lastUsedFlag = flags.find((flag) => /^last[- ]used:/i.test(flag));
  return {
    name: parts[0] || line,
    path: parts[1] || null,
    bundleId: parts[2] || null,
    flags,
    running: flags.some((flag) => flag.toLowerCase() === 'running'),
    frontmost: flags.some((flag) => flag.toLowerCase() === 'frontmost'),
    lastUsed: lastUsedFlag?.replace(/^last[- ]used:\s*/i, '') ?? null,
    line,
  };
}

function filterListAppsResult(result, opts) {
  if (result.isError) return { ...result, apps: [], frontmostApps: [] };
  const lines = filteredAppListLines(result.content, opts);
  const apps = lines.map(parseAppListLine);
  const frontmost = apps.filter((app) => app.frontmost).map((app) => app.name).join(', ') || '<none>';
  const summary = `Structured app summary: count=${apps.length}; frontmost=${frontmost}; fields=name,path,bundleId,flags,running,frontmost,lastUsed`;
  return {
    ...result,
    content: [{ type: 'text', text: truncateString(lines.length ? `${summary}\n${lines.join('\n')}` : 'No apps matched the requested filter.', opts.maxTextChars) }],
    apps,
    frontmostApps: apps.filter((app) => app.frontmost),
  };
}

function listAppsHostOptions(args, opts = {}) {
  return {
    runningOnly: Boolean(args?.runningOnly ?? opts.runningOnly),
    filter: typeof args?.filter === 'string' ? args.filter : opts.filter,
    maxTextChars: opts.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS,
  };
}

function stripListAppsHostArguments(args) {
  const normalized = { ...args };
  delete normalized.runningOnly;
  delete normalized.filter;
  return normalized;
}

function resolveElementTarget(args, cache) {
  return resolveElementTargetHelper(args, cache, {
    closestSuggestions: true,
    targetHints: true,
    usageError: (message) => new UsageError(message),
    targetError: (message) => new CliError(message),
  });
}

function normalizeSequenceSteps(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new UsageError('--steps-json must contain at least one step');
  }
  return value.map((step, index) => {
    if (!step || typeof step !== 'object' || Array.isArray(step)) {
      throw new UsageError(`sequence step ${index} must be an object`);
    }
    if (typeof step.tool !== 'string' || step.tool.length === 0) {
      throw new UsageError(`sequence step ${index} requires a non-empty tool string`);
    }
    const args = { ...(step.arguments ?? {}) };
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      throw new UsageError(`sequence step ${index} arguments must be a JSON object`);
    }
    if (step.tool === 'set_value' && args.value === undefined && step.value !== undefined) args.value = step.value;
    return {
      tool: step.tool,
      arguments: normalizeToolArguments(args),
      label: typeof step.label === 'string' ? step.label : undefined,
      expectText: normalizeStringList(step.expectText, `sequence step ${index} expectText`),
      expectAbsentText: normalizeStringList(step.expectAbsentText, `sequence step ${index} expectAbsentText`),
      allowError: step.allowError === true,
    };
  });
}

function normalizeStringList(value, name) {
  if (value === undefined || value === null) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value;
  throw new UsageError(`${name} must be a string or array of strings`);
}

function validateAuxiliaryGuard(tool, args, opts) {
  if (tool === 'event_stream_start' || tool === 'computer_history_resume') {
    if (!opts.allowRecording || !opts.safetyNote.trim()) throw new UsageError(`${tool} requires --allow-recording and a non-empty --safety-note`);
  }
  if (tool !== 'computer_history_update_settings') return;
  if (!opts.allowPrivacyChange || !opts.safetyNote.trim()) throw new UsageError(`${tool} requires --allow-privacy-change and a non-empty --safety-note`);
  const observation = args.observation;
  const validEntries = (value) => Array.isArray(value) && value.every((entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
    && ((entry.scope === 'app' && typeof entry.bundleID === 'string' && entry.bundleID.trim())
      || (entry.scope === 'url' && typeof entry.urlDomain === 'string' && entry.urlDomain.trim() && !entry.urlDomain.includes('://') && !entry.urlDomain.includes('/'))));
  if (!observation || !['observe', 'do_not_observe'].includes(observation.defaultApplicationBehavior)
    || !['observe', 'do_not_observe'].includes(observation.defaultURLBehavior)
    || !validEntries(observation.allowlist) || !validEntries(observation.blocklist)) {
    throw new UsageError(`${tool} requires all Computer History settings fields and valid scope-specific allowlist/blocklist entries`);
  }
}

function parseArgs(argv) {
  const tokens = normalizeArgTokens(argv);
  if (tokens.includes('-h') || tokens.includes('--help')) return { help: true };
  const mode = tokens.shift();
  if (!mode) return { help: true };
  if (!['status', 'list-apps', 'get-state', 'call', 'sequence'].includes(mode)) {
    throw new UsageError(`unknown mode: ${mode}`);
  }

  const opts = {
    mode,
    codexBin: process.env.CODEX_BIN || DEFAULT_CODEX_BIN,
    cwd: process.cwd(),
    app: undefined,
    server: 'computer-use',
    tool: undefined,
    arguments: {},
    steps: [],
    approval: 'inherit',
    includeImage: false,
    saveImage: undefined,
    maxTextChars: DEFAULT_MAX_TEXT_CHARS,
    startupTimeoutMs: DEFAULT_STARTUP_TIMEOUT_MS,
    threadTimeoutMs: DEFAULT_THREAD_TIMEOUT_MS,
    toolTimeoutMs: DEFAULT_TOOL_TIMEOUT_MS,
    shutdownTimeoutMs: DEFAULT_SHUTDOWN_TIMEOUT_MS,
    allowMutating: false,
    allowRecording: false,
    allowPrivacyChange: false,
    safetyNote: '',
    preserveMouse: false,
    autoRestartComputerUse: true,
    runningOnly: false,
    filter: undefined,
    statusFull: false,
    pretty: false,
    quiet: false,
  };

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    const next = () => {
      i += 1;
      if (i >= tokens.length) throw new UsageError(`${token} requires a value`);
      return tokens[i];
    };
    switch (token) {
      case '--codex': opts.codexBin = next(); break;
      case '--cwd': opts.cwd = next(); break;
      case '--app': opts.app = next(); break;
      case '--server': opts.server = next(); break;
      case '--tool': opts.tool = next(); break;
      case '--arguments-json': opts.arguments = normalizeToolArguments(parseJsonObject('--arguments-json', next())); break;
      case '--steps-json': opts.steps = normalizeSequenceSteps(parseJsonArray('--steps-json', next())); break;
      case '--approval': opts.approval = next(); break;
      case '--running-only': opts.runningOnly = true; break;
      case '--filter': opts.filter = next(); break;
      case '--include-image': opts.includeImage = true; break;
      case '--save-image': opts.saveImage = next(); break;
      case '--max-text-chars': opts.maxTextChars = parsePositiveInt('--max-text-chars', next()); break;
      case '--startup-timeout-ms': opts.startupTimeoutMs = parsePositiveInt('--startup-timeout-ms', next()); break;
      case '--thread-timeout-ms': opts.threadTimeoutMs = parsePositiveInt('--thread-timeout-ms', next()); break;
      case '--tool-timeout-ms': opts.toolTimeoutMs = parsePositiveInt('--tool-timeout-ms', next()); break;
      case '--shutdown-timeout-ms': opts.shutdownTimeoutMs = parsePositiveInt('--shutdown-timeout-ms', next()); break;
      case '--allow-mutating': opts.allowMutating = true; break;
      case '--allow-recording': opts.allowRecording = true; break;
      case '--allow-privacy-change': opts.allowPrivacyChange = true; break;
      case '--safety-note': opts.safetyNote = next(); break;
      case '--preserve-mouse': opts.preserveMouse = true; break;
      case '--no-auto-restart-computer-use': opts.autoRestartComputerUse = false; break;
      case '--full': opts.statusFull = true; break;
      case '--pretty': opts.pretty = true; break;
      case '--quiet': opts.quiet = true; break;
      default: throw new UsageError(`unknown option: ${token}`);
    }
  }

  if (mode === 'get-state') {
    if (!opts.app) throw new UsageError('get-state requires --app <app>');
    opts.tool = 'get_app_state';
    opts.arguments = { app: opts.app };
    opts.approval ??= 'inherit';
  }
  if (mode === 'list-apps') {
    opts.tool = 'list_apps';
    opts.arguments = { runningOnly: opts.runningOnly, ...(opts.filter ? { filter: opts.filter } : {}) };
    opts.approval ??= 'inherit';
  }
  if (mode === 'call') {
    if (!opts.tool) throw new UsageError('call requires --tool <tool>');
    opts.approval ??= 'inherit';
  }
  if (mode === 'sequence') {
    if (opts.steps.length === 0) throw new UsageError('sequence requires --steps-json <json-array>');
    opts.approval ??= 'inherit';
  }
  if (!MCP_SERVERS[opts.server]) throw new UsageError('--server must be computer-use, event-stream, or computer-history');
  if (opts.tool && !MCP_SERVERS[opts.server].tools.includes(opts.tool)) throw new UsageError(`tool ${opts.tool} is not exposed by ${opts.server}`);
  validateAuxiliaryGuard(opts.tool, opts.arguments, opts);
  if (opts.approval && !['inherit', 'accept-all', 'accept-once', 'deny'].includes(opts.approval)) {
    throw new UsageError('--approval must be inherit, accept-all, accept-once, or deny');
  }
  if (opts.server === 'computer-use' && opts.tool && !READ_ONLY_TOOLS.has(opts.tool) && !opts.allowMutating) {
    throw new UsageError(`tool ${opts.tool} is not read-only; pass --allow-mutating to acknowledge GUI mutation`);
  }
  for (const [index, step] of opts.steps.entries()) {
    if (!READ_ONLY_TOOLS.has(step.tool) && !opts.allowMutating) {
      throw new UsageError(`sequence step ${index} tool ${step.tool} is not read-only; pass --allow-mutating to acknowledge GUI mutation`);
    }
  }
  return opts;
}

function redactHeavyForLog(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return truncateString(value, 240);
  if (typeof value !== 'object') return value;
  if (depth > 4) return `[${Array.isArray(value) ? 'array' : 'object'}]`;
  if (Array.isArray(value)) return value.slice(0, 10).map((item) => redactHeavyForLog(item, depth + 1));
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (/data|image|screenshot|token|secret|authorization|cookie/i.test(key)) out[key] = `[redacted:${typeof child}]`;
    else out[key] = redactHeavyForLog(child, depth + 1);
  }
  return out;
}

class AppServerJsonRpc {
  constructor(opts) {
    this.opts = opts;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
    this.proc = undefined;
    this.stderr = '';
    this.notifications = [];
    this.elicitations = [];
    this.acceptedElicitations = 0;
  }

  log(event, details = undefined) {
    if (this.opts.quiet) return;
    const suffix = details === undefined ? '' : ` ${JSON.stringify(redactHeavyForLog(details))}`;
    process.stderr.write(`${new Date().toISOString()} ${event}${suffix}\n`);
  }

  start() {
    assertExecutable(this.opts.codexBin);
    const args = ['app-server'];
    for (const flag of FEATURE_FLAGS) args.push('--enable', flag);
    this.log('appserver.spawn', { command: this.opts.codexBin, args, cwd: this.opts.cwd });
    this.proc = spawn(this.opts.codexBin, args, {
      cwd: this.opts.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stderr.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => this.onStdout(chunk));
    this.proc.stderr.on('data', (chunk) => {
      this.stderr += chunk;
      if (this.stderr.length > 20000) this.stderr = this.stderr.slice(-20000);
      if (!this.opts.quiet) process.stderr.write(chunk);
    });
    this.proc.on('exit', (code, signal) => {
      this.log('appserver.exit', { code, signal });
      for (const { reject, method } of this.pending.values()) {
        reject(new ChildExitError(`app-server exited before ${method} completed`, { code, signal, stderr: this.stderr }));
      }
      this.pending.clear();
    });
  }

  onStdout(chunk) {
    this.buffer += chunk;
    for (;;) {
      const idx = this.buffer.indexOf('\n');
      if (idx === -1) break;
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (line) this.onLine(line);
    }
  }

  onLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.log('appserver.stdout.invalid_json', { line: truncateString(line, 500), error: error.message });
      return;
    }

    if (Object.prototype.hasOwnProperty.call(message, 'id') && (Object.prototype.hasOwnProperty.call(message, 'result') || Object.prototype.hasOwnProperty.call(message, 'error')) && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new CliError(`${pending.method} failed: ${message.error.message || 'JSON-RPC error'}`, EXIT.FAILURE, message.error));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (Object.prototype.hasOwnProperty.call(message, 'id') && message.method) {
      this.onServerRequest(message);
      return;
    }

    if (message.method) {
      this.notifications.push(message);
      if (this.notifications.length > 50) this.notifications.shift();
      this.log('appserver.notification', { method: message.method, params: message.params });
      return;
    }

    this.log('appserver.unhandled_message', message);
  }

  onServerRequest(request) {
    this.log('appserver.request', { id: request.id, method: request.method, params: request.params });
    if (request.method === 'mcpServer/elicitation/request') {
      this.elicitations.push(request.params);
      const decision = this.decideElicitation(request.params);
      this.write({ jsonrpc: '2.0', id: request.id, result: decision });
      this.log('appserver.elicitation.response', decision);
      return;
    }
    this.write({
      jsonrpc: '2.0',
      id: request.id,
      error: { code: JSON_RPC_ERROR.METHOD_NOT_FOUND, message: `probe bridge does not implement ${request.method}` },
    });
  }

  decideElicitation(params) {
    if (this.opts.approval === 'inherit' || this.opts.approval === 'accept-all') {
      this.acceptedElicitations += 1;
      return { action: 'accept', content: {}, _meta: null };
    }
    if (this.opts.approval === 'accept-once' && this.acceptedElicitations < 1) {
      this.acceptedElicitations += 1;
      return { action: 'accept', content: {}, _meta: null };
    }
    return { action: 'decline', content: null, _meta: null };
  }

  write(message) {
    if (!this.proc || !this.proc.stdin.writable) throw new ChildExitError('app-server stdin is not writable');
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  notify(method, params = {}) {
    this.write({ jsonrpc: '2.0', method, params });
  }

  request(method, params = {}, timeoutMs = DEFAULT_TOOL_TIMEOUT_MS) {
    const id = this.nextId++;
    this.log('appserver.request.send', { id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new TimeoutError(`${method} timed out after ${timeoutMs}ms`, { method, id }));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  async stop() {
    if (!this.proc) return;
    if (this.proc.exitCode !== null || this.proc.signalCode !== null) return;
    this.log('appserver.stop');
    this.proc.kill('SIGTERM');
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.proc && this.proc.exitCode === null && this.proc.signalCode === null) this.proc.kill('SIGKILL');
        resolve();
      }, this.opts.shutdownTimeoutMs);
      this.proc?.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

function assertExecutable(path) {
  try {
    accessSync(path, constants.X_OK);
  } catch (error) {
    throw new MissingInstallError(`Codex app-server binary not executable: ${path}`, { path, error: error.message });
  }
}

function threadStartParams(opts) {
  return {
    cwd: opts.cwd,
    ephemeral: true,
    approvalPolicy: 'on-request',
    sandbox: 'workspace-write',
    config: {
      features: {
        computer_use: true,
        plugins: true,
        tool_call_mcp_elicitation: true,
      },
      mcp_servers: mcpServerConfigs(),
    },
  };
}

function safeErrorMessage(error) {
  return sanitizeRecoverableComputerUseText(error?.message || String(error)).text;
}

function failureResult(message, maxTextChars) {
  const sanitized = sanitizeRecoverableComputerUseText(message).text;
  return {
    content: [{ type: 'text', text: truncateString(sanitized, maxTextChars) }],
    isError: true,
    meta: null,
    omittedImages: 0,
    savedImagePath: null,
    savedImageArtifact: null,
  };
}

function validateStepResult(step, filtered) {
  const stepNumber = step.index + 1;
  if (filtered.isError && !step.allowError) {
    throw new CliError(`sequence step ${stepNumber} (index ${step.index}) ${step.tool} returned tool error`, EXIT.FAILURE, filtered);
  }
  const text = toolResultText(filtered);
  for (const expected of step.expectText || []) {
    if (!text.includes(expected)) {
      throw new CliError(`sequence step ${stepNumber} (index ${step.index}) ${step.tool} missing expected text: ${expected}`, EXIT.FAILURE, { expected, textPreview: truncateString(text, 1000) });
    }
  }
  for (const unexpected of step.expectAbsentText || []) {
    if (text.includes(unexpected)) {
      throw new CliError(`sequence step ${stepNumber} (index ${step.index}) ${step.tool} contained forbidden text: ${unexpected}`, EXIT.FAILURE, { unexpected, textPreview: truncateString(text, 1000) });
    }
  }
}

function computerUsePluginStatus() {
  const pluginDir = DEFAULT_BUNDLED_COMPUTER_USE_PLUGIN_DIR;
  const pluginJsonPath = resolve(pluginDir, '.codex-plugin/plugin.json');
  try {
    const plugin = JSON.parse(readFileSync(pluginJsonPath, 'utf8'));
    return { pluginDir, metadata: { name: plugin.name ?? null, version: plugin.version ?? null, description: plugin.description ?? null } };
  } catch {
    return { pluginDir, metadata: null };
  }
}

function summarizeServer(server) {
  return {
    name: server.name,
    authStatus: server.authStatus,
    toolNames: Object.keys(server.tools || {}).sort(),
    resourceCount: (server.resources || []).length,
    resourceTemplateCount: (server.resourceTemplates || []).length,
  };
}

function summarizeStatus(statusResult) {
  return {
    nextCursor: statusResult.nextCursor ?? null,
    servers: (statusResult.data || []).map(summarizeServer),
  };
}

function summarizeComputerUseStatus(statusResult) {
  const server = (statusResult.data || []).find((candidate) => candidate.name === 'computer-use');
  const summarized = server ? summarizeServer(server) : null;
  const toolNames = summarized?.toolNames ?? [];
  return {
    present: Boolean(summarized),
    authStatus: summarized?.authStatus ?? null,
    toolCount: toolNames.length,
    toolNames,
    missingTools: EXPECTED_COMPUTER_USE_TOOLS.filter((tool) => !toolNames.includes(tool)),
    resourceCount: summarized?.resourceCount ?? 0,
    resourceTemplateCount: summarized?.resourceTemplateCount ?? 0,
  };
}

async function runWithThread(opts, fn) {
  const client = new AppServerJsonRpc(opts);
  try {
    client.start();
    const initialized = await client.request('initialize', {
      clientInfo: { name: 'macuse-codex-computer-use-bridge', version: VERSION },
      capabilities: { experimentalApi: true, requestAttestation: false },
    }, opts.startupTimeoutMs);
    client.notify('notifications/initialized');
    const threadStart = await client.request('thread/start', threadStartParams(opts), opts.threadTimeoutMs);
    const threadId = threadStart?.thread?.id;
    if (!threadId) throw new CliError('thread/start response did not include thread.id', EXIT.FAILURE, threadStart);
    const payload = await fn(client, { initialized, threadStart, threadId });
    return {
      ok: true,
      mode: opts.mode,
      codexBin: opts.codexBin,
      cwd: opts.cwd,
      threadId,
      elicitationCount: client.elicitations.length,
      acceptedElicitations: client.acceptedElicitations,
      notifications: opts.quiet ? [] : client.notifications.map((n) => ({ method: n.method, params: n.params })).slice(-20),
      ...payload,
    };
  } finally {
    await client.stop();
  }
}

async function listMcpServerStatus(client, threadId, timeoutMs) {
  const data = [];
  let cursor = null;
  for (let page = 0; page < 10; page += 1) {
    const params = { threadId, detail: 'toolsAndAuthOnly', limit: 100 };
    if (cursor) params.cursor = cursor;
    const status = await client.request('mcpServerStatus/list', params, timeoutMs);
    data.push(...(status.data || []));
    cursor = typeof status.nextCursor === 'string' ? status.nextCursor : null;
    if (!cursor) break;
  }
  return { data, nextCursor: cursor };
}

async function runStatus(opts) {
  return runWithThread(opts, async (client, { initialized, threadId }) => {
    const status = await listMcpServerStatus(client, threadId, opts.toolTimeoutMs);
    if (opts.statusFull) return { initialized, status: summarizeStatus(status) };
    return {
      inventories: Object.fromEntries((status.data || []).filter((server) => MCP_SERVERS[server.name]).map((server) => [server.name, summarizeServer(server)])),
      computerUse: summarizeComputerUseStatus(status),
      plugin: computerUsePluginStatus(),
      appServer: { initialized: Boolean(initialized), threadStarted: true },
    };
  });
}

async function refreshElementCache(client, threadId, args, cache, opts) {
  const refresh = await client.request('mcpServer/tool/call', {
    threadId,
    server: 'computer-use',
    tool: 'get_app_state',
    arguments: { app: args.app },
  }, opts.toolTimeoutMs);
  const filtered = filterToolResult(refresh, opts);
  updateElementCache(cache, args.app, contentText(filtered.content));
}

async function runTool(opts) {
  return runWithThread(opts, async (client, { initialized, threadStart, threadId }) => {
    const elementCache = new Map();
    let args = opts.arguments;
    if (targetsElement(opts.tool, args)) await refreshElementCache(client, threadId, args, elementCache, opts);
    args = resolveElementTarget(args, elementCache);
    const callArgs = opts.tool === 'list_apps' ? stripListAppsHostArguments(args) : args;
    const result = await client.request('mcpServer/tool/call', {
      threadId,
      server: opts.server,
      tool: opts.tool,
      arguments: callArgs,
    }, opts.toolTimeoutMs);
    let filtered = filterToolResult(result, opts);
    let apps = null;
    let frontmostApps = null;
    if (opts.tool === 'list_apps') {
      filtered = filterListAppsResult(filtered, listAppsHostOptions(args, opts));
      apps = filtered.apps;
      frontmostApps = filtered.frontmostApps;
      delete filtered.apps;
      delete filtered.frontmostApps;
    }
    updateElementCache(elementCache, args.app, contentText(filtered.content));
    return {
      ...(!opts.quiet ? { initialized, thread: threadStart.thread } : {}),
      tool: opts.tool,
      arguments: args,
      result: filtered,
      ...(apps ? { apps, frontmostApps } : {}),
    };
  });
}

async function runSequence(opts) {
  return runWithThread(opts, async (client, { initialized, threadStart, threadId }) => {
    const steps = [];
    const elementCache = new Map();
    let failed = null;
    for (const [index, step] of opts.steps.entries()) {
      const started = Date.now();
      let stepArgs = step.arguments;
      try {
        if (targetsElement(step.tool, stepArgs)) await refreshElementCache(client, threadId, stepArgs, elementCache, opts);
        stepArgs = resolveElementTarget(stepArgs, elementCache);
        const callArgs = step.tool === 'list_apps' ? stripListAppsHostArguments(stepArgs) : stepArgs;
        const result = await client.request('mcpServer/tool/call', {
          threadId,
          server: 'computer-use',
          tool: step.tool,
          arguments: callArgs,
        }, opts.toolTimeoutMs);
        let filtered = filterToolResult(result, opts);
        if (step.tool === 'list_apps') filtered = filterListAppsResult(filtered, listAppsHostOptions(stepArgs, opts));
        updateElementCache(elementCache, stepArgs.app, contentText(filtered.content));
        const sequencedStep = {
          index,
          label: step.label,
          tool: step.tool,
          arguments: stepArgs,
          durationMs: Date.now() - started,
          result: filtered,
          expectText: step.expectText,
          expectAbsentText: step.expectAbsentText,
          allowError: step.allowError,
        };
        try {
          validateStepResult(sequencedStep, filtered);
        } catch (error) {
          const message = safeErrorMessage(error);
          sequencedStep.result.isError = true;
          sequencedStep.result.content.push({ type: 'text', text: `Sequence stopped: ${message}` });
          failed = { index, stepNumber: index + 1, tool: step.tool, label: step.label, message };
        }
        steps.push(sequencedStep);
        if (failed) break;
      } catch (error) {
        const message = safeErrorMessage(error);
        const allowed = step.allowError;
        if (!allowed) failed = { index, stepNumber: index + 1, tool: step.tool, label: step.label, message };
        steps.push({
          index,
          label: step.label,
          tool: step.tool,
          arguments: stepArgs,
          durationMs: Date.now() - started,
          result: failureResult(`Sequence ${allowed ? 'allowed error' : 'stopped'} before completing step ${index + 1} (index ${index}, ${step.tool}):\n${message}`, opts.maxTextChars),
          expectText: step.expectText,
          expectAbsentText: step.expectAbsentText,
          allowError: step.allowError,
        });
        if (!allowed) break;
      }
    }
    const completedStepCount = failed ? failed.index : steps.length;
    return {
      ok: !failed,
      ...(!opts.quiet ? { initialized, thread: threadStart.thread } : {}),
      steps,
      failed,
      failedStepIndex: failed?.index ?? null,
      failedStepNumber: failed?.stepNumber ?? null,
      failedStepLabel: failed?.label ?? null,
      completedStepCount,
      resumeFromStepIndex: failed?.index ?? null,
      error: failed?.message ?? null,
      exitCode: failed ? EXIT.FAILURE : 0,
    };
  });
}

function writeJson(value, pretty = false) {
  process.stdout.write(`${JSON.stringify(value, null, pretty ? 2 : 0)}\n`);
}

function canAutoRecoverComputerUse(opts) {
  if (!opts.autoRestartComputerUse || opts.mode === 'status' || opts.mode === 'sequence') return false;
  return opts.tool && AUTO_RECOVERY_TOOLS.has(opts.tool);
}

async function runSelectedMode(opts) {
  if (opts.mode === 'status') return runStatus(opts);
  if (opts.mode === 'sequence') return runSequence(opts);
  return runTool(opts);
}

async function runSelectedModeWithRecovery(opts) {
  let recovery = null;
  const output = await withReadOnlyComputerUseRecovery({
    tool: opts.tool,
    enabled: canAutoRecoverComputerUse(opts),
    run: () => runSelectedMode(opts),
    resultText: (result) => [result?.error, toolResultText(result?.result)].filter(Boolean).join('\n'),
    recover: async (reason) => {
      recovery = appServerSessionRecoverySummary(reason);
      return recovery;
    },
    errorFactory: (message) => new CliError(message, EXIT.FAILURE),
  });
  if (recovery && output && typeof output === 'object') output.computerUseRecovery = recovery;
  return output;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }
  let output;
  const mouseBefore = opts.preserveMouse ? getMousePosition() : null;
  try {
    output = await runSelectedModeWithRecovery(opts);
  } finally {
    if (mouseBefore) restoreMousePosition(mouseBefore);
  }
  if (output && mouseBefore) output.mousePreservation = { before: mouseBefore, restored: getMousePosition() };
  writeJson(output, opts.pretty);
  if (output?.ok === false) process.exitCode = output.exitCode || EXIT.FAILURE;
}

main().catch((error) => {
  const exitCode = error instanceof CliError ? error.exitCode : EXIT.FAILURE;
  const sanitized = sanitizeRecoverableComputerUseText(error.message || String(error));
  const payload = {
    ok: false,
    error: sanitized.text,
    name: error.name || 'Error',
    details: sanitized.forcedError ? undefined : error.details,
    exitCode,
  };
  writeJson(payload, process.argv.includes('--pretty'));
  process.exitCode = exitCode;
});
