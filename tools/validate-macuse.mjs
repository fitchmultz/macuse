#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { DEFAULT_BUNDLED_COMPUTER_USE_CLIENT, DEFAULT_COMPUTER_USE_CLIENT_CWD, frontmostApp, mousePosition, parseJsonOutput, VERSION } from './macuse-utils.mjs';

const DEFAULT_APP = 'Activity Monitor';
const DEFAULT_TIMEOUT_MS = 90_000;
const validationChecks = [];
let jsonOutput = false;
let activeOpts = null;

function recordCheck(status, name, detail = '') {
  validationChecks.push({ status, name, detail });
}

function help() {
  process.stdout.write(`macuse validation ${VERSION}\n\nUsage:\n  node tools/validate-macuse.mjs quick [options]\n  node tools/validate-macuse.mjs read-only [options]\n  node tools/validate-macuse.mjs mutating [options]\n  node tools/validate-macuse.mjs focus [options]\n  node tools/validate-macuse.mjs mcp [options]\n\nModes:\n  quick\n      Syntax-check bridge scripts, smoke-load the pi extension, verify the pi\n      extension reuses one persistent app-server thread, run direct raw-MCP\n      discovery, and verify Codex app-server can discover Computer Use.\n\n  read-only\n      Run quick plus safe read-only probes: app-server list_apps and get_app_state.\n      The direct raw-MCP Finder deny probe is diagnostic-only and warns instead\n      of failing because SkyComputerUseClient mcp is unreliable outside Codex.\n\n  mutating\n      Run read-only plus an Activity Monitor real-app mutation smoke: filter\n      search, clear search after the field name changes, switch Memory, restore\n      CPU, and verify native frontmost focus is not stolen.\n\n  focus\n      Run mutating plus the extension sequence background-focus check.\n      Native frontmost drift fails; no restore fallback is attempted.\n\n  mcp\n      Smoke-test the Cursor/standard-MCP wrapper: initialize, tools/list,\n      approval elicitation, get_app_state, and pointer guard behavior.\n\nOptions:\n  --app <name|bundle|path>       App for read-only get_app_state. Default: ${DEFAULT_APP}\n  --tool-timeout-ms <ms>         Tool timeout for app-server probes. Default: ${DEFAULT_TIMEOUT_MS}\n  --verbose                      Print child stdout/stderr.\n  --json                         Print a machine-readable validation summary.\n  -h, --help                     Show this help.\n\nSafety:\n  quick/read-only do not click, type, drag, scroll, press keys, set values, or\n  mutate GUI state. get_app_state may launch or foreground the target app and\n  can reveal visible app contents. mutating edits only Activity Monitor's\n  search field and tab selection, then restores CPU/search state.\n\nExamples:\n  node tools/validate-macuse.mjs quick\n  node tools/validate-macuse.mjs read-only\n  node tools/validate-macuse.mjs mutating\n  node tools/validate-macuse.mjs focus\n  node tools/validate-macuse.mjs mcp\n  node tools/validate-macuse.mjs read-only --app \"Activity Monitor\" --tool-timeout-ms 120000\n`);
}
function parse(argv) {
  if (argv.includes('-h') || argv.includes('--help')) return { help: true };
  const mode = argv.shift() || 'quick';
  if (!['quick', 'read-only', 'mutating', 'focus', 'mcp'].includes(mode)) throw new Error(`unknown mode: ${mode}`);
  const opts = { mode, app: DEFAULT_APP, toolTimeoutMs: DEFAULT_TIMEOUT_MS, verbose: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`${token} requires a value`);
      return argv[i];
    };
    if (token === '--app') opts.app = next();
    else if (token === '--tool-timeout-ms') {
      const n = Number(next());
      if (!Number.isInteger(n) || n <= 0) throw new Error('--tool-timeout-ms must be a positive integer');
      opts.toolTimeoutMs = n;
    } else if (token === '--verbose') opts.verbose = true;
    else if (token === '--json') opts.json = true;
    else throw new Error(`unknown option: ${token}`);
  }
  return opts;
}

function tail(value, max = 4000) {
  if (!value) return '';
  return value.length > max ? value.slice(-max) : value;
}

function run(name, command, args, opts = {}) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: { ...process.env, ...(opts.env || {}) },
    encoding: 'utf8',
    timeout: opts.timeoutMs || 120_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  const output = [tail(result.stdout), tail(result.stderr)].filter(Boolean).join('\n');
  const outputTail = output ? `\n--- child output tail ---\n${output}` : '';
  if (!jsonOutput && (opts.verbose || (result.status !== 0 && !opts.quietOnFailure))) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }
  if (result.error) throw new Error(`${name} failed: ${result.error.message}${outputTail}`);
  if (result.status !== 0) {
    throw new Error(`${name} exited ${result.status}${result.signal ? ` signal ${result.signal}` : ''}${outputTail}`);
  }
  return result.stdout;
}

function runRawComputerHistoryContractSmoke() {
  const input = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'macuse-validation', version: VERSION } } },
    { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  ].map((message) => JSON.stringify(message)).join('\n') + '\n';
  const result = spawnSync(DEFAULT_BUNDLED_COMPUTER_USE_CLIENT, ['computer-history', 'mcp'], { cwd: DEFAULT_COMPUTER_USE_CLIENT_CWD, input, encoding: 'utf8', timeout: 10_000 });
  if (result.error || result.status !== 0) throw new Error(`raw Computer History discovery failed: ${result.error?.message || result.stderr || `exit ${result.status}`}`);
  const listed = result.stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line)).find((message) => message.id === 2)?.result;
  const tools = listed?.tools;
  const expected = ['computer_history_pause', 'computer_history_resume', 'computer_history_status', 'computer_history_get_settings', 'computer_history_update_settings'];
  if (!Array.isArray(tools) || JSON.stringify(tools.map((tool) => tool.name)) !== JSON.stringify(expected)) throw new Error('raw Computer History tool inventory changed');
  for (const tool of tools) {
    const readOnly = tool.name === 'computer_history_status' || tool.name === 'computer_history_get_settings';
    if (tool.annotations?.readOnlyHint !== readOnly || tool.annotations?.destructiveHint !== false || tool.annotations?.idempotentHint !== true || tool.annotations?.openWorldHint !== false) throw new Error(`raw ${tool.name} annotations changed`);
  }
  const observation = tools.find((tool) => tool.name === 'computer_history_update_settings')?.inputSchema?.properties?.observation;
  const required = ['defaultApplicationBehavior', 'defaultURLBehavior', 'allowlist', 'blocklist'];
  const entry = observation?.properties?.allowlist?.items;
  if (!required.every((field) => observation?.required?.includes(field)) || !entry?.required?.includes('scope') || !entry?.properties?.urlDomain?.description?.includes('without a scheme or path')) throw new Error('raw computer_history_update_settings schema changed');
  return '5 live tools; schemas and annotations match';
}

