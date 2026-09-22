import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

const resources = process.env.MACUSE_CHATGPT_RESOURCES ?? '/Applications/ChatGPT.app/Contents/Resources';
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const servers = {
  'event-stream': { plugin: 'record-and-replay', tools: ['event_stream_start', 'event_stream_status', 'event_stream_stop'] },
  'computer-history': { plugin: 'computer-history', tools: ['computer_history_pause', 'computer_history_resume', 'computer_history_status', 'computer_history_get_settings', 'computer_history_update_settings'] },
};
const nonempty = { type: 'string', pattern: '\\S' };
const domainPattern = '^[^\\s/:?#@\\\\]+$';
const observationEntry = {
  type: 'object', additionalProperties: false,
  properties: { scope: { enum: ['app', 'url'] }, bundleID: { type: 'string' }, urlDomain: { type: 'string', description: 'A bare domain without a scheme or path.' } },
  required: ['scope'],
  anyOf: [
    { properties: { scope: { const: 'app' }, bundleID: nonempty }, required: ['bundleID'] },
    { properties: { scope: { const: 'url' }, urlDomain: { type: 'string', pattern: domainPattern } }, required: ['urlDomain'] },
  ],
};
const observationSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    defaultApplicationBehavior: { enum: ['observe', 'do_not_observe'] },
    defaultURLBehavior: { enum: ['observe', 'do_not_observe'] },
    allowlist: { type: 'array', items: observationEntry },
    blocklist: { type: 'array', items: observationEntry },
  },
  required: ['defaultApplicationBehavior', 'defaultURLBehavior', 'allowlist', 'blocklist'],
};
const recording = { allowRecording: { const: true, type: 'boolean' }, safetyNote: nonempty };
const descriptor = (name, description, readOnly, properties = {}, idempotent = readOnly) => ({
  name, description,
  inputSchema: { type: 'object', additionalProperties: false, properties, required: Object.keys(properties) },
  annotations: { readOnlyHint: readOnly, destructiveHint: false, idempotentHint: idempotent, openWorldHint: false },
});
export const auxiliaryTools = [
  descriptor('event_stream_start', 'Start Record & Replay recording (up to 30 minutes). Requires exact user intent, allowRecording:true, and a non-empty safetyNote.', false, recording),
  descriptor('event_stream_status', 'Read Record & Replay status and artifact paths. Exposes activity metadata.', true),
  descriptor('event_stream_stop', 'Stop Record & Replay. No recording approval flags required.', false, {}, true),
  descriptor('computer_history_pause', 'Pause Computer History. No recording approval flags required.', false, {}, true),
  descriptor('computer_history_resume', 'Resume Computer History recording. Requires exact user intent, allowRecording:true, and a non-empty safetyNote.', false, recording, true),
  descriptor('computer_history_status', 'Read Computer History status and activity paths. Exposes activity metadata.', true),
  descriptor('computer_history_get_settings', 'Read all Computer History observation settings. Exposes privacy metadata.', true),
  descriptor('computer_history_update_settings', 'Replace all Computer History observation settings. The caller must read fresh settings immediately first and preserve every unchanged field. Requires exact approval, allowPrivacyChange:true, and a non-empty safetyNote.', false, { observation: observationSchema, allowPrivacyChange: { const: true, type: 'boolean' }, safetyNote: nonempty }, true),
];
const tools = new Map(auxiliaryTools.map(tool => [tool.name, tool]));
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasText = value => typeof value === 'string' && /\S/.test(value);

function checkKeys(value, allowed, label) {
  if (!isObject(value)) throw new Error(`${label} must be an object.`);
  const unknown = Object.keys(value).filter(key => !allowed.includes(key));
  if (unknown.length) throw new Error(`Unsupported ${label} fields: ${unknown.join(', ')}.`);
}

