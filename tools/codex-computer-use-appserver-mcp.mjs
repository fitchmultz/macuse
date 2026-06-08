#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import process from 'node:process';

const VERSION = '0.1.0';
const DEFAULT_CODEX_BIN = '/Applications/Codex.app/Contents/Resources/codex';
const DEFAULT_CWD = process.cwd();
const FEATURE_FLAGS = ['computer_use', 'plugins', 'tool_call_mcp_elicitation'];
const REQUEST_TIMEOUT_MS = Number(process.env.CODEX_CU_MCP_TIMEOUT_MS || 90_000);
const READ_ONLY_TOOLS = new Set(['list_apps', 'get_app_state']);
const POINTER_TOOLS = new Set(['click', 'drag']);
const ELEMENT_INDEX_SCHEMA = { type: ['string', 'number'], description: 'Computer Use element index. The wrapper coerces numbers to strings before calling upstream.' };
const ELEMENT_ALIAS_SCHEMA = { type: ['string', 'number'], description: 'Alias for element_index. Coerced to string before calling upstream.' };

if (process.argv.includes('-h') || process.argv.includes('--help')) {
  process.stdout.write(`macuse Codex Computer Use MCP wrapper ${VERSION}\n\nUsage:\n  node tools/codex-computer-use-appserver-mcp.mjs\n\nThis is a stdio MCP server. Configure it in Cursor or another MCP client; do\nnot run it directly except for --help or syntax checks.\n\nEnvironment:\n  CODEX_BIN          Codex app-server binary. Default: ${DEFAULT_CODEX_BIN}\n  CODEX_CU_MCP_CWD  Thread cwd. Default: current working directory.\n\nGenerate client config:\n  node tools/macuse-config.mjs cursor --pretty\n\nValidate:\n  node tools/validate-macuse.mjs mcp\n`);
  process.exit(0);
}

