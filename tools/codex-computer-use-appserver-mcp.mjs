#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import process from 'node:process';
import { DEFAULT_CODEX_BIN, MCP_SERVERS, VERSION, mcpServerConfigs } from './macuse-utils.mjs';
import {
  appServerSessionRecoverySummary,
  getMousePosition,
  normalizeToolArguments,
  resolveElementTarget,
  restoreMousePosition,
  sanitizeComputerUseText,
  targetsElement,
  toolResultText,
  updateElementCache,
  withReadOnlyComputerUseRecovery,
} from './cu-helpers.mjs';

const DEFAULT_CWD = process.cwd();
const FEATURE_FLAGS = ['computer_use', 'plugins', 'tool_call_mcp_elicitation'];
const REQUEST_TIMEOUT_MS = Number(process.env.CODEX_CU_MCP_TIMEOUT_MS || 90_000);
const POINTER_TOOLS = new Set(['click', 'drag']);
const ELEMENT_INDEX_SCHEMA = { type: ['string', 'number'], description: 'Computer Use element index. The wrapper coerces numbers to strings before calling upstream.' };
const ELEMENT_ALIAS_SCHEMA = { type: ['string', 'number'], description: 'Alias for element_index. Coerced to string before calling upstream.' };
const ELEMENT_ID_SCHEMA = { type: 'string', description: 'Stable element ID from get_app_state, resolved to the current element_index before calling upstream.' };
const ELEMENT_DESCRIPTION_SCHEMA = { type: 'string', description: 'Exact case-insensitive element description from get_app_state, resolved to the current element_index before calling upstream.' };

if (process.argv.includes('-h') || process.argv.includes('--help')) {
  process.stdout.write(`macuse Codex Computer Use MCP wrapper ${VERSION}\n\nUsage:\n  node tools/codex-computer-use-appserver-mcp.mjs\n\nThis is a stdio MCP server exposing all 20 verified app-control, Record & Replay,\nand Computer History tools with local pointer/recording/privacy guards. Configure it in\nCursor or another MCP client; do not run it directly except for --help or syntax\nchecks.\n\nEnvironment:\n  CODEX_BIN          Codex app-server binary. Default: ${DEFAULT_CODEX_BIN}\n  CODEX_CU_MCP_CWD  Thread cwd. Default: current working directory.\n\nGenerate client config:\n  node tools/macuse-config.mjs cursor --pretty\n\nValidate:\n  node tools/validate-macuse.mjs mcp\n`);
  process.exit(0);
}

function auxiliarySchema(name, description, readOnly, properties = {}, required = [], idempotent = readOnly) {
  return { name, description, inputSchema: { type: 'object', additionalProperties: false, properties, ...(required.length ? { required } : {}) }, annotations: { readOnlyHint: readOnly, destructiveHint: false, idempotentHint: idempotent, openWorldHint: false } };
}