/** Validate before launch and copy only pinned upstream arguments; never forward local approvals. */
export function validateAuxiliaryArguments(tool, input = {}) {
  const schema = tools.get(tool)?.inputSchema;
  if (!schema) throw new Error(`Unsupported auxiliary tool: ${tool}`);
  checkKeys(input, Object.keys(schema.properties), `${tool} arguments`);
  const flag = tool === 'computer_history_update_settings' ? 'allowPrivacyChange' : 'allowRecording';
  if (Object.hasOwn(schema.properties, flag) && (!Object.hasOwn(input, flag) || input[flag] !== true || !Object.hasOwn(input, 'safetyNote') || !hasText(input.safetyNote))) {
    throw new Error(`${tool} requires ${flag}:true and a non-empty safetyNote.`);
  }
  if (tool !== 'computer_history_update_settings') return {};
  const settings = input.observation;
  checkKeys(settings, observationSchema.required, 'observation');
  for (const key of observationSchema.required) {
    if (!Object.hasOwn(settings, key)) throw new Error(`observation.${key} is required; send all observation fields.`);
  }
  for (const key of ['defaultApplicationBehavior', 'defaultURLBehavior']) {
    if (!['observe', 'do_not_observe'].includes(settings[key])) throw new Error(`observation.${key} must be observe or do_not_observe.`);
  }
  const observation = { defaultApplicationBehavior: settings.defaultApplicationBehavior, defaultURLBehavior: settings.defaultURLBehavior };
  for (const key of ['allowlist', 'blocklist']) {
    if (!Array.isArray(settings[key])) throw new Error(`observation.${key} must be an array; send all observation fields.`);
    observation[key] = Array.from(settings[key], entry => {
      checkKeys(entry, ['scope', 'bundleID', 'urlDomain'], `observation.${key} entry`);
      entry = { ...entry };
      for (const field of ['bundleID', 'urlDomain']) {
        if (Object.hasOwn(entry, field) && typeof entry[field] !== 'string') throw new Error(`${field} must be a string.`);
      }
      if (entry.scope === 'app' && hasText(entry.bundleID)) return entry;
      if (entry.scope === 'url' && typeof entry.urlDomain === 'string' && new RegExp(domainPattern).test(entry.urlDomain)) return entry;
      throw new Error('Observation entries require scope:app with a non-empty bundleID, or scope:url with a bare-domain urlDomain.');
    });
  }
  return { observation };
}

const failure = (reason, message) => Object.assign(new Error(message), { reason });
const stoppedSentinel = 'This application session has been explicitly stopped by the user for this turn.';
const stoppedSession = text => String(text).includes(stoppedSentinel);
const sanitizeStopped = text => String(text).replaceAll(stoppedSentinel, 'The auxiliary application session is stopped. No tool result was returned. Refresh the session before retrying.');
const closedTransport = text => /\b(?:transport|connection|channel) closed\b/i.test(text);
const textOf = result => result.content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n');

export class AuxiliaryRuntime {
  #proc = null;
  #exited = null;
  #stopping = null;
  #threadId = null;
  #pending = new Map();
  #nextId = 1;
  #queue = Promise.resolve();
  #active = null;
  #stderr = '';

  constructor({ cwd = process.cwd(), codexBin = process.env.CODEX_BIN || join(resources, 'codex') } = {}) {
    this.cwd = cwd;
    this.codexBin = codexBin;
  }

