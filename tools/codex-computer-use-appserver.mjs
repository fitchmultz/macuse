#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { accessSync, constants, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const VERSION = '0.1.0';
const DEFAULT_CODEX_BIN = '/Applications/Codex.app/Contents/Resources/codex';
const DEFAULT_TOOL_TIMEOUT_MS = 90000;
const DEFAULT_STARTUP_TIMEOUT_MS = 15000;
const DEFAULT_THREAD_TIMEOUT_MS = 45000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 3000;
const DEFAULT_MAX_TEXT_CHARS = 20000;
const FEATURE_FLAGS = ['computer_use', 'plugins', 'tool_call_mcp_elicitation'];

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
  process.stdout.write(`Codex Computer Use app-server bridge ${VERSION}\n\nUsage:\n  node tools/codex-computer-use-appserver.mjs status [options]\n  node tools/codex-computer-use-appserver.mjs list-apps [options]\n  node tools/codex-computer-use-appserver.mjs get-state --app <app> --approval ask|accept-once|deny [options]\n  node tools/codex-computer-use-appserver.mjs call --tool <tool> --arguments-json <json> [options]\n\nModes:\n  status\n      Start Codex app-server and print MCP server status. This proves the\n      app-server can discover the Computer Use MCP server and its tools.\n\n  list-apps\n      Call the read-only Computer Use list_apps tool through Codex app-server.\n      This is the safest positive service-backed regression probe.\n\n  get-state --app <app> --approval ask|accept-once|deny\n      Call the read-only get_app_state tool through Codex app-server.\n      The CLI is non-interactive; approval=ask is rejected here and is meant for\n      the pi extension wrapper, which can ask through pi UI and then pass either\n      accept-once or deny.\n\n  call --tool <tool> --arguments-json <json>\n      Generic app-server-backed tool call. By default only read-only Computer\n      Use tools are allowed. Pass --allow-mutating to call click/type/scroll/etc.\n      Do not use mutating tools without an explicit task-level safety policy.\n\nOptions:\n  --codex <path>                 Codex CLI/app-server binary.\n                                 Default: ${DEFAULT_CODEX_BIN}\n                                 Env: CODEX_BIN\n  --cwd <path>                   Thread cwd. Default: current directory.\n  --app <name|bundle|path>       App for get-state.\n  --tool <name>                  Computer Use tool for call mode.\n  --arguments-json <json>        JSON object arguments for call mode.\n  --approval <mode>              ask, accept-once, or deny. Default for get-state: deny.\n  --include-image                Keep image blocks in JSON output. Default: omit.\n  --save-image <path>            Save the first returned image block to a file.\n  --max-text-chars <n>           Truncate each text block in output. Default: ${DEFAULT_MAX_TEXT_CHARS}\n  --tool-timeout-ms <ms>         Tool call timeout. Default: ${DEFAULT_TOOL_TIMEOUT_MS}\n  --startup-timeout-ms <ms>      initialize timeout. Default: ${DEFAULT_STARTUP_TIMEOUT_MS}\n  --thread-timeout-ms <ms>       thread/start timeout. Default: ${DEFAULT_THREAD_TIMEOUT_MS}\n  --shutdown-timeout-ms <ms>     app-server shutdown grace period. Default: ${DEFAULT_SHUTDOWN_TIMEOUT_MS}\n  --allow-mutating               Permit call mode to invoke non-read-only tools.\n  --pretty                       Pretty-print JSON output.\n  --quiet                        Suppress stderr event logs.\n  -h, --help                     Show this help.\n\nExit codes:\n  0  success\n  1  bridge/app-server failure\n  2  usage error\n  3  missing Codex app-server binary\n  4  timeout\n  5  child process exited unexpectedly\n\nSafety:\n  list-apps and get-state are read-only Computer Use tools, though get-state can\n  reveal screen/app contents and may launch or foreground an app. Mutating tools\n  are blocked unless --allow-mutating is explicitly passed.\n\nExamples:\n  node tools/codex-computer-use-appserver.mjs status --pretty\n  node tools/codex-computer-use-appserver.mjs list-apps --pretty\n  node tools/codex-computer-use-appserver.mjs get-state --app Calculator --approval accept-once --pretty\n  node tools/codex-computer-use-appserver.mjs get-state --app Calculator --approval accept-once --include-image --save-image .scratch/calculator.jpg\n  node tools/codex-computer-use-appserver.mjs call --tool list_apps --arguments-json '{}' --pretty\n`);
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