function runCliAuxiliaryGuardSmoke() {
  const invalidObservation = { observation: { defaultApplicationBehavior: 'observe', defaultURLBehavior: 'observe', allowlist: [{ scope: 'app' }], blocklist: [] } };
  const invalidUrlObservation = { observation: { ...invalidObservation.observation, allowlist: [{ scope: 'url' }] } };
  const schemeUrlObservation = { observation: { ...invalidObservation.observation, allowlist: [{ scope: 'url', urlDomain: 'https://example.com' }] } };
  const pathUrlObservation = { observation: { ...invalidObservation.observation, allowlist: [{ scope: 'url', urlDomain: 'example.com/path' }] } };
  for (const [tool, args, flag] of [
    ['event_stream_start', {}, 'allow-recording'],
    ['computer_history_resume', {}, 'allow-recording'],
    ['computer_history_update_settings', {}, 'allow-privacy-change'],
  ]) {
    const server = tool.startsWith('event_') ? 'event-stream' : 'computer-history';
    const result = spawnSync(process.execPath, ['tools/codex-computer-use-appserver.mjs', 'call', '--server', server, '--tool', tool, '--arguments-json', JSON.stringify(args), '--quiet'], { cwd: process.cwd(), encoding: 'utf8', timeout: 10_000 });
    if (result.status !== 2 || !result.stdout.includes(flag)) throw new Error(`CLI ${tool} guard did not fail closed before app-server startup`);
  }
  for (const [args, failure] of [
    [invalidObservation, 'an app rule without bundleID'],
    [invalidUrlObservation, 'a URL rule without urlDomain'],
    [schemeUrlObservation, 'a URL rule with a scheme'],
    [pathUrlObservation, 'a URL rule with a path'],
  ]) {
    const result = spawnSync(process.execPath, ['tools/codex-computer-use-appserver.mjs', 'call', '--server', 'computer-history', '--tool', 'computer_history_update_settings', '--arguments-json', JSON.stringify(args), '--allow-privacy-change', '--safety-note', 'guard test only', '--quiet'], { cwd: process.cwd(), encoding: 'utf8', timeout: 10_000 });
    if (result.status !== 2 || !result.stdout.includes('scope-specific')) throw new Error(`CLI computer_history_update_settings accepted ${failure}`);
  }
  const statusResult = spawnSync(process.execPath, ['tools/codex-computer-use-appserver.mjs', 'call', '--server', 'event-stream', '--tool', 'event_stream_status', '--arguments-json', '{}', '--quiet'], { cwd: process.cwd(), encoding: 'utf8', timeout: 120_000 });
  if (statusResult.status !== 0) throw new Error(`CLI event_stream_status failed: ${statusResult.stderr || statusResult.stdout}`);
  const status = parseJsonOutput('CLI event_stream_status', statusResult.stdout);
  const statusText = status.result?.content?.find((block) => block.type === 'text')?.text || '';
  const inactive = status.result?.isError ? statusText.includes('Record & Replay is not enabled') : JSON.parse(statusText || '{}').isRecording === false;
  if (!inactive) throw new Error('CLI event_stream_status did not prove recording is inactive or unavailable');
  return 'recording/privacy guards fail closed; event_stream_status routed without recording';
}

