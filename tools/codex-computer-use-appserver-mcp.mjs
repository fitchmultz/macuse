#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import process from 'node:process';
import { DEFAULT_CODEX_BIN, MCP_SERVERS, VERSION, mcpServerConfigs, mcpServerForTool } from './macuse-utils.mjs';
import { pickUpstreamToolArgs } from '../extensions/codex-computer-use-modules/upstream-tool-args.mjs';
import {
  appServerSessionRecoverySummary,
  BridgeComputerUseSession,
  isolatedThreadConfig,
  validateBridgeArguments,
  sanitizeComputerUseText,
  withReadOnlyComputerUseRecovery,
} from './cu-helpers.mjs';

const DEFAULT_CWD = process.cwd();
const FEATURE_FLAGS = ['computer_use', 'plugins', 'tool_call_mcp_elicitation'];
const REQUEST_TIMEOUT_MS = positiveEnvDuration('CODEX_CU_MCP_TIMEOUT_MS', 90_000);
const STOP_FORCE_MS = positiveEnvDuration('MACUSE_MCP_TEST_STOP_FORCE_MS', 3_000);
const POINTER_TOOLS = new Set(['click', 'drag']);
const MUTATING_COMPUTER_USE_TOOLS = new Set(MCP_SERVERS['computer-use'].tools.filter((tool) => tool !== 'list_apps' && tool !== 'get_app_state'));
const MUTATION_GUARD_PROPERTIES = {
  allowMutating: { type: 'boolean', description: 'Must be true. Explicitly authorizes this guarded app mutation.' },
  safetyNote: { type: 'string', minLength: 20, description: 'Target app, intended effect, and stop boundary.' },
  expectedTitle: { type: 'string', description: 'Require this exact window title before mutation.' },
  expectedUrl: { type: 'string', description: 'Require this exact document URL before mutation.' },
  expectedRole: { type: 'string' }, expectedName: { type: 'string' }, expectedDescription: { type: 'string' }, expectedId: { type: 'string' }, expectedValue: { type: 'string' },
  requireStateChange: { type: 'boolean', description: 'Require relevant target/document change, not unrelated visible text.' },
};
const MUTATION_GUARD_REQUIRED = ['allowMutating', 'safetyNote'];
const ELEMENT_INDEX_SCHEMA = { type: ['string', 'number'], description: 'Computer Use element index. The wrapper coerces numbers to strings before calling upstream.' };
const ELEMENT_ALIAS_SCHEMA = { type: ['string', 'number'], description: 'Alias for element_index. Coerced to string before calling upstream.' };
const ELEMENT_ID_SCHEMA = { type: 'string', description: 'Stable element ID from get_app_state, resolved to the current element_index before calling upstream.' };
const ELEMENT_DESCRIPTION_SCHEMA = { type: 'string', description: 'Exact case-insensitive element description from get_app_state, resolved to the current element_index before calling upstream.' };