  status() {
    return { running: Boolean(this.#proc && this.#proc.exitCode === null && this.#proc.signalCode === null), processPid: this.#proc?.pid ?? null, threadId: this.#threadId, pendingRequests: this.#pending.size, cwd: this.cwd, codexBin: this.codexBin, stderrTail: this.#stderr };
  }

  callTool(tool, input = {}, { signal, timeoutMs = 90_000 } = {}) {
    const context = { tool, started: Date.now(), controller: new AbortController(), dispatched: false, attempts: 0 };
    let args;
    try {
      args = validateAuxiliaryArguments(tool, input);
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) throw new Error('timeoutMs must be a positive finite duration no greater than 2147483647.');
    } catch (error) {
      return Promise.resolve(this.#errorResult(context, error));
    }
    return new Promise(resolve => {
      let active = false;
      let finished = false;
      const finish = result => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        context.controller.signal.removeEventListener('abort', onCancel);
        resolve(result);
      };
      const onCancel = () => {
        if (active) void this.#stopProcess();
        else finish(this.#errorResult(context, context.controller.signal.reason));
      };
      const onAbort = () => context.controller.abort(failure('aborted', 'Auxiliary call was aborted.'));
      const timer = setTimeout(() => context.controller.abort(failure('timeout', `Auxiliary call timed out after ${timeoutMs}ms.`)), timeoutMs);
      context.controller.signal.addEventListener('abort', onCancel, { once: true });
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
      this.#queue = this.#queue.then(async () => {
        if (finished) return;
        active = true;
        this.#active = context;
        try { finish(await this.#call(args, context)); }
        catch (error) {
          await this.#stopProcess();
          finish(this.#errorResult(context, context.controller.signal.aborted ? context.controller.signal.reason : error));
        } finally { this.#active = null; }
      });
    });
  }

  #result(context, result, outcome, reason) {
    const isError = Boolean(result.isError);
    return { ...result, isError, details: { macuse: { tool: context.tool, isError, dispatched: context.dispatched, outcome, ...(reason ? { reason } : {}), ...(context.missingTools?.length ? { missingTools: context.missingTools } : {}), attempts: context.attempts, durationMs: Date.now() - context.started } } };
  }

  #errorResult(context, error) {
    const missing = context.missingTools?.length ? ` Missing auxiliary tools: ${context.missingTools.join(', ')}.` : '';
    const message = `${sanitizeStopped(error.message || error)}${missing} ${context.dispatched ? 'A dispatched action may have taken effect; outcome unknown. Inspect status before retrying.' : 'No auxiliary action was sent.'}`;
    return this.#result(context, { content: [{ type: 'text', text: message }], isError: true }, context.dispatched ? 'unknown' : 'not_dispatched', error.reason || 'error');
  }

  async #call(args, context) {
    const { tool, controller } = context;
    for (;;) {
      controller.signal.throwIfAborted();
      context.attempts++;
      try {
        await this.#ensureThread(context);
        const server = Object.keys(servers).find(name => servers[name].tools.includes(tool));
        const result = await this.#request('mcpServer/tool/call', { threadId: this.#threadId, server, tool, arguments: args }, context);
        controller.signal.throwIfAborted();
        if (!isObject(result) || !Array.isArray(result.content)) throw failure('protocol-error', 'Auxiliary tool returned no content array.');
        const text = textOf(result);
        const isError = Boolean(result.isError || result.is_error || stoppedSession(text));
        if (isError && (stoppedSession(text) || closedTransport(text)) && tools.get(tool).annotations.readOnlyHint && context.attempts === 1) {
          await this.#stopProcess();
          continue;
        }
        const content = stoppedSession(text) ? result.content.map(block => block?.type === 'text' ? { ...block, text: sanitizeStopped(block.text) } : block) : result.content;
        return this.#result(context, { ...result, content, isError }, 'reported');
      } catch (error) {
        if (controller.signal.aborted || !tools.get(tool).annotations.readOnlyHint || context.attempts !== 1 || !(error.reason === 'transport-closed' || stoppedSession(error.message) || closedTransport(error.message))) throw error;
        await this.#stopProcess();
      }
    }
  }

  async #ensureThread(context) {
    if (this.#stopping) await this.#stopping;
    context.controller.signal.throwIfAborted();
    if (this.#threadId) return;
    const proc = this.#proc = spawn(this.codexBin, ['app-server', '--disable', 'apps', '--enable', 'computer_use', '--enable', 'plugins', '--enable', 'tool_call_mcp_elicitation'], { cwd: this.cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.#stderr = '';
    let spawnError;
    this.#exited = new Promise(resolve => {
      proc.on('error', error => { if (!proc.pid) spawnError = error; });
      proc.once('close', (code, signal) => {
        const error = spawnError || failure('transport-closed', `Auxiliary app-server transport closed (code=${code}, signal=${signal}).`);
        for (const pending of this.#pending.values()) pending.reject(error);
        this.#pending.clear();
        if (this.#proc === proc) { this.#proc = null; this.#threadId = null; }
        resolve();
      });
    });
    proc.stdin.on('error', () => { void this.#stopProcess(); });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', chunk => { this.#stderr = (this.#stderr + chunk).slice(-4000); });
    createInterface({ input: proc.stdout }).on('line', line => this.#onLine(line, proc));
    await this.#request('initialize', { clientInfo: { name: 'macuse-auxiliary', version }, capabilities: { experimentalApi: true, requestAttestation: false } }, context);
    this.#write({ jsonrpc: '2.0', method: 'initialized', params: {} });
    const configRead = await this.#request('config/read', { cwd: this.cwd, includeLayers: false }, context);
    if (!isObject(configRead?.config)) throw new Error('config/read response did not include config.');
    const disabled = value => Object.fromEntries(Object.keys(isObject(value) ? value : {}).map(name => [name, { enabled: false }]));
    const configured = Object.fromEntries(Object.entries(servers).map(([name, server]) => {
      const root = join(resources, 'plugins/openai-bundled/plugins', server.plugin);
      return [name, { command: join(root, 'bin/computer-use-client-launcher'), args: [name, 'mcp'], cwd: root, env_vars: ['CODEX_HOME'], enabled: true }];
    }));
    const start = await this.#request('thread/start', {
      cwd: this.cwd, ephemeral: true, approvalPolicy: 'on-request', sandbox: 'workspace-write',
      config: { features: { apps: false, computer_use: true, plugins: true, tool_call_mcp_elicitation: true }, mcp_servers: { ...disabled(configRead.config.mcp_servers), ...configured }, plugins: disabled(configRead.config.plugins) },
    }, context);
    if (typeof start?.thread?.id !== 'string' || !start.thread.id) throw new Error('thread/start response did not include thread.id.');
    context.missingTools = Object.entries(servers).flatMap(([name, server]) => server.tools.map(tool => `${name}/${tool}`));
    for (;;) {
      const inventory = new Map();
      let cursor;
      do {
        const status = await this.#request('mcpServerStatus/list', { threadId: start.thread.id, detail: 'toolsAndAuthOnly', limit: 100, ...(cursor ? { cursor } : {}) }, context);
        for (const server of status?.data ?? []) inventory.set(server.name, Object.keys(server.tools ?? {}));
        context.missingTools = Object.entries(servers).flatMap(([name, server]) => server.tools.filter(tool => !inventory.get(name)?.includes(tool)).map(tool => `${name}/${tool}`));
        cursor = status?.nextCursor;
      } while (cursor);
      if (context.missingTools.length === 0) break;
      await delay(100, undefined, { signal: context.controller.signal });
    }
    context.controller.signal.throwIfAborted();
    this.#threadId = start.thread.id;
  }

  #write(message) {
    if (!this.#proc?.stdin.writable) throw failure('transport-closed', 'Auxiliary app-server transport closed before write.');
    this.#proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #request(method, params, context) {
    context.controller.signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const id = this.#nextId++;
      this.#pending.set(id, { resolve, reject, method });
      try {
        this.#write({ jsonrpc: '2.0', id, method, params });
        if (method === 'mcpServer/tool/call') context.dispatched = true;
      } catch (error) {
        this.#pending.delete(id);
        reject(error);
      }
    });
  }

  #onLine(line, proc) {
    if (proc !== this.#proc) return;
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (!isObject(message)) return;
    const pending = this.#pending.get(message.id);
    if (pending && (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error'))) {
      this.#pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || 'Auxiliary app-server JSON-RPC error.'));
      else pending.resolve(message.result);
    } else if (Object.hasOwn(message, 'id') && typeof message.method === 'string' && proc.stdin.writable) {
      if (message.method === 'mcpServer/elicitation/request') {
        const approved = this.#active && !this.#active.controller.signal.aborted && [...this.#pending.values()].some(request => request.method === 'mcpServer/tool/call');
        this.#write({ jsonrpc: '2.0', id: message.id, result: { action: approved ? 'accept' : 'decline', content: approved ? {} : null, _meta: null } });
      } else this.#write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Unsupported app-server request: ${message.method}` } });
    }
  }

  async stop() {
    this.#active?.controller.abort(failure('stopped', 'Auxiliary runtime was stopped.'));
    await this.#stopProcess();
  }

  async #stopProcess() {
    if (this.#stopping) return this.#stopping;
    const proc = this.#proc;
    if (!proc) return;
    this.#threadId = null;
    const exited = this.#exited;
    const stopping = (async () => {
      // EOF lets app-server close its own clients. Escalate only this subprocess.
      const term = setTimeout(() => { if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGTERM'); }, 1000);
      const force = setTimeout(() => { if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL'); }, 3000);
      proc.stdin.end();
      try { await exited; }
      finally { clearTimeout(term); clearTimeout(force); }
    })();
    this.#stopping = stopping;
    try { await stopping; }
    finally { if (this.#stopping === stopping) this.#stopping = null; }
  }
}