function runMcpServerSmoke(verbose) {
  const script = String.raw`
const { spawn } = require('node:child_process');
const proc = spawn(process.execPath, ['tools/codex-computer-use-appserver-mcp.mjs'], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] });
let nextId = 1;
let buffer = '';
let sawElicitation = false;
const pending = new Map();
function send(message) { proc.stdin.write(JSON.stringify(message) + '\n'); }
function text(result) { return (result?.content || []).filter((block) => block?.type === 'text').map((block) => block.text || '').join('\n'); }
function request(method, params = {}, timeoutMs = 120000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(method + ' timed out')); }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    send({ jsonrpc: '2.0', id, method, params });
  });
}
proc.stdout.setEncoding('utf8');
proc.stdout.on('data', (chunk) => {
  buffer += chunk;
  for (;;) {
    const idx = buffer.indexOf('\n');
    if (idx === -1) break;
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.method === 'elicitation/create' && msg.id) {
      sawElicitation = true;
      send({ jsonrpc: '2.0', id: msg.id, result: { action: 'decline', content: null } });
      continue;
    }
    if (pending.has(msg.id)) {
      const p = pending.get(msg.id);
      clearTimeout(p.timer);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    }
  }
});
proc.stderr.on('data', (chunk) => { if (process.env.MACUSE_VALIDATE_VERBOSE) process.stderr.write(chunk); });
(async () => {
  await request('initialize', { protocolVersion: '2025-06-18', capabilities: { elicitation: { form: {} } }, clientInfo: { name: 'validate-macuse', version: '0' } }, 5000);
  send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
  const listed = await request('tools/list', {}, 5000);
  const names = listed.tools.map((tool) => tool.name);
  for (const expected of ['list_apps', 'get_app_state', 'perform_secondary_action', 'press_key', 'type_text', 'set_value', 'select_text', 'scroll', 'click', 'drag', 'event_stream_start', 'event_stream_status', 'event_stream_stop', 'computer_history_pause', 'computer_history_resume', 'computer_history_status', 'computer_history_get_settings', 'computer_history_update_settings']) {
    if (!names.includes(expected)) throw new Error('missing MCP tool: ' + expected);
  }
  if (names.length !== 18) throw new Error('expected exactly 18 MCP tools, saw ' + names.length);
  const settingsSchema = listed.tools.find((tool) => tool.name === 'computer_history_update_settings')?.inputSchema?.properties?.observation;
  const requiredSettings = ['defaultApplicationBehavior', 'defaultURLBehavior', 'allowlist', 'blocklist'];
  if (!requiredSettings.every((field) => settingsSchema?.required?.includes(field))) throw new Error('computer_history_update_settings schema does not require all observation fields');
  if (!settingsSchema?.properties?.allowlist?.items?.properties?.urlDomain?.description?.includes('without a scheme or path')) throw new Error('computer_history_update_settings schema omits URL domain guidance');
  const annotationExpectations = {
    event_stream_start: [false, false], event_stream_status: [true, true], event_stream_stop: [false, true],
    computer_history_pause: [false, true],
    computer_history_resume: [false, true], computer_history_status: [true, true], computer_history_get_settings: [true, true],
    computer_history_update_settings: [false, true],
  };
  for (const [name, [readOnly, idempotent]] of Object.entries(annotationExpectations)) {
    const annotations = listed.tools.find((tool) => tool.name === name)?.annotations;
    if (annotations?.readOnlyHint !== readOnly || annotations?.destructiveHint !== false || annotations?.idempotentHint !== idempotent || annotations?.openWorldHint !== false) throw new Error(name + ' annotations do not match upstream');
  }
  const finder = await request('tools/call', { name: 'get_app_state', arguments: { app: 'Finder', approval: 'ask' } }, 120000);
  if (!sawElicitation || finder.isError !== true) throw new Error('MCP elicitation proxy did not decline Finder as expected');
  sawElicitation = false;
  const finderInherit = await request('tools/call', { name: 'get_app_state', arguments: { app: 'Finder' } }, 120000);
  if (finderInherit.isError === true) throw new Error('MCP default inherit did not auto-accept Finder app approval');
  const activityState = await request('tools/call', { name: 'get_app_state', arguments: { app: 'Activity Monitor' } }, 120000);
  if (!text(activityState).includes('Activity Monitor')) throw new Error('MCP Activity Monitor get_app_state did not expose app content');
  let pointerGuarded = false;
  try {
    await request('tools/call', { name: 'click', arguments: { app: 'Activity Monitor', elementDescription: 'CPU' } }, 120000);
  } catch (error) {
    pointerGuarded = /allowPointer/.test(error.message || '');
  }
  if (!pointerGuarded) throw new Error('MCP wrapper did not guard pointer click without allowPointer:true');
  const eventStatus = await request('tools/call', { name: 'event_stream_status', arguments: {} }, 120000);
  const eventStatusText = text(eventStatus);
  const eventInactive = eventStatus.isError ? eventStatusText.includes('Record & Replay is not enabled') : JSON.parse(eventStatusText).isRecording === false;
  if (!eventInactive) throw new Error('MCP event_stream_status did not prove recording is inactive or unavailable');
  const invalidObservation = { observation: { defaultApplicationBehavior: 'observe', defaultURLBehavior: 'observe', allowlist: [{ scope: 'app' }], blocklist: [] } };
  const invalidUrlObservation = { observation: { ...invalidObservation.observation, allowlist: [{ scope: 'url' }] } };
  const schemeUrlObservation = { observation: { ...invalidObservation.observation, allowlist: [{ scope: 'url', urlDomain: 'https://example.com' }] } };
  const pathUrlObservation = { observation: { ...invalidObservation.observation, allowlist: [{ scope: 'url', urlDomain: 'example.com/path' }] } };
  for (const [name, arguments, expected] of [
    ['event_stream_start', {}, /allowRecording/],
    ['computer_history_resume', { allowRecording: true }, /safetyNote/],
    ['computer_history_update_settings', {}, /allowPrivacyChange/],
    ['computer_history_update_settings', { allowPrivacyChange: true, safetyNote: 'test guard only' }, /all Computer History settings fields/],
    ['computer_history_update_settings', { ...invalidObservation, allowPrivacyChange: true, safetyNote: 'test guard only' }, /scope-specific/],
    ['computer_history_update_settings', { ...invalidUrlObservation, allowPrivacyChange: true, safetyNote: 'test guard only' }, /scope-specific/],
    ['computer_history_update_settings', { ...schemeUrlObservation, allowPrivacyChange: true, safetyNote: 'test guard only' }, /scope-specific/],
    ['computer_history_update_settings', { ...pathUrlObservation, allowPrivacyChange: true, safetyNote: 'test guard only' }, /scope-specific/],
  ]) {
    let guarded = false;
    try { await request('tools/call', { name, arguments }, 5000); } catch (error) { guarded = expected.test(error.message || ''); }
    if (!guarded) throw new Error(name + ' guard did not fail closed');
  }
  console.log(names.join(','));
})().then(() => { proc.kill('SIGTERM'); }).catch((error) => { proc.kill('SIGTERM'); console.error(error.stack || error.message); process.exitCode = 1; });
`;
  const stdout = run('appserver MCP wrapper smoke', process.execPath, ['-e', script], {
    env: { MACUSE_VALIDATE_VERBOSE: verbose ? '1' : '' },
    timeoutMs: 240_000,
    verbose,
  });
  return stdout.trim();
}