function parseArgs(argv) {
  const tokens = normalizeArgTokens(argv);
  if (tokens.includes('-h') || tokens.includes('--help')) return { help: true };
  const mode = tokens.shift();
  if (!mode) return { help: true };
  if (!['status', 'list-apps', 'get-state', 'call'].includes(mode)) {
    throw new UsageError(`unknown mode: ${mode}`);
  }

  const opts = {
    mode,
    codexBin: process.env.CODEX_BIN || DEFAULT_CODEX_BIN,
    cwd: process.cwd(),
    app: undefined,
    tool: undefined,
    arguments: {},
    approval: undefined,
    includeImage: false,
    saveImage: undefined,
    maxTextChars: DEFAULT_MAX_TEXT_CHARS,
    startupTimeoutMs: DEFAULT_STARTUP_TIMEOUT_MS,
    threadTimeoutMs: DEFAULT_THREAD_TIMEOUT_MS,
    toolTimeoutMs: DEFAULT_TOOL_TIMEOUT_MS,
    shutdownTimeoutMs: DEFAULT_SHUTDOWN_TIMEOUT_MS,
    allowMutating: false,
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
      case '--tool': opts.tool = next(); break;
      case '--arguments-json': opts.arguments = parseJsonObject('--arguments-json', next()); break;
      case '--approval': opts.approval = next(); break;
      case '--include-image': opts.includeImage = true; break;
      case '--save-image': opts.saveImage = next(); break;
      case '--max-text-chars': opts.maxTextChars = parsePositiveInt('--max-text-chars', next()); break;
      case '--startup-timeout-ms': opts.startupTimeoutMs = parsePositiveInt('--startup-timeout-ms', next()); break;
      case '--thread-timeout-ms': opts.threadTimeoutMs = parsePositiveInt('--thread-timeout-ms', next()); break;
      case '--tool-timeout-ms': opts.toolTimeoutMs = parsePositiveInt('--tool-timeout-ms', next()); break;
      case '--shutdown-timeout-ms': opts.shutdownTimeoutMs = parsePositiveInt('--shutdown-timeout-ms', next()); break;
      case '--allow-mutating': opts.allowMutating = true; break;
      case '--pretty': opts.pretty = true; break;
      case '--quiet': opts.quiet = true; break;
      default: throw new UsageError(`unknown option: ${token}`);
    }
  }

  if (mode === 'get-state') {
    if (!opts.app) throw new UsageError('get-state requires --app <app>');
    opts.tool = 'get_app_state';
    opts.arguments = { app: opts.app };
    opts.approval ??= 'deny';
  }
  if (mode === 'list-apps') {
    opts.tool = 'list_apps';
    opts.arguments = {};
    opts.approval ??= 'deny';
  }
  if (mode === 'call') {
    if (!opts.tool) throw new UsageError('call requires --tool <tool>');
    opts.approval ??= 'deny';
  }
  if (opts.approval && !['ask', 'accept-once', 'deny'].includes(opts.approval)) {
    throw new UsageError('--approval must be ask, accept-once, or deny');
  }
  if (opts.approval === 'ask') {
    throw new UsageError('approval=ask is only supported by the pi extension wrapper; use accept-once or deny in the CLI');
  }
  if (opts.tool && !READ_ONLY_TOOLS.has(opts.tool) && !opts.allowMutating) {
    throw new UsageError(`tool ${opts.tool} is not read-only; pass --allow-mutating only after explicit user approval and a safety policy`);
  }
  return opts;
}