function positiveEnvDuration(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

if (process.argv.includes('-h') || process.argv.includes('--help')) {
  process.stdout.write(`macuse Codex Computer Use MCP wrapper ${VERSION}\n\nUsage:\n  node tools/codex-computer-use-appserver-mcp.mjs\n\nThis is a stdio MCP server exposing all 18 verified app-control, Record & Replay,\nand Computer History tools with local mutation, pointer, recording, and privacy guards. Configure it in\nCursor or another MCP client; do not run it directly except for --help or syntax\nchecks.\n\nEnvironment:\n  CODEX_BIN          Codex app-server binary. Default: ${DEFAULT_CODEX_BIN}\n  CODEX_CU_MCP_CWD  Thread cwd. Default: current working directory.\n\nGenerate client config:\n  node tools/macuse-config.mjs cursor --pretty\n\nValidate:\n  node tools/validate-macuse.mjs mcp\n`);
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
  },
  required: ['defaultApplicationBehavior', 'defaultURLBehavior', 'allowlist', 'blocklist'],
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
    description: 'Start/refresh a Computer Use session for an app and return accessibility tree plus screenshot. Read-only but may reveal visible app contents or launch/foreground an app; focus observation is not an isolation guarantee. Default approval:"inherit" auto-accepts under the standing macuse app-access policy.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        app: { type: 'string', description: 'App name, bundle identifier, or full app path.' },
        approval: { type: 'string', enum: ['inherit', 'accept-all', 'ask', 'deny', 'accept-once'], description: 'How to answer Computer Use app-approval prompts. Default inherit auto-accepts under the standing macuse app-access policy.' },
      },
      required: ['app'],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  perform_secondary_action: {
    name: 'perform_secondary_action',
    description: 'Invoke an accessibility secondary action on an element. Prefer action:"Press" over pointer click when available to avoid pointer input; focus isolation is not guaranteed. Stable IDs/descriptions are resolved against a fresh get_app_state.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { app: { type: 'string' }, element_index: ELEMENT_INDEX_SCHEMA, element: ELEMENT_ALIAS_SCHEMA, elementId: ELEMENT_ID_SCHEMA, element_id: ELEMENT_ID_SCHEMA, elementDescription: ELEMENT_DESCRIPTION_SCHEMA, element_description: ELEMENT_DESCRIPTION_SCHEMA, action: { type: 'string' }, ...MUTATION_GUARD_PROPERTIES }, required: ['app', 'action', ...MUTATION_GUARD_REQUIRED] },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  press_key: {
    name: 'press_key',
    description: 'Press a key or key combination in the target app. Requires prior get_app_state for the same app. Uses xdotool-style combos such as super+comma; key:",", modifiers:["COMMAND"] normalizes to that form.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { app: { type: 'string' }, key: { type: 'string' }, modifiers: { type: 'array', items: { type: 'string' } }, ...MUTATION_GUARD_PROPERTIES }, required: ['app', 'key', ...MUTATION_GUARD_REQUIRED] },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  type_text: {
    name: 'type_text',
    description: 'Insert literal text through native Accessibility selection replacement when supported, with exact readback. Unsupported Unicode fails before typing; ASCII may use upstream keyboard input. No replay after an attempted native edit.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { app: { type: 'string' }, text: { type: 'string' }, ...MUTATION_GUARD_PROPERTIES }, required: ['app', 'text', ...MUTATION_GUARD_REQUIRED] },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  set_value: {
    name: 'set_value',
    description: 'Set the value of a settable accessibility element. Stable IDs/descriptions are resolved against a fresh get_app_state.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { app: { type: 'string' }, element_index: ELEMENT_INDEX_SCHEMA, element: ELEMENT_ALIAS_SCHEMA, elementId: ELEMENT_ID_SCHEMA, element_id: ELEMENT_ID_SCHEMA, elementDescription: ELEMENT_DESCRIPTION_SCHEMA, element_description: ELEMENT_DESCRIPTION_SCHEMA, value: { type: 'string' }, ...MUTATION_GUARD_PROPERTIES }, required: ['app', 'value', ...MUTATION_GUARD_REQUIRED] },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  select_text: {
    name: 'select_text',
    description: 'Select text in a text element, or place cursor before/after it. Stable IDs/descriptions are resolved against a fresh get_app_state when provided.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        app: { type: 'string' }, element_index: ELEMENT_INDEX_SCHEMA, element: ELEMENT_ALIAS_SCHEMA, elementId: ELEMENT_ID_SCHEMA, element_id: ELEMENT_ID_SCHEMA, elementDescription: ELEMENT_DESCRIPTION_SCHEMA, element_description: ELEMENT_DESCRIPTION_SCHEMA, text: { type: 'string' },
        prefix: { type: 'string' }, suffix: { type: 'string' }, selection: { type: 'string', enum: ['text', 'cursor_before', 'cursor_after'] }, ...MUTATION_GUARD_PROPERTIES,
      },
      required: ['app', 'text', ...MUTATION_GUARD_REQUIRED],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  scroll: {
    name: 'scroll',
    description: 'Scroll an element by direction/pages. Stable IDs/descriptions are resolved against a fresh get_app_state when provided.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { app: { type: 'string' }, element_index: ELEMENT_INDEX_SCHEMA, element: ELEMENT_ALIAS_SCHEMA, elementId: ELEMENT_ID_SCHEMA, element_id: ELEMENT_ID_SCHEMA, elementDescription: ELEMENT_DESCRIPTION_SCHEMA, element_description: ELEMENT_DESCRIPTION_SCHEMA, direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] }, pages: { type: 'number' }, ...MUTATION_GUARD_PROPERTIES }, required: ['app', 'direction', ...MUTATION_GUARD_REQUIRED] },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  click: {
    name: 'click',
    description: 'Pointer click by element index, stable target, or screenshot coordinates. Prefer perform_secondary_action when possible. Requires allowPointer:true. No cursor/focus restoration; may interfere with user input.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { app: { type: 'string' }, element_index: ELEMENT_INDEX_SCHEMA, element: ELEMENT_ALIAS_SCHEMA, elementId: ELEMENT_ID_SCHEMA, element_id: ELEMENT_ID_SCHEMA, elementDescription: ELEMENT_DESCRIPTION_SCHEMA, element_description: ELEMENT_DESCRIPTION_SCHEMA, x: { type: 'number' }, y: { type: 'number' }, mouse_button: { type: 'string', enum: ['left', 'right', 'middle'] }, click_count: { type: 'integer' }, allowPointer: { type: 'boolean' }, ...MUTATION_GUARD_PROPERTIES }, required: ['app', 'allowPointer', ...MUTATION_GUARD_REQUIRED] },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  event_stream_start: auxiliarySchema('event_stream_start', 'Start up to 30 minutes of Record & Replay activity recording, or return the active session. Requires allowRecording:true and a non-empty safetyNote.', false, { allowRecording: { type: 'boolean' }, safetyNote: { type: 'string' } }, ['allowRecording', 'safetyNote']),
  event_stream_status: auxiliarySchema('event_stream_status', 'Read current or recent Record & Replay status, duration, and artifact paths. Read-only, but exposes activity metadata.', true),
  event_stream_stop: auxiliarySchema('event_stream_stop', 'Stop Record & Replay. Does not require allowRecording.', false, {}, [], true),
  computer_history_pause: auxiliarySchema('computer_history_pause', 'Pause Computer History. Does not require allowRecording.', false, {}, [], true),
  computer_history_resume: auxiliarySchema('computer_history_resume', 'Resume Computer History recording. Requires allowRecording:true and a non-empty safetyNote.', false, { allowRecording: { type: 'boolean' }, safetyNote: { type: 'string' } }, ['allowRecording', 'safetyNote'], true),
  computer_history_status: auxiliarySchema('computer_history_status', 'Read Computer History status and recent local activity paths. Read-only, but exposes activity metadata.', true),
  computer_history_get_settings: auxiliarySchema('computer_history_get_settings', 'Read Computer History observation settings. Read-only, but exposes privacy metadata.', true),
  computer_history_update_settings: auxiliarySchema('computer_history_update_settings', 'Replace all Computer History settings. Call computer_history_get_settings immediately first and preserve unchanged observation fields. Requires allowPrivacyChange:true and a non-empty safetyNote.', false, { observation: OBSERVATION_SCHEMA, allowPrivacyChange: { type: 'boolean' }, safetyNote: { type: 'string' } }, ['observation', 'allowPrivacyChange', 'safetyNote'], true),
  drag: {
    name: 'drag',
    description: 'Pointer drag using screenshot coordinates. Requires allowPointer:true and prior get_app_state for the same app. No cursor/focus restoration; may interfere with user input.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { app: { type: 'string' }, from_x: { type: 'number' }, from_y: { type: 'number' }, to_x: { type: 'number' }, to_y: { type: 'number' }, allowPointer: { type: 'boolean' }, ...MUTATION_GUARD_PROPERTIES }, required: ['app', 'from_x', 'from_y', 'to_x', 'to_y', 'allowPointer', ...MUTATION_GUARD_REQUIRED] },
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
  return { ...result, content, isError: forcedError || Boolean(result?.isError || result?.is_error) };
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
    this.initializing = null;
    this.stopping = null;
    this.closed = false;
    this.currentApproval = 'deny';
    this.acceptedElicitations = 0;
    this.elicitationHandler = elicitationHandler;
    this.approvalEpoch = 0;
    this.abandoned = false;
  }

  async ensureThread() {
    if (this.closed) throw new Error('app-server client is shutting down');
    if (this.stopping) await this.stopping;
    if (this.threadId) return this.threadId;
    if (this.initializing) return this.initializing;
    const initializing = this.startThread();
    this.initializing = initializing;
    try {
      return await initializing;
    } finally {
      if (this.initializing === initializing) this.initializing = null;
    }
  }

  async startThread() {
    accessSync(this.codexBin, constants.X_OK);
    const args = ['app-server', '--disable', 'apps'];
    for (const flag of FEATURE_FLAGS) args.push('--enable', flag);
    const proc = spawn(this.codexBin, args, { cwd: this.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = proc;
    this.buffer = '';
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => { if (this.proc === proc) this.onStdout(chunk); });
    proc.stderr.on('data', (chunk) => log('appserver.stderr', chunk.toString().trim()));
    proc.on('error', (error) => {
      // A failed spawn has no live transport; a kill error is NOT proof of exit.
      if (!proc.pid) this.failProcess(proc, error);
      else log('appserver.process_error', error.message);
    });
    proc.stdin.on('error', () => { void this.stop(); });
    proc.on('exit', (code, signal) => this.failProcess(proc, new Error(`app-server exited code=${code} signal=${signal}`)));
    try {
      await this.request('initialize', { clientInfo: { name: 'macuse-appserver-mcp', version: VERSION }, capabilities: { experimentalApi: true, requestAttestation: false } }, 15_000);
      this.notify('initialized', {});
      const configRead = await this.request('config/read', { cwd: this.cwd, includeLayers: false }, 15_000);
      const start = await this.request('thread/start', {
        cwd: this.cwd,
        ephemeral: true,
        approvalPolicy: 'on-request',
        sandbox: 'workspace-write',
        config: isolatedThreadConfig(configRead, mcpServerConfigs()),
      }, 45_000);
      const threadId = start?.thread?.id;
      if (!threadId) throw new Error('thread/start response missing thread.id');
      await this.waitForConfiguredServers(threadId, 45_000);
      if (this.proc !== proc) throw new Error('app-server exited during initialization');
      this.threadId = threadId;
      return threadId;
    } catch (error) {
      if (this.proc === proc) await this.stop();
      throw error;
    }
  }

  async waitForConfiguredServers(threadId, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const servers = [];
      let cursor;
      for (let page = 0; page < 10; page += 1) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        const status = await this.request('mcpServerStatus/list', { threadId, detail: 'toolsAndAuthOnly', limit: 100, ...(cursor ? { cursor } : {}) }, Math.min(30_000, Math.max(1_000, remaining)));
        servers.push(...(status?.data || []));
        cursor = status?.nextCursor;
        if (!cursor) break;
      }
      const missing = Object.entries(MCP_SERVERS).filter(([name, expected]) => {
        const server = servers.find((candidate) => candidate.name === name);
        const tools = server?.tools ? Object.keys(server.tools) : [];
        return !server || expected.tools.some((tool) => !tools.includes(tool));
      });
      if (missing.length === 0) return;
      if (Date.now() >= deadline) throw new Error(`configured MCP servers did not become ready: ${missing.map(([name]) => name).join(', ')}`);
      await new Promise((resolve) => setTimeout(resolve, Math.min(250, deadline - Date.now())));
    }
  }

  failProcess(proc, error) {
    for (const [id, pending] of this.pending) {
      if (pending.proc !== proc) continue;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(pending.timeoutError || Object.assign(error, { details: { dispatched: pending.method === 'mcpServer/tool/call', outcomeUnknown: pending.method === 'mcpServer/tool/call' } }));
    }
    if (this.proc === proc) {
      this.proc = null;
      this.threadId = null;
    }
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
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) { log('appserver.invalid_message'); continue; }
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
    const proc = this.proc;
    const epoch = this.approvalEpoch;
    try {
      if (request.method === 'mcpServer/elicitation/request') {
        let result = await this.elicitationHandler(request.params, this.abandoned ? 'deny' : this.currentApproval, this);
        if (this.abandoned || epoch !== this.approvalEpoch || proc !== this.proc) result = { action: 'decline', content: null, _meta: null };
        this.write({ jsonrpc: '2.0', id: request.id, result }, proc);
        return;
      }
      this.write({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: `not implemented: ${request.method}` } }, proc);
    } catch { /* The owned transport may have stopped while the client considered approval. */ }
  }

  write(message, proc = this.proc) {
    if (!proc?.stdin?.writable) throw new Error('app-server stdin is unavailable');
    proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  notify(method, params) {
    this.write({ jsonrpc: '2.0', method, params });
  }

  request(method, params, timeoutMs = REQUEST_TIMEOUT_MS) {
    const id = this.nextId++;
    const proc = this.proc;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.abandoned = true;
        this.currentApproval = 'deny';
        this.approvalEpoch++;
        const pending = this.pending.get(id);
        if (!pending) return;
        pending.timeoutError = Object.assign(new Error(`${method} timed out after ${timeoutMs}ms; owned transport stopped, action outcome unknown`), { details: { dispatched: method === 'mcpServer/tool/call', outcomeUnknown: method === 'mcpServer/tool/call' } });
        // Keep the promise (and tools/call queue) owned until the child really exits.
        // No unsupported MCP cancellation RPC; late approvals are declined.
        void this.stop();
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, proc, method });
      try {
        this.write({ jsonrpc: '2.0', id, method, params }, proc);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
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
        this.abandoned = false;
        this.approvalEpoch++;
        this.acceptedElicitations = 0;
        try {
          const server = mcpServerForTool(tool);
          return sanitizeComputerUseResult(await this.request('mcpServer/tool/call', { threadId, server, tool, arguments: pickUpstreamToolArgs(tool, args) }, REQUEST_TIMEOUT_MS));
        } finally {
          this.currentApproval = 'deny';
          this.approvalEpoch++;
        }
      },
    });
  }

  async stop() {
    if (this.stopping) return this.stopping;
    const stopping = this.stopProcess();
    this.stopping = stopping;
    try {
      await stopping;
    } finally {
      if (this.stopping === stopping) this.stopping = null;
    }
  }

  async close() {
    this.closed = true;
    await this.stop();
  }

  async stopProcess() {
    const proc = this.proc;
    this.proc = null;
    this.threadId = null;
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
    await new Promise((resolve) => {
      const finish = () => {
        clearTimeout(forceTimer);
        resolve();
      };
      const forceTimer = setTimeout(() => {
        if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
      }, STOP_FORCE_MS);
      proc.once('exit', finish);
      proc.kill('SIGTERM');
    });
  }
}