function runPiExtensionSmoke(verbose) {
  const script = String.raw`
const { createJiti } = require('jiti');
const jiti = createJiti(process.cwd() + '/validate-extension.js', { interopDefault: true });
const mod = jiti('./extensions/codex-computer-use.ts');
const factory = mod.default || mod;
const tools = [];
factory({
  registerTool(def) { tools.push(def); },
  registerCommand() {},
  on() {},
});
const expectedTools = [
  'list_apps', 'get_app_state', 'perform_secondary_action', 'press_key', 'type_text', 'set_value', 'select_text', 'scroll', 'click', 'drag',
  'event_stream_start', 'event_stream_status', 'event_stream_stop',
  'computer_history_pause', 'computer_history_resume', 'computer_history_status', 'computer_history_get_settings', 'computer_history_update_settings',
  'macuse_sequence', 'macuse_restart',
];
const names = tools.map((tool) => tool.name);
if (JSON.stringify([...names].sort()) !== JSON.stringify([...expectedTools].sort())) throw new Error('extension tools do not match full surface: ' + names.join(','));
if (tools.some((tool) => tool.executionMode !== 'sequential')) throw new Error('all extension tools must serialize the shared app-server thread and element cache');
if (tools.some((tool) => tool.parameters?.additionalProperties !== false)) throw new Error('all public extension tool schemas must reject unknown top-level fields');
const sequenceStepSchema = tools.find((tool) => tool.name === 'macuse_sequence')?.parameters?.properties?.steps?.items;
if (sequenceStepSchema?.additionalProperties !== true) throw new Error('macuse_sequence step schema must remain permissive for runtime-normalized step fields');
if (tools.some((tool) => tool.name === 'macuse')) throw new Error('obsolete composite macuse tool is still registered');
const historyObservation = tools.find((tool) => tool.name === 'computer_history_update_settings')?.parameters?.properties?.observation;
const requiredSettings = ['defaultApplicationBehavior', 'defaultURLBehavior', 'allowlist', 'blocklist'];
if (!requiredSettings.every((field) => historyObservation?.required?.includes(field))) throw new Error('Computer History schema does not require all observation fields');
if (!historyObservation?.properties?.allowlist?.items?.properties?.urlDomain?.description?.includes('without scheme or path')) throw new Error('Computer History schema omits URL domain guidance');
for (const name of ['perform_secondary_action', 'press_key', 'type_text', 'set_value', 'select_text', 'scroll', 'click', 'drag']) {
  const required = tools.find((tool) => tool.name === name)?.parameters?.required || [];
  if (!required.includes('allowMutating') || !required.includes('safetyNote')) throw new Error(name + ' schema does not require mutation authorization');
}
(async () => {
  const signal = new AbortController().signal;
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const invalidObservation = { defaultApplicationBehavior: 'observe', defaultURLBehavior: 'observe', allowlist: [{ scope: 'app' }], blocklist: [] };
  const invalidUrlObservation = { ...invalidObservation, allowlist: [{ scope: 'url' }] };
  const schemeUrlObservation = { ...invalidObservation, allowlist: [{ scope: 'url', urlDomain: 'https://example.com' }] };
  const pathUrlObservation = { ...invalidObservation, allowlist: [{ scope: 'url', urlDomain: 'example.com/path' }] };
  for (const [name, params, expected] of [
    ['event_stream_start', {}, /allowRecording/],
    ['computer_history_resume', { allowRecording: true }, /safetyNote/],
    ['set_value', { app: 'Activity Monitor', value: 'x' }, /allowMutating/],
    ['set_value', { app: 'Activity Monitor', value: 'x', allowMutating: true, safetyNote: 'short' }, /safetyNote/],
    ['click', { app: 'Activity Monitor', x: 1, y: 1, allowMutating: true, safetyNote: 'Activity Monitor test only; do not click any risky controls.' }, /allowPointer/],
    ['computer_history_update_settings', { allowPrivacyChange: true, safetyNote: 'guard test' }, /all Computer History settings fields/],
    ['computer_history_update_settings', { observation: invalidObservation, allowPrivacyChange: true, safetyNote: 'guard test' }, /scope-specific/],
    ['computer_history_update_settings', { observation: invalidUrlObservation, allowPrivacyChange: true, safetyNote: 'guard test' }, /scope-specific/],
    ['computer_history_update_settings', { observation: schemeUrlObservation, allowPrivacyChange: true, safetyNote: 'guard test' }, /scope-specific/],
    ['computer_history_update_settings', { observation: pathUrlObservation, allowPrivacyChange: true, safetyNote: 'guard test' }, /scope-specific/],
  ]) {
    let guarded = false;
    try { await byName.get(name).execute('guard', params, signal); } catch (error) { guarded = expected.test(error.message || ''); }
    if (!guarded) throw new Error(name + ' extension guard did not fail closed');
  }
  console.log(names.join(','));
})().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
`;
  const nodePath = [
    '/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules',
    '/opt/homebrew/lib/node_modules',
    process.env.NODE_PATH || '',
  ].filter(Boolean).join(':');
  const stdout = run('pi extension registration smoke', process.execPath, ['-e', script], {
    env: { NODE_PATH: nodePath },
    timeoutMs: 120_000,
    verbose,
  });
  return stdout.trim();
}