const TOOL_SCHEMAS = {
  list_apps: {
    name: 'list_apps',
    description: 'List apps known to Codex Computer Use. Read-only.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  get_app_state: {
    name: 'get_app_state',
    description: 'Start/refresh a Computer Use session for an app and return accessibility tree plus screenshot. Read-only but may reveal visible app contents. Default approval:"inherit" auto-accepts app approvals to match Codex Any App.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        app: { type: 'string', description: 'App name, bundle identifier, or full app path.' },
        approval: { type: 'string', enum: ['inherit', 'accept-all', 'ask', 'deny', 'accept-once'], description: 'How to answer Computer Use app-approval prompts. Default inherit auto-accepts app approvals to match Codex Any App.' },
      },
      required: ['app'],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  perform_secondary_action: {
    name: 'perform_secondary_action',
    description: 'Invoke an accessibility secondary action on an element. Prefer action:"Press" over pointer click when available to preserve mouse focus. Requires prior get_app_state for the same app.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { app: { type: 'string' }, element_index: ELEMENT_INDEX_SCHEMA, element: ELEMENT_ALIAS_SCHEMA, action: { type: 'string' } }, required: ['app', 'action'] },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  press_key: {
    name: 'press_key',
    description: 'Press a key or key combination in the target app. Requires prior get_app_state for the same app.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { app: { type: 'string' }, key: { type: 'string' } }, required: ['app', 'key'] },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  type_text: {
    name: 'type_text',
    description: 'Type literal text in the target app. Requires prior get_app_state for the same app.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { app: { type: 'string' }, text: { type: 'string' } }, required: ['app', 'text'] },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  set_value: {
    name: 'set_value',
    description: 'Set the value of a settable accessibility element. Requires prior get_app_state for the same app.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { app: { type: 'string' }, element_index: ELEMENT_INDEX_SCHEMA, element: ELEMENT_ALIAS_SCHEMA, value: { type: 'string' } }, required: ['app', 'value'] },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  select_text: {
    name: 'select_text',
    description: 'Select text in a text element, or place cursor before/after it. Requires prior get_app_state for the same app.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        app: { type: 'string' }, element_index: ELEMENT_INDEX_SCHEMA, element: ELEMENT_ALIAS_SCHEMA, text: { type: 'string' },
        prefix: { type: 'string' }, suffix: { type: 'string' }, selection: { type: 'string', enum: ['text', 'cursor_before', 'cursor_after'] },
      },
      required: ['app', 'text'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  scroll: {
    name: 'scroll',
    description: 'Scroll an element by direction/pages. Requires prior get_app_state for the same app.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { app: { type: 'string' }, element_index: ELEMENT_INDEX_SCHEMA, element: ELEMENT_ALIAS_SCHEMA, direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] }, pages: { type: 'number' } }, required: ['app', 'direction'] },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  click: {
    name: 'click',
    description: 'Pointer click by element index or screenshot coordinates. Prefer perform_secondary_action when possible. Requires allowPointer:true and prior get_app_state for the same app. Mouse position is restored after the call.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { app: { type: 'string' }, element_index: ELEMENT_INDEX_SCHEMA, element: ELEMENT_ALIAS_SCHEMA, x: { type: 'number' }, y: { type: 'number' }, mouse_button: { type: 'string', enum: ['left', 'right', 'middle'] }, click_count: { type: 'integer' }, allowPointer: { type: 'boolean' } }, required: ['app', 'allowPointer'] },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  drag: {
    name: 'drag',
    description: 'Pointer drag using screenshot coordinates. Requires allowPointer:true and prior get_app_state for the same app. Mouse position is restored after the call.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { app: { type: 'string' }, from_x: { type: 'number' }, from_y: { type: 'number' }, to_x: { type: 'number' }, to_y: { type: 'number' }, allowPointer: { type: 'boolean' } }, required: ['app', 'from_x', 'from_y', 'to_x', 'to_y', 'allowPointer'] },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
};

function log(event, details) {
  const suffix = details === undefined ? '' : ` ${JSON.stringify(details).slice(0, 1000)}`;
  process.stderr.write(`${new Date().toISOString()} ${event}${suffix}\n`);
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function rpcError(id, code, message, data) {
  send({ jsonrpc: '2.0', id, error: { code, message, data } });
}

function getMousePosition() {
  const script = 'import CoreGraphics; if let e = CGEvent(source: nil) { let p = e.location; print(Int(p.x), Int(p.y)) }';
  const result = spawnSync('swift', ['-e', script], { encoding: 'utf8', timeout: 10000 });
  if (result.status !== 0) return null;
  const [x, y] = result.stdout.trim().split(/\s+/).map((part) => Number(part));
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

function restoreMousePosition(position) {
  if (!position) return false;
  const script = `import CoreGraphics; CGWarpMouseCursorPosition(CGPoint(x: ${Math.trunc(position.x)}, y: ${Math.trunc(position.y)})); CGAssociateMouseAndMouseCursorPosition(1)`;
  const result = spawnSync('swift', ['-e', script], { encoding: 'utf8', timeout: 10000 });
  return result.status === 0;
}

function normalizeToolArguments(args) {
  const normalized = { ...args };
  if (normalized.element_index === undefined && normalized.element !== undefined) {
    normalized.element_index = normalized.element;
    delete normalized.element;
  }
  if (normalized.element_index !== undefined && normalized.element_index !== null) normalized.element_index = String(normalized.element_index);
  return normalized;
}

class AppServerClient {
  constructor({ codexBin, cwd, elicitationHandler }) {
    this.codexBin = codexBin;
    this.cwd = cwd;
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
    this.threadId = null;
    this.currentApproval = 'deny';
    this.acceptedElicitations = 0;
    this.elicitationHandler = elicitationHandler;
  }

  async ensureThread() {
    if (this.threadId) return this.threadId;
    accessSync(this.codexBin, constants.X_OK);
    const args = ['app-server'];
    for (const flag of FEATURE_FLAGS) args.push('--enable', flag);
    this.proc = spawn(this.codexBin, args, { cwd: this.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stderr.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => this.onStdout(chunk));
    this.proc.stderr.on('data', (chunk) => log('appserver.stderr', chunk.toString().trim()));
    this.proc.on('exit', (code, signal) => {
      for (const pending of this.pending.values()) pending.reject(new Error(`app-server exited code=${code} signal=${signal}`));
      this.pending.clear();
      this.threadId = null;
    });
    await this.request('initialize', { clientInfo: { name: 'macuse-appserver-mcp', version: VERSION }, capabilities: { experimental_api: true, mcp_elicitations: true } }, 15_000);
    this.notify('notifications/initialized', {});
    const start = await this.request('thread/start', {
      cwd: this.cwd,
      ephemeral: true,
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
      config: { features: { computer_use: true, plugins: true, tool_call_mcp_elicitation: true } },
    }, 45_000);
    this.threadId = start?.thread?.id;
    if (!this.threadId) throw new Error('thread/start response missing thread.id');
    return this.threadId;
  }

  onStdout(chunk) {
    this.buffer += chunk;
    for (;;) {
      const idx = this.buffer.indexOf('\n');
      if (idx === -1) break;
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { log('appserver.invalid_json', line); continue; }
      if (Object.prototype.hasOwnProperty.call(msg, 'id') && (Object.prototype.hasOwnProperty.call(msg, 'result') || Object.prototype.hasOwnProperty.call(msg, 'error')) && this.pending.has(msg.id)) {
        const pending = this.pending.get(msg.id);
        clearTimeout(pending.timer);
        this.pending.delete(msg.id);
        if (msg.error) pending.reject(new Error(msg.error.message || 'app-server JSON-RPC error'));
        else pending.resolve(msg.result);
      } else if (Object.prototype.hasOwnProperty.call(msg, 'id') && msg.method) {
        void this.onServerRequest(msg);
      } else if (msg.method) {
        log('appserver.notification', { method: msg.method, params: msg.params });
      }
    }
  }

  async onServerRequest(request) {
    if (request.method === 'mcpServer/elicitation/request') {
      const result = await this.elicitationHandler(request.params, this.currentApproval, this);
      this.write({ jsonrpc: '2.0', id: request.id, result });
      return;
    }
    this.write({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: `not implemented: ${request.method}` } });
  }

  write(message) {
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  notify(method, params) {
    this.write({ jsonrpc: '2.0', method, params });
  }

  request(method, params, timeoutMs = REQUEST_TIMEOUT_MS) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  async callTool(tool, args = {}) {
    const threadId = await this.ensureThread();
    this.currentApproval = args.approval || 'inherit';
    this.acceptedElicitations = 0;
    const result = await this.request('mcpServer/tool/call', { threadId, server: 'computer-use', tool, arguments: stripWrapperArgs(args) }, REQUEST_TIMEOUT_MS);
    this.currentApproval = 'deny';
    return result;
  }

  stop() {
    if (this.proc && this.proc.exitCode === null && this.proc.signalCode === null) this.proc.kill('SIGTERM');
  }
}

function stripWrapperArgs(args) {
  const out = { ...args };
  delete out.approval;
  delete out.allowPointer;
  return out;
}

let clientSupportsElicitation = false;
let clientNextId = 1;
const clientPending = new Map();

async function handleElicitation(params, mode, appServerClient) {
  if (mode === 'inherit' || mode === 'accept-all') {
    appServerClient.acceptedElicitations += 1;
    return { action: 'accept', content: {}, _meta: null };
  }
  if (mode === 'accept-once' && appServerClient.acceptedElicitations < 1) {
    appServerClient.acceptedElicitations += 1;
    return { action: 'accept', content: {}, _meta: null };
  }
  if (mode === 'ask' && clientSupportsElicitation) {
    try {
      const response = await clientRequest('elicitation/create', {
        _meta: params?._meta,
        message: params?.message || 'Allow Codex Computer Use?',
        requestedSchema: params?.requestedSchema || { type: 'object', properties: {} },
      }, REQUEST_TIMEOUT_MS);
      return {
        action: response?.action || 'decline',
        content: response?.content ?? null,
        _meta: response?._meta ?? null,
      };
    } catch (error) {
      log('client.elicitation_failed', error.message || String(error));
    }
  }
  return { action: 'decline', content: null, _meta: null };
}

function clientRequest(method, params, timeoutMs = REQUEST_TIMEOUT_MS) {
  const id = `macuse-${clientNextId++}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      clientPending.delete(id);
      reject(new Error(`${method} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    clientPending.set(id, { resolve, reject, timer });
    send({ jsonrpc: '2.0', id, method, params });
  });
}

const appServer = new AppServerClient({ codexBin: process.env.CODEX_BIN || DEFAULT_CODEX_BIN, cwd: process.env.CODEX_CU_MCP_CWD || DEFAULT_CWD, elicitationHandler: handleElicitation });
let stdinBuffer = '';

async function handleRequest(message) {
  const { id, method, params = {} } = message;
  try {
    if (method === 'initialize') {
      clientSupportsElicitation = Boolean(params?.capabilities?.elicitation);
      send({ jsonrpc: '2.0', id, result: { protocolVersion: params.protocolVersion || '2025-06-18', capabilities: { tools: { listChanged: false }, elicitation: clientSupportsElicitation ? { form: {} } : undefined }, serverInfo: { name: 'macuse-codex-computer-use', version: VERSION } } });
      return;
    }
    if (method === 'tools/list') {
      send({ jsonrpc: '2.0', id, result: { tools: Object.values(TOOL_SCHEMAS) } });
      return;
    }
    if (method === 'tools/call') {
      const name = params.name;
      const args = normalizeToolArguments(params.arguments || {});
      if (!TOOL_SCHEMAS[name]) throw new Error(`unknown tool: ${name}`);
      if (POINTER_TOOLS.has(name) && args.allowPointer !== true) throw new Error(`${name} requires allowPointer:true; prefer non-pointer actions when possible`);
      const mouseBefore = POINTER_TOOLS.has(name) ? getMousePosition() : null;
      let result;
      try {
        result = await appServer.callTool(name, args);
      } finally {
        if (mouseBefore) restoreMousePosition(mouseBefore);
      }
      send({ jsonrpc: '2.0', id, result });
      return;
    }
    if (method?.startsWith('notifications/')) return;
    rpcError(id, -32601, `method not found: ${method}`);
  } catch (error) {
    rpcError(id, -32000, error.message || String(error));
  }
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  stdinBuffer += chunk;
  for (;;) {
    const idx = stdinBuffer.indexOf('\n');
    if (idx === -1) break;
    const line = stdinBuffer.slice(0, idx).trim();
    stdinBuffer = stdinBuffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch (error) { rpcError(null, -32700, `parse error: ${error.message}`); continue; }
    if (Object.prototype.hasOwnProperty.call(msg, 'id') && (Object.prototype.hasOwnProperty.call(msg, 'result') || Object.prototype.hasOwnProperty.call(msg, 'error')) && clientPending.has(msg.id)) {
      const pending = clientPending.get(msg.id);
      clearTimeout(pending.timer);
      clientPending.delete(msg.id);
      if (msg.error) pending.reject(new Error(msg.error.message || 'client JSON-RPC error'));
      else pending.resolve(msg.result);
    } else if (Object.prototype.hasOwnProperty.call(msg, 'id')) {
      void handleRequest(msg);
    }
  }
});

process.on('exit', () => appServer.stop());
process.on('SIGTERM', () => { appServer.stop(); process.exit(0); });
process.on('SIGINT', () => { appServer.stop(); process.exit(130); });