function validateMutationGuard(tool, args) {
  if (!MUTATING_COMPUTER_USE_TOOLS.has(tool)) return;
  if (args.allowMutating !== true) throw new Error(`${tool} requires allowMutating:true`);
  if (String(args.safetyNote || '').trim().length < 20) throw new Error(`${tool} requires a safetyNote describing target, intended effect, and stop boundary`);
}

function validateAuxiliaryGuard(tool, args) {
  if (tool === 'event_stream_start' || tool === 'computer_history_resume') {
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
    || !validEntries(observation.allowlist) || !validEntries(observation.blocklist)) {
    throw new Error(`${tool} requires all Computer History settings fields and valid scope-specific allowlist/blocklist entries`);
  }
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
const session = new BridgeComputerUseSession((tool, args) => appServer.callTool(tool, args));
let stdinBuffer = '';
let toolCallQueue = Promise.resolve();
const toolRequests = new Map();
let activeToolRequest = null;

function dispatchRequest(message) {
  if (message.method !== 'tools/call') {
    void handleRequest(message);
    return;
  }
  const controller = new AbortController();
  toolRequests.set(message.id, controller);
  const call = toolCallQueue.then(async () => {
    activeToolRequest = message.id;
    try { await handleRequest(message, controller.signal); }
    finally { activeToolRequest = null; toolRequests.delete(message.id); }
  });
  toolCallQueue = call.catch(() => {});
}

async function handleRequest(message, signal) {
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
      signal?.throwIfAborted();
      const name = params.name;
      const args = params.arguments === undefined ? {} : params.arguments;
      if (!TOOL_SCHEMAS[name]) throw new Error(`unknown tool: ${name}`);
      validateBridgeArguments(name, args);
      validateMutationGuard(name, args);
      validateAuxiliaryGuard(name, args);
      if (POINTER_TOOLS.has(name) && args.allowPointer !== true) throw new Error(`${name} requires allowPointer:true; prefer non-pointer actions when possible`);
      const execution = await session.run(name, args, { signal });
      const result = { ...execution.result, _meta: { ...execution.result?._meta, macuse: { dispatched: execution.dispatched, outcome: execution.outcome, focus: execution.focus } } };
      send({ jsonrpc: '2.0', id, result });
      return;
    }
    if (method?.startsWith('notifications/')) return;
    rpcError(id, -32601, `method not found: ${method}`);
  } catch (error) {
    const sanitized = sanitizeComputerUseText(error.message || String(error));
    if (method === 'tools/call') send({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: sanitized.text }], _meta: { macuse: sanitized.forcedError ? undefined : error.details ?? { dispatched: false, outcome: 'not-dispatched' } } } });
    else rpcError(id, -32000, sanitized.text);
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
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) { rpcError(null, -32600, 'request must be an object'); continue; }
    if (Object.prototype.hasOwnProperty.call(msg, 'id') && (Object.prototype.hasOwnProperty.call(msg, 'result') || Object.prototype.hasOwnProperty.call(msg, 'error')) && clientPending.has(msg.id)) {
      const pending = clientPending.get(msg.id);
      clearTimeout(pending.timer);
      clientPending.delete(msg.id);
      if (msg.error) pending.reject(new Error(msg.error.message || 'client JSON-RPC error'));
      else pending.resolve(msg.result);
    } else if (Object.prototype.hasOwnProperty.call(msg, 'id')) {
      dispatchRequest(msg);
    } else if (msg.method === 'notifications/cancelled') {
      const requestId = msg.params?.requestId;
      const controller = toolRequests.get(requestId);
      if (controller) {
        controller.abort(new Error('MCP tool call cancelled. A dispatched action may already have taken effect; inspect state before retrying.'));
        if (activeToolRequest === requestId) {
          appServer.abandoned = true;
          appServer.currentApproval = 'deny';
          appServer.approvalEpoch++;
          // Native edits retain ownership until their promise settles. Upstream RPCs
          // retain it until owned transport termination; do not send a cancel RPC.
          void appServer.stop();
        }
      }
    }
  }
});

let shuttingDown = null;
function shutdown(code) {
  if (!shuttingDown) shuttingDown = Promise.all([appServer.close(), session.stop()]).finally(() => process.exit(code));
  return shuttingDown;
}

process.stdin.on('end', () => { void shutdown(0); });
process.on('SIGTERM', () => { void shutdown(0); });
process.on('SIGINT', () => { void shutdown(130); });