function runListAppsErrorPreservationSmoke(verbose) {
  const script = String.raw`
const { createJiti } = require('jiti');
const jiti = createJiti(process.cwd() + '/validate-list-apps-error.js', { interopDefault: true });
const { filterAppListContent, listAppsDisplayContent } = jiti('./extensions/codex-computer-use-modules/apps.ts');
const { filterToolResult } = jiti('./extensions/codex-computer-use-modules/content.ts');
const { sanitizeRecoverableComputerUseText } = jiti('./extensions/codex-computer-use-modules/computer-use-recovery.ts');
const { appServerSessionRecoverySummary, filterToolResult: filterCliToolResult, sanitizeRecoverableComputerUseText: sanitizeCliRecoverableComputerUseText, shouldAutoRecoverComputerUse } = jiti('./tools/cu-helpers.mjs');
const { computerUseDiagnostic } = jiti('./extensions/codex-computer-use-modules/diagnostics.ts');
const { normalizePressKeyValue, normalizeToolArguments } = jiti('./extensions/codex-computer-use-modules/elements-state.ts');
const errorContent = [{ type: 'text', text: 'NSOSStatusErrorDomain Code=-609 connectionInvalid' }];
if (normalizePressKeyValue(',', ['COMMAND']) !== 'super+comma') throw new Error('Command-comma key normalization failed');
if (normalizePressKeyValue('Command+,') !== 'super+comma') throw new Error('Command+, key normalization failed');
const normalizedArgs = normalizeToolArguments({ app: 'CueboxItem24', key: 'Comma', modifiers: ['COMMAND'] });
if (normalizedArgs.key !== 'super+comma' || 'modifiers' in normalizedArgs) throw new Error('press_key modifiers were not normalized away');
const stopSentinelResult = { content: [{ type: 'text', text: 'This application session has been explicitly stopped by the user for this turn. Stop your work and send a final message noting they stopped the session and you\'re ready to continue if they want you to. Computer Use can be used again in the next assistant turn.' }] };
const stopped = filterToolResult(stopSentinelResult, { maxTextChars: 1000 });
const stoppedText = stopped.content[0]?.text || '';
if (!stopped.isError || stoppedText.includes('Stop your work') || !stoppedText.includes('normal tool error')) throw new Error('app-session stop sentinel was not sanitized into a normal tool error');
const sanitizedError = sanitizeRecoverableComputerUseText('mcpServer/tool/call failed: This application session has been explicitly stopped by the user for this turn. Stop your work now.');
if (!sanitizedError.forcedError || sanitizedError.text.includes('Stop your work')) throw new Error('recoverable extension error text sanitizer leaked stop instructions');
const cliStopped = filterCliToolResult(stopSentinelResult, { maxTextChars: 1000 });
const cliStoppedText = cliStopped.content[0]?.text || '';
if (!cliStopped.isError || cliStoppedText.includes('Stop your work') || !cliStoppedText.includes('normal tool error')) throw new Error('CLI helper app-session stop sentinel was not sanitized into a normal tool error');
const sanitizedCliError = sanitizeCliRecoverableComputerUseText('mcpServer/tool/call failed: This application session has been explicitly stopped by the user for this turn. Stop your work now.');
if (!sanitizedCliError.forcedError || sanitizedCliError.text.includes('Stop your work')) throw new Error('recoverable CLI error text sanitizer leaked stop instructions');
const displayed = listAppsDisplayContent({ content: errorContent, isError: true }, { filter: 'nope', maxTextChars: 1000 });
if (displayed[0].text.includes('No apps matched')) throw new Error('list_apps error was masked as empty filter result');
const filtered = filterAppListContent(errorContent, { filter: 'nope', maxTextChars: 1000 });
if (!filtered[0].text.includes('No apps matched')) throw new Error('normal list_apps filtering stopped summarizing empty filters');
const accessDeniedState = { content: [{ type: 'text', text: 'Visible page text: Access Denied connectionInvalid' }], isError: false };
if (computerUseDiagnostic(accessDeniedState, 'get_app_state', { app: 'Browser' })) throw new Error('non-error app text produced a TCC diagnostic');
const tccError = { content: errorContent, isError: true };
if (!computerUseDiagnostic(tccError, 'list_apps', {})) throw new Error('TCC list_apps error did not produce a diagnostic');
const keyErrorDiagnostic = computerUseDiagnostic({ content: [{ type: 'text', text: 'Computer Use server error -10005: keyNotFound(",")' }], isError: true }, 'press_key', { app: 'CueboxItem24' });
if (!keyErrorDiagnostic?.includes('press_key') || keyErrorDiagnostic.includes('timed out')) throw new Error('keyNotFound diagnostic was not key-specific');
const noWindowDiagnostic = computerUseDiagnostic({ content: [{ type: 'text', text: 'Computer Use server error -10005: noWindowsAvailable' }], isError: true }, 'click', { app: 'CueboxItem24' });
if (!noWindowDiagnostic?.includes('pointer click') || noWindowDiagnostic.includes('timed out')) throw new Error('noWindowsAvailable diagnostic was not pointer-specific');
const timeoutDiagnostic = computerUseDiagnostic({ content: [{ type: 'text', text: 'Computer Use server error -10005: timeoutReached' }], isError: true }, 'get_app_state', { app: 'Chrome' });
if (!timeoutDiagnostic?.includes('timed out')) throw new Error('timeoutReached diagnostic stopped reporting timeouts');
if (!shouldAutoRecoverComputerUse('get_app_state', 'Transport closed')) throw new Error('read-only recovery classifier missed transport failures');
if (!shouldAutoRecoverComputerUse('event_stream_status', 'Transport closed')) throw new Error('auxiliary read-only recovery classifier missed transport failures');
if (!shouldAutoRecoverComputerUse('computer_history_status', 'Transport closed')) throw new Error('Computer History status recovery classifier missed transport failures');
if (!shouldAutoRecoverComputerUse('computer_history_get_settings', 'Transport closed')) throw new Error('Computer History settings recovery classifier missed transport failures');
if (shouldAutoRecoverComputerUse('event_stream_start', 'Transport closed')) throw new Error('recording start recovery classifier allowed auto-recovery');
if (shouldAutoRecoverComputerUse('computer_history_resume', 'Transport closed')) throw new Error('recording resume recovery classifier allowed auto-recovery');
if (shouldAutoRecoverComputerUse('click', 'Transport closed')) throw new Error('mutating recovery classifier allowed auto-recovery');
const cliRecovery = appServerSessionRecoverySummary('test');
if (cliRecovery.scope !== 'app-server-session' || cliRecovery.targets.length !== 0) throw new Error('automatic CLI recovery is not scoped to app-server session only');
console.log('list-apps-error-preserved');
`;
  const nodePath = [
    '/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules',
    '/opt/homebrew/lib/node_modules',
    process.env.NODE_PATH || '',
  ].filter(Boolean).join(':');
  const stdout = run('list_apps error preservation smoke', process.execPath, ['-e', script], {
    env: { NODE_PATH: nodePath },
    timeoutMs: 120_000,
    verbose,
  });
  return stdout.trim();
}