function truncateString(value, max) {
  if (typeof value !== 'string') return value;
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…[${value.length} chars]`;
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
    },
  };
}

function filterToolResult(result, opts) {
  const content = [];
  let omittedImages = 0;
  let savedImagePath = null;
  for (const block of result?.content || []) {
    if (block?.type === 'text') {
      content.push({ ...block, text: truncateString(block.text || '', opts.maxTextChars) });
    } else if (block?.type === 'image') {
      if (opts.saveImage && !savedImagePath && block.data) {
        const outPath = resolve(opts.saveImage);
        mkdirSync(dirname(outPath), { recursive: true });
        writeFileSync(outPath, Buffer.from(block.data, 'base64'));
        savedImagePath = outPath;
      }
      if (opts.includeImage) content.push(block);
      else omittedImages += 1;
    } else {
      content.push(block);
    }
  }
  return {
    content,
    isError: result?.isError ?? result?.is_error ?? false,
    meta: result?._meta ?? result?.meta ?? null,
    omittedImages,
    savedImagePath,
  };
}

function summarizeStatus(statusResult) {
  return {
    nextCursor: statusResult.nextCursor ?? null,
    servers: (statusResult.data || []).map((server) => ({
      name: server.name,
      authStatus: server.authStatus,
      toolNames: Object.keys(server.tools || {}).sort(),
      resourceCount: (server.resources || []).length,
      resourceTemplateCount: (server.resourceTemplates || []).length,
    })),
  };
}

async function runWithThread(opts, fn) {
  const client = new AppServerJsonRpc(opts);
  try {
    client.start();
    const initialized = await client.request('initialize', {
      clientInfo: { name: 'macuse-codex-computer-use-bridge', version: VERSION },
      capabilities: { experimental_api: true, mcp_elicitations: true },
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
      notifications: client.notifications.map((n) => ({ method: n.method, params: n.params })).slice(-20),
      ...payload,
    };
  } finally {
    await client.stop();
  }
}

async function runStatus(opts) {
  const client = new AppServerJsonRpc(opts);
  try {
    client.start();
    const initialized = await client.request('initialize', {
      clientInfo: { name: 'macuse-codex-computer-use-bridge', version: VERSION },
      capabilities: { experimental_api: true, mcp_elicitations: true },
    }, opts.startupTimeoutMs);
    client.notify('notifications/initialized');
    const status = await client.request('mcpServerStatus/list', { detail: 'toolsAndAuthOnly', limit: 100 }, opts.toolTimeoutMs);
    return {
      ok: true,
      mode: opts.mode,
      codexBin: opts.codexBin,
      cwd: opts.cwd,
      initialized,
      status: summarizeStatus(status),
      notifications: client.notifications.map((n) => ({ method: n.method, params: n.params })).slice(-20),
    };
  } finally {
    await client.stop();
  }
}

async function runTool(opts) {
  return runWithThread(opts, async (client, { initialized, threadStart, threadId }) => {
    const result = await client.request('mcpServer/tool/call', {
      threadId,
      server: 'computer-use',
      tool: opts.tool,
      arguments: opts.arguments,
    }, opts.toolTimeoutMs);
    const filtered = filterToolResult(result, opts);
    return {
      initialized,
      thread: threadStart.thread,
      tool: opts.tool,
      arguments: opts.arguments,
      result: filtered,
    };
  });
}

function writeJson(value, pretty = false) {
  process.stdout.write(`${JSON.stringify(value, null, pretty ? 2 : 0)}\n`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }
  let output;
  if (opts.mode === 'status') output = await runStatus(opts);
  else output = await runTool(opts);
  writeJson(output, opts.pretty);
}

main().catch((error) => {
  const exitCode = error instanceof CliError ? error.exitCode : EXIT.FAILURE;
  const payload = {
    ok: false,
    error: error.message || String(error),
    name: error.name || 'Error',
    details: error.details,
    exitCode,
  };
  writeJson(payload, process.argv.includes('--pretty'));
  process.exitCode = exitCode;
});