const OBSERVATION_ENTRY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { scope: { type: 'string', enum: ['app', 'url'] }, bundleID: { type: 'string', description: 'Required for app rules.' }, urlDomain: { type: 'string', description: 'Required for URL rules. Use a domain without a scheme or path.' } },
  required: ['scope'],
};
const OBSERVATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    defaultApplicationBehavior: { type: 'string', enum: ['observe', 'do_not_observe'] },
    defaultURLBehavior: { type: 'string', enum: ['observe', 'do_not_observe'] },
    allowlist: { type: 'array', items: OBSERVATION_ENTRY_SCHEMA },
    blocklist: { type: 'array', items: OBSERVATION_ENTRY_SCHEMA },
    observePrivateBrowsing: { type: 'boolean' },
  },
  required: ['defaultApplicationBehavior', 'defaultURLBehavior', 'allowlist', 'blocklist', 'observePrivateBrowsing'],
};

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
    description: 'Invoke an accessibility secondary action on an element. Prefer action:"Press" over pointer click when available to preserve mouse focus. Stable IDs/descriptions are resolved against a fresh get_app_state.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { app: { type: 'string' }, element_index: ELEMENT_INDEX_SCHEMA, element: ELEMENT_ALIAS_SCHEMA, elementId: ELEMENT_ID_SCHEMA, element_id: ELEMENT_ID_SCHEMA, elementDescription: ELEMENT_DESCRIPTION_SCHEMA, element_description: ELEMENT_DESCRIPTION_SCHEMA, action: { type: 'string' } }, required: ['app', 'action'] },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  press_key: {
    name: 'press_key',
    description: 'Press a key or key combination in the target app. Requires prior get_app_state for the same app. Uses xdotool-style combos such as super+comma; key:",", modifiers:["COMMAND"] normalizes to that form.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { app: { type: 'string' }, key: { type: 'string' }, modifiers: { type: 'array', items: { type: 'string' } } }, required: ['app', 'key'] },
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
    description: 'Set the value of a settable accessibility element. Stable IDs/descriptions are resolved against a fresh get_app_state.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { app: { type: 'string' }, element_index: ELEMENT_INDEX_SCHEMA, element: ELEMENT_ALIAS_SCHEMA, elementId: ELEMENT_ID_SCHEMA, element_id: ELEMENT_ID_SCHEMA, elementDescription: ELEMENT_DESCRIPTION_SCHEMA, element_description: ELEMENT_DESCRIPTION_SCHEMA, value: { type: 'string' } }, required: ['app', 'value'] },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  select_text: {
    name: 'select_text',
    description: 'Select text in a text element, or place cursor before/after it. Stable IDs/descriptions are resolved against a fresh get_app_state when provided.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        app: { type: 'string' }, element_index: ELEMENT_INDEX_SCHEMA, element: ELEMENT_ALIAS_SCHEMA, elementId: ELEMENT_ID_SCHEMA, element_id: ELEMENT_ID_SCHEMA, elementDescription: ELEMENT_DESCRIPTION_SCHEMA, element_description: ELEMENT_DESCRIPTION_SCHEMA, text: { type: 'string' },
        prefix: { type: 'string' }, suffix: { type: 'string' }, selection: { type: 'string', enum: ['text', 'cursor_before', 'cursor_after'] },
      },
      required: ['app', 'text'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  scroll: {
    name: 'scroll',
    description: 'Scroll an element by direction/pages. Stable IDs/descriptions are resolved against a fresh get_app_state when provided.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { app: { type: 'string' }, element_index: ELEMENT_INDEX_SCHEMA, element: ELEMENT_ALIAS_SCHEMA, elementId: ELEMENT_ID_SCHEMA, element_id: ELEMENT_ID_SCHEMA, elementDescription: ELEMENT_DESCRIPTION_SCHEMA, element_description: ELEMENT_DESCRIPTION_SCHEMA, direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] }, pages: { type: 'number' } }, required: ['app', 'direction'] },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  click: {
    name: 'click',
    description: 'Pointer click by element index, stable target, or screenshot coordinates. Prefer perform_secondary_action when possible. Requires allowPointer:true. Mouse position is restored after the call.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { app: { type: 'string' }, element_index: ELEMENT_INDEX_SCHEMA, element: ELEMENT_ALIAS_SCHEMA, elementId: ELEMENT_ID_SCHEMA, element_id: ELEMENT_ID_SCHEMA, elementDescription: ELEMENT_DESCRIPTION_SCHEMA, element_description: ELEMENT_DESCRIPTION_SCHEMA, x: { type: 'number' }, y: { type: 'number' }, mouse_button: { type: 'string', enum: ['left', 'right', 'middle'] }, click_count: { type: 'integer' }, allowPointer: { type: 'boolean' } }, required: ['app', 'allowPointer'] },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  event_stream_start: auxiliarySchema('event_stream_start', 'Start Record & Replay activity recording. Requires allowRecording:true and a non-empty safetyNote.', false, { allowRecording: { type: 'boolean' }, safetyNote: { type: 'string' } }, ['allowRecording', 'safetyNote']),
  event_stream_status: auxiliarySchema('event_stream_status', 'Read Record & Replay status. Read-only, but exposes activity/artifact metadata.', true),
  event_stream_stop: auxiliarySchema('event_stream_stop', 'Stop Record & Replay. Does not require allowRecording.', false, {}, [], true),
  computer_history_start: auxiliarySchema('computer_history_start', 'Start Computer History recording. Requires allowRecording:true and a non-empty safetyNote.', false, { allowRecording: { type: 'boolean' }, safetyNote: { type: 'string' } }, ['allowRecording', 'safetyNote'], true),
  computer_history_stop: auxiliarySchema('computer_history_stop', 'Stop Computer History. Does not require allowRecording.', false, {}, [], true),
  computer_history_pause: auxiliarySchema('computer_history_pause', 'Pause Computer History. Does not require allowRecording.', false, {}, [], true),
  computer_history_resume: auxiliarySchema('computer_history_resume', 'Resume Computer History recording. Requires allowRecording:true and a non-empty safetyNote.', false, { allowRecording: { type: 'boolean' }, safetyNote: { type: 'string' } }, ['allowRecording', 'safetyNote'], true),
  computer_history_status: auxiliarySchema('computer_history_status', 'Read Computer History status. Read-only, but exposes activity metadata.', true),
  computer_history_get_settings: auxiliarySchema('computer_history_get_settings', 'Read Computer History settings. Read-only, but exposes privacy metadata.', true),
  computer_history_update_settings: auxiliarySchema('computer_history_update_settings', 'Replace all Computer History observation settings. Call computer_history_get_settings immediately first and preserve unchanged fields. Requires allowPrivacyChange:true and a non-empty safetyNote.', false, { observation: OBSERVATION_SCHEMA, allowPrivacyChange: { type: 'boolean' }, safetyNote: { type: 'string' } }, ['observation', 'allowPrivacyChange', 'safetyNote'], true),
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

function computerUseResultText(result) {
  return (result?.content || []).filter((block) => block?.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('\n');
}

function sanitizeComputerUseResult(result) {
  let forcedError = false;
  const content = (result?.content || []).map((block) => {
    if (block?.type !== 'text' || typeof block.text !== 'string') return block;
    const sanitized = sanitizeComputerUseText(block.text);
    forcedError = forcedError || sanitized.forcedError;
    return { ...block, text: sanitized.text };
  });
  return { ...result, content, ...(forcedError ? { isError: true } : {}) };
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
    const proc = spawn(this.codexBin, args, { cwd: this.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = proc;
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => this.onStdout(chunk));
    proc.stderr.on('data', (chunk) => log('appserver.stderr', chunk.toString().trim()));
    proc.on('exit', (code, signal) => {
      for (const pending of this.pending.values()) pending.reject(new Error(`app-server exited code=${code} signal=${signal}`));
      this.pending.clear();
      if (this.proc === proc) this.threadId = null;
    });
    await this.request('initialize', { clientInfo: { name: 'macuse-appserver-mcp', version: VERSION }, capabilities: { experimentalApi: true, requestAttestation: false } }, 15_000);
    this.notify('notifications/initialized', {});
    const start = await this.request('thread/start', {
      cwd: this.cwd,
      ephemeral: true,
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
      config: {
        features: { computer_use: true, plugins: true, tool_call_mcp_elicitation: true },
        mcp_servers: mcpServerConfigs(),
      },
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

  async recoverComputerUse(reason) {
    const recovery = appServerSessionRecoverySummary(reason);
    await this.stop();
    await this.ensureThread();
    return recovery;
  }

  async callTool(tool, args = {}) {
    return withReadOnlyComputerUseRecovery({
      tool,
      resultText: computerUseResultText,
      recover: (reason) => this.recoverComputerUse(reason),
      run: async () => {
        const threadId = await this.ensureThread();
        this.currentApproval = args.approval || 'inherit';
        this.acceptedElicitations = 0;
        try {
          const server = MCP_SERVERS['event-stream'].tools.includes(tool) ? 'event-stream' : MCP_SERVERS['computer-history'].tools.includes(tool) ? 'computer-history' : 'computer-use';
          return sanitizeComputerUseResult(await this.request('mcpServer/tool/call', { threadId, server, tool, arguments: stripWrapperArgs(args) }, REQUEST_TIMEOUT_MS));
        } finally {
          this.currentApproval = 'deny';
        }
      },
    });
  }

  async stop() {
    const proc = this.proc;
    this.proc = null;
    this.threadId = null;
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
    proc.kill('SIGTERM');
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
        resolve();
      }, 3000);
      proc.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
}

function validateAuxiliaryGuard(tool, args) {
  if (tool === 'event_stream_start' || tool === 'computer_history_start' || tool === 'computer_history_resume') {
    if (args.allowRecording !== true || !String(args.safetyNote || '').trim()) throw new Error(`${tool} requires allowRecording:true and a non-empty safetyNote`);
  }
  if (tool !== 'computer_history_update_settings') return;
  if (args.allowPrivacyChange !== true || !String(args.safetyNote || '').trim()) throw new Error(`${tool} requires allowPrivacyChange:true and a non-empty safetyNote`);
  const observation = args.observation;
  const validEntries = (value) => Array.isArray(value) && value.every((entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
    && ((entry.scope === 'app' && typeof entry.bundleID === 'string' && entry.bundleID.trim())
      || (entry.scope === 'url' && typeof entry.urlDomain === 'string' && entry.urlDomain.trim() && !entry.urlDomain.includes('://') && !entry.urlDomain.includes('/'))));
  if (!observation || !['observe', 'do_not_observe'].includes(observation.defaultApplicationBehavior)
    || !['observe', 'do_not_observe'].includes(observation.defaultURLBehavior)
    || !validEntries(observation.allowlist) || !validEntries(observation.blocklist)
    || typeof observation.observePrivateBrowsing !== 'boolean') {
    throw new Error(`${tool} requires all Computer History settings fields and valid scope-specific allowlist/blocklist entries`);
  }
}

function stripWrapperArgs(args) {
  const out = { ...args };
  delete out.approval;
  delete out.allowPointer;
  delete out.allowRecording;
  delete out.allowPrivacyChange;
  delete out.safetyNote;
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
const elementCache = new Map();
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
      let args = normalizeToolArguments(params.arguments || {});
      if (!TOOL_SCHEMAS[name]) throw new Error(`unknown tool: ${name}`);
      validateAuxiliaryGuard(name, args);
      if (POINTER_TOOLS.has(name) && args.allowPointer !== true) throw new Error(`${name} requires allowPointer:true; prefer non-pointer actions when possible`);
      if (targetsElement(name, args)) {
        const refresh = await appServer.callTool('get_app_state', { app: args.app, approval: args.approval || 'inherit' });
        updateElementCache(elementCache, args.app, toolResultText(refresh));
      }
      args = resolveElementTarget(args, elementCache);
      const mouseBefore = POINTER_TOOLS.has(name) ? getMousePosition() : null;
      let result;
      try {
        result = await appServer.callTool(name, args);
        updateElementCache(elementCache, args.app, toolResultText(result));
      } finally {
        if (mouseBefore) restoreMousePosition(mouseBefore);
      }
      send({ jsonrpc: '2.0', id, result });
      return;
    }
    if (method?.startsWith('notifications/')) return;
    rpcError(id, -32601, `method not found: ${method}`);
  } catch (error) {
    rpcError(id, -32000, sanitizeComputerUseText(error.message || String(error)).text);
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