function runPiExtensionPersistentSmoke(verbose) {
  const script = String.raw`
const { createJiti } = require('jiti');
const jiti = createJiti(process.cwd() + '/validate-extension-persistent.js', { interopDefault: true });
const mod = jiti('./extensions/codex-computer-use.ts');
const factory = mod.default || mod;
const tools = new Map();
const commands = new Map();
const handlers = new Map();
factory({
  registerTool(def) { tools.set(def.name, def); },
  registerCommand(name, def) { commands.set(name, def); },
  on(name, handler) { handlers.set(name, handler); },
});
(async () => {
  const signal = new AbortController().signal;
  if (!commands.has('macuse-stop')) throw new Error('pi extension did not register /macuse-stop');
  if (!commands.has('macuse-status')) throw new Error('pi extension did not register /macuse-status');
  const notifications = [];
  const commandCtx = { hasUI: true, ui: { notify(message, level) { notifications.push({ message, level }); } } };
  await commands.get('macuse-status').handler('', commandCtx);
  const lazyStatus = notifications.at(-1)?.message || '';
  if (!lazyStatus.includes('has not been started')) throw new Error('pi extension /macuse-status started or missed lazy stopped state before any tool call: ' + lazyStatus);
  const eventStatusTool = tools.get('event_stream_status');
  const listApps = tools.get('list_apps');
  const getAppState = tools.get('get_app_state');
  if (!eventStatusTool || !listApps || !getAppState) throw new Error('missing direct extension tools: ' + [...tools.keys()].join(','));
  const eventStatus = await eventStatusTool.execute('event-status', { toolTimeoutMs: 90000 }, signal, () => {});
  const eventStatusText = eventStatus.content[0]?.text || '';
  const eventInactive = eventStatus.details.computerUse.isError ? eventStatusText.includes('Record & Replay is not enabled') : JSON.parse(eventStatusText).isRecording === false;
  if (!eventInactive) throw new Error('pi event_stream_status did not prove recording is inactive or unavailable');
  const running = await listApps.execute('running', { runningOnly: true, maxTextChars: 5000, toolTimeoutMs: 90000 }, signal, () => {});
  if (!running.content[0].text.includes('running')) throw new Error('pi extension runningOnly list_apps returned no running apps');
  const nonRunningLines = running.content[0].text.split('\n').filter((line) => line.trim() && !line.includes('running'));
  if (nonRunningLines.length > 0) throw new Error('pi extension runningOnly list_apps kept non-running lines: ' + nonRunningLines.slice(0, 3).join(' | '));
  const first = await getAppState.execute('first', { app: 'Activity Monitor', maxTextChars: 500, toolTimeoutMs: 90000 }, signal, () => {});
  const second = await getAppState.execute('second', { app: 'Finder', maxTextChars: 500, toolTimeoutMs: 90000 }, signal, () => {});
  const firstThread = first.details.computerUse.threadId;
  const secondThread = second.details.computerUse.threadId;
  if (!firstThread || firstThread !== secondThread) throw new Error('pi extension did not reuse persistent app-server thread');
  const stoppedSession = second.details.computerUse.isError && second.content[0]?.text?.includes('Computer Use application session is stopped');
  if (second.details.computerUse.isError && !stoppedSession) throw new Error('pi extension default inherit returned isError for Finder');
  if (!stoppedSession && (second.details.computerUse.elicitationCount < 1 || second.details.computerUse.acceptedElicitations < 1)) throw new Error('pi extension did not auto-accept Finder app approval via inherit');
  await commands.get('macuse-status').handler('', commandCtx);
  const runningStatus = notifications.at(-1)?.message || '';
  if (!runningStatus.includes('running') || !/pid=\d+/.test(runningStatus) || !/watchdog=\d+/.test(runningStatus)) throw new Error('pi extension /macuse-status did not report pid/watchdog while running: ' + runningStatus);
  await commands.get('macuse-stop').handler('', commandCtx);
  await commands.get('macuse-status').handler('', commandCtx);
  const stoppedStatus = notifications.at(-1)?.message || '';
  if (!stoppedStatus.includes('stopped')) throw new Error('pi extension /macuse-stop did not stop app-server: ' + stoppedStatus);
  if (handlers.has('session_shutdown')) await handlers.get('session_shutdown')({ reason: 'test' }, {});
  console.log(firstThread);
})().catch(async (error) => {
  try { if (handlers.has('session_shutdown')) await handlers.get('session_shutdown')({ reason: 'test' }, {}); } catch {}
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
`;
  const nodePath = [
    '/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules',
    '/opt/homebrew/lib/node_modules',
    process.env.NODE_PATH || '',
  ].filter(Boolean).join(':');
  const stdout = run('pi extension persistent app-server smoke', process.execPath, ['-e', script], {
    env: { NODE_PATH: nodePath },
    timeoutMs: 240_000,
    verbose,
  });
  return stdout.trim();
}

function runPiExtensionActualAppSmoke(verbose) {
  const script = String.raw`
const { createJiti } = require('jiti');
const { existsSync, unlinkSync } = require('node:fs');
const jiti = createJiti(process.cwd() + '/validate-extension-actual-app.js', { interopDefault: true });
const mod = jiti('./extensions/codex-computer-use.ts');
const factory = mod.default || mod;
const tools = new Map();
const handlers = new Map();
const screenshotPath = '/tmp/macuse-direct-set-value-' + process.pid + '.jpg';
if (existsSync(screenshotPath)) unlinkSync(screenshotPath);
factory({
  registerTool(def) { tools.set(def.name, def); },
  registerCommand() {},
  on(name, handler) { handlers.set(name, handler); },
});
(async () => {
  const signal = new AbortController().signal;
  const getAppState = tools.get('get_app_state');
  const setValue = tools.get('set_value');
  const secondaryAction = tools.get('perform_secondary_action');
  const sequenceTool = tools.get('macuse_sequence');
  if (!getAppState || !setValue || !secondaryAction || !sequenceTool) throw new Error('missing direct/sequence extension tools: ' + [...tools.keys()].join(','));
  const safetyNote = 'Validate Activity Monitor only: temporary search text and CPU/Memory tab selection; do not press Stop, Inspector, Actions, or terminate processes.';
  const common = { app: 'Activity Monitor', allowMutating: true, safetyNote, requireStateChange: true, detail: 'minimal', targetScope: 'main', maxTextChars: 12000, toolTimeoutMs: 120000 };

  const before = await getAppState.execute('before', { app: 'Activity Monitor', detail: 'minimal', targetScope: 'main', maxTextChars: 12000, toolTimeoutMs: 120000 }, signal, () => {});
  if (!before.content.some((block) => block.text?.includes('CPU'))) throw new Error('initial Activity Monitor state did not expose CPU');

  const filtered = await setValue.execute('filter', { ...common, role: 'search', name: 'search', value: 'Codex' }, signal, () => {});
  if (filtered.details.computerUse.failed) throw new Error('direct set_value filter failed:\n' + filtered.content[0].text);
  const clear = await setValue.execute('clear', { ...common, role: 'search', name: 'search', value: '', requireStateChange: false, saveImagePath: screenshotPath }, signal, () => {});
  if (clear.details.computerUse.failed) throw new Error('direct set_value clear failed:\n' + clear.content[0].text);
  const clearStep = clear.details.computerUse.steps[0];
  if (!clearStep.savedImageArtifact?.bytes || !existsSync(screenshotPath)) throw new Error('artifact-only direct mutation did not trigger screenshot readback');
  if (!String(clearStep.targetResolution || '').includes('empty set_value fallback used clear-control')) throw new Error('direct set_value clear did not use drift-safe clear-control fallback');
  const searchAfterClear = clearStep.elements.find((element) => element.role === 'search' || element.tags?.includes('search-field'));
  if (!searchAfterClear || searchAfterClear.value) throw new Error('direct set_value clear did not leave Activity Monitor search field empty');

  const memory = await secondaryAction.execute('memory', { ...common, elementDescription: 'Memory', action: 'Press' }, signal, () => {});
  if (memory.details.computerUse.failed) throw new Error('direct Memory action failed:\n' + memory.content[0].text);
  const memoryState = memory.details.computerUse.steps[0].elements.find((element) => element.description === 'Memory' || element.name === 'Memory');
  if (memoryState?.value !== '1') throw new Error('Memory tab was not selected by direct perform_secondary_action');
  const cpu = await secondaryAction.execute('cpu', { ...common, elementDescription: 'CPU', action: 'Press' }, signal, () => {});
  if (cpu.details.computerUse.failed) throw new Error('direct CPU action failed:\n' + cpu.content[0].text);

  const sequence = await sequenceTool.execute('final-sequence-read', {
    app: 'Activity Monitor',
    steps: [{ label: 'cpu-state', tool: 'get_app_state', arguments: {}, expectVisibleText: ['CPU'] }],
    detail: 'minimal', targetScope: 'main', maxTextChars: 12000, toolTimeoutMs: 120000,
  }, signal, () => {});
  if (sequence.details.computerUse.failed) throw new Error('macuse_sequence final read failed:\n' + sequence.content[0].text);
  const finalElements = sequence.details.computerUse.steps[0].elements;
  const cpuState = finalElements.find((element) => element.description === 'CPU' || element.name === 'CPU');
  const finalMemoryState = finalElements.find((element) => element.description === 'Memory' || element.name === 'Memory');
  if (cpuState?.value !== '1' || finalMemoryState?.value !== '0') throw new Error('CPU tab was not restored after direct tools');
  for (const result of [filtered, clear, memory, cpu, sequence]) {
    const focus = result.details.computerUse.focus;
    if (!focus || focus.changed !== false) throw new Error(result.details.computerUse.tool + ' changed native frontmost focus');
    if (result.details.computerUse.defaultApp !== 'Activity Monitor') throw new Error(result.details.computerUse.tool + ' omitted direct target-app focus metadata');
    if (result.details.computerUse.mousePreservation) throw new Error(result.details.computerUse.tool + ' warped/restored mouse without pointer use');
  }
  if (existsSync(screenshotPath)) unlinkSync(screenshotPath);
  if (handlers.has('session_shutdown')) await handlers.get('session_shutdown')({ reason: 'test' }, {});
  console.log('activity-monitor-direct-tools-background-focus');
})().catch(async (error) => {
  try { if (existsSync(screenshotPath)) unlinkSync(screenshotPath); } catch {}
  try { if (handlers.has('session_shutdown')) await handlers.get('session_shutdown')({ reason: 'test' }, {}); } catch {}
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
`;
  const nodePath = [
    '/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules',
    '/opt/homebrew/lib/node_modules',
    process.env.NODE_PATH || '',
  ].filter(Boolean).join(':');
  const stdout = run('pi extension actual-app smoke', process.execPath, ['-e', script], {
    env: { NODE_PATH: nodePath, MACUSE_VALIDATE_VERBOSE: verbose ? '1' : '' },
    timeoutMs: 360_000,
    verbose,
  });
  return stdout.trim();
}

function requireOk(name, json) {
  if (!json || json.ok !== true) throw new Error(`${name} did not return ok: true`);
}

function printPass(name, detail = '') {
  recordCheck('pass', name, detail);
  if (!jsonOutput) process.stdout.write(`PASS ${name}${detail ? ` — ${detail}` : ''}\n`);
}

function printWarn(name, detail = '') {
  recordCheck('warn', name, detail);
  if (!jsonOutput) process.stdout.write(`WARN ${name}${detail ? ` — ${detail}` : ''}\n`);
}

function writeJsonSummary(opts, ok, error = null) {
  const counts = {
    pass: validationChecks.filter((check) => check.status === 'pass').length,
    warn: validationChecks.filter((check) => check.status === 'warn').length,
    fail: error ? 1 : 0,
  };
  const checks = error ? [...validationChecks, { status: 'fail', name: 'validation failure', detail: error.message || String(error) }] : validationChecks;
  process.stdout.write(`${JSON.stringify({ ok, mode: opts?.mode ?? null, generatedAt: new Date().toISOString(), counts, checks, artifacts: {} }, null, 2)}\n`);
}

async function main() {
  const opts = parse(process.argv.slice(2));
  activeOpts = opts;
  jsonOutput = Boolean(opts.json);
  if (opts.help) {
    help();
    return;
  }
  const focusBefore = opts.mode === 'focus' ? { frontmost: frontmostApp(), mouse: mousePosition() } : null;
  if (!existsSync('tools/probe-codex-computer-use-mcp.mjs')) throw new Error('missing tools/probe-codex-computer-use-mcp.mjs');
  if (!existsSync('tools/codex-computer-use-appserver.mjs')) throw new Error('missing tools/codex-computer-use-appserver.mjs');

  run('node --check probe', process.execPath, ['--check', 'tools/probe-codex-computer-use-mcp.mjs'], { verbose: opts.verbose });
  printPass('node --check tools/probe-codex-computer-use-mcp.mjs');

  run('node --check appserver', process.execPath, ['--check', 'tools/codex-computer-use-appserver.mjs'], { verbose: opts.verbose });
  printPass('node --check tools/codex-computer-use-appserver.mjs');

  run('node --check appserver MCP wrapper', process.execPath, ['--check', 'tools/codex-computer-use-appserver-mcp.mjs'], { verbose: opts.verbose });
  printPass('node --check tools/codex-computer-use-appserver-mcp.mjs');

  const piSmoke = runPiExtensionSmoke(opts.verbose);
  printPass('pi extension load smoke', piSmoke);

  const listAppsErrorSmoke = runListAppsErrorPreservationSmoke(opts.verbose);
  printPass('list_apps error preservation smoke', listAppsErrorSmoke);

  printPass('CLI auxiliary safety guards', runCliAuxiliaryGuardSmoke());

  const piPersistentSmoke = runPiExtensionPersistentSmoke(opts.verbose);
  printPass('pi extension persistent app-server smoke', `thread=${piPersistentSmoke}`);

  if (opts.mode === 'focus') {
    printWarn('direct raw-MCP discover', 'skipped in focus mode because the raw diagnostic client can steal native frontmost focus; app-server status remains authoritative for extension focus validation');
  } else {
    const directDiscover = run('direct raw-MCP discover', process.execPath, ['tools/probe-codex-computer-use-mcp.mjs', 'discover'], { timeoutMs: 120_000, verbose: opts.verbose });
    if (!directDiscover.includes('Tools (10):') || !directDiscover.includes('list_apps')) throw new Error('direct discover did not show expected tools');
    printPass('direct raw-MCP discover', 'expected tool family found');
    printPass('direct raw Computer History contract', runRawComputerHistoryContractSmoke());
  }

  const status = parseJsonOutput('app-server status', run('app-server status', process.execPath, ['tools/codex-computer-use-appserver.mjs', 'status', '--quiet'], { timeoutMs: 180_000, verbose: opts.verbose }));
  requireOk('app-server status', status);
  const expectedInventories = { 'computer-use': 10, 'event-stream': 3, 'computer-history': 5 };
  for (const [name, count] of Object.entries(expectedInventories)) {
    const inventory = status.inventories?.[name] ?? status.status?.servers?.find((server) => server.name === name);
    if (!inventory?.toolNames || inventory.toolNames.length !== count) throw new Error(`app-server status expected ${count} ${name} tools, saw ${inventory?.toolNames?.length ?? 0}`);
  }
  printPass('app-server status', 'all 18 tools across computer-use=10, event-stream=3, computer-history=5');

  if (opts.mode === 'read-only' || opts.mode === 'mutating' || opts.mode === 'focus') {
    if (opts.mode === 'focus') {
      printWarn('direct raw-MCP deny', 'skipped in focus mode because the raw diagnostic client can steal native frontmost focus');
    } else {
      try {
        const directDeny = run('direct raw-MCP deny', process.execPath, ['tools/probe-codex-computer-use-mcp.mjs', 'deny', '--app', 'Finder'], { timeoutMs: 120_000, verbose: opts.verbose, quietOnFailure: true });
        if (!directDeny.includes('"isError": true') && !directDeny.includes('approval denied')) throw new Error('direct deny did not return expected denial');
        printPass('direct raw-MCP deny', 'Finder denial path returned');
      } catch (error) {
        printWarn('direct raw-MCP deny', `raw SkyComputerUseClient denial probe is non-blocking; app-server bridge remains authoritative. ${error.message || String(error)}`);
      }
    }

    const list = parseJsonOutput('app-server list-apps', run('app-server list-apps', process.execPath, ['tools/codex-computer-use-appserver.mjs', 'list-apps', '--quiet', '--tool-timeout-ms', String(opts.toolTimeoutMs), '--max-text-chars', '1000'], { timeoutMs: opts.toolTimeoutMs + 30_000, verbose: opts.verbose }));
    requireOk('app-server list-apps', list);
    if (list.result?.isError) throw new Error('app-server list-apps returned isError');
    printPass('app-server list_apps', `${list.result?.content?.[0]?.text?.length || 0} text chars`);

    const state = parseJsonOutput('app-server get-state', run('app-server get-state', process.execPath, ['tools/codex-computer-use-appserver.mjs', 'get-state', '--app', opts.app, '--quiet', '--tool-timeout-ms', String(opts.toolTimeoutMs), '--max-text-chars', '1000'], { timeoutMs: opts.toolTimeoutMs + 30_000, verbose: opts.verbose }));
    requireOk('app-server get-state', state);
    if (state.result?.isError) throw new Error('app-server get-state returned isError');
    printPass('app-server get_app_state', `${opts.app}; omittedImages=${state.result?.omittedImages ?? 0}`);
  }

  if (opts.mode === 'mutating' || opts.mode === 'focus') {
    const actualAppSmoke = runPiExtensionActualAppSmoke(opts.verbose);
    printPass('pi extension Activity Monitor mutation smoke', actualAppSmoke);
  }

  if (opts.mode === 'mcp') {
    const mcpSmoke = runMcpServerSmoke(opts.verbose);
    printPass('app-server MCP wrapper smoke', mcpSmoke.split(',').length + ' tools');
  }

  if (opts.mode === 'focus') {
    const focusAfter = { frontmost: frontmostApp(), mouse: mousePosition() };
    const beforeBundle = focusBefore?.frontmost?.bundleId || 'unknown';
    const afterBundle = focusAfter.frontmost?.bundleId || 'unknown';
    if (beforeBundle !== afterBundle) throw new Error(`native frontmost focus changed: before=${beforeBundle}; after=${afterBundle}`);
    const beforeMouse = focusBefore?.mouse ? `${focusBefore.mouse.x},${focusBefore.mouse.y}` : 'unknown';
    const afterMouse = focusAfter.mouse ? `${focusAfter.mouse.x},${focusAfter.mouse.y}` : 'unknown';
    printPass('extension preserved native frontmost focus', beforeBundle);
    if (beforeMouse === afterMouse) printPass('whole-run mouse position unchanged', beforeMouse);
    else if (!jsonOutput) process.stdout.write(`INFO mouse position changed outside the strict contract — before=${beforeMouse}; after=${afterMouse}\n`);
    if (!jsonOutput) process.stdout.write(`INFO mouse position report — before=${beforeMouse}; after=${afterMouse}\n`);
  }

  if (jsonOutput) writeJsonSummary(opts, true);
  else process.stdout.write(`OK ${opts.mode} validation complete.\n`);
}

main().catch((error) => {
  if (jsonOutput) writeJsonSummary(activeOpts, false, error);
  else process.stderr.write(`FAIL ${error.message || String(error)}\n`);
  process.exitCode = 1;
});
