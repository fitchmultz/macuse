#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const VERSION = '0.1.0';
const DEFAULT_APP = 'Calculator';
const DEFAULT_TIMEOUT_MS = 90_000;
const validationChecks = [];
let jsonOutput = false;
let activeOpts = null;

function recordCheck(status, name, detail = '') {
  validationChecks.push({ status, name, detail });
}

function help() {
  process.stdout.write(`macuse validation ${VERSION}\n\nUsage:\n  node tools/validate-macuse.mjs quick [options]\n  node tools/validate-macuse.mjs read-only [options]\n  node tools/validate-macuse.mjs mutating [options]\n  node tools/validate-macuse.mjs focus [options]\n  node tools/validate-macuse.mjs mcp [options]\n\nModes:\n  quick\n      Syntax-check bridge scripts, smoke-load the pi extension, verify the pi\n      extension reuses one persistent app-server thread, run direct raw-MCP\n      discovery, and verify Codex app-server can discover Computer Use.\n\n  read-only\n      Run quick plus safe read-only/denial probes: direct raw-MCP deny for\n      Finder, app-server list_apps, and app-server get_app_state for an app.\n\n  mutating\n      Run read-only plus harmless Calculator mutation smokes: clear, activate\n      digit 1, verify, press key 2, verify, clear, verify restore, and validate\n      pi element_index coercion, stable element targeting, ID regex parsing,\n      allowError recovery, set_value normalization, and partial failure\n      diagnostics.\n\n  focus\n      Run mutating plus a target-app focus check. This fails if Calculator is\n      left frontmost after the sequence. Exact before/after frontmost mismatch\n      is reported as a warning because Computer Use may hand focus to another\n      non-target app. Mouse position is reported for operator review.\n\n  mcp\n      Smoke-test the Cursor/standard-MCP wrapper: initialize, tools/list,\n      get_app_state, perform_secondary_action, and restore Calculator.\n\nOptions:\n  --app <name|bundle|path>       App for read-only get_app_state. Default: ${DEFAULT_APP}\n  --tool-timeout-ms <ms>         Tool timeout for app-server probes. Default: ${DEFAULT_TIMEOUT_MS}\n  --verbose                      Print child stdout/stderr.\n  --json                         Print a machine-readable validation summary.\n  -h, --help                     Show this help.\n\nSafety:\n  quick/read-only do not click, type, drag, scroll, press keys, set values, or\n  mutate GUI state. get_app_state may launch or foreground the target app and\n  can reveal visible app contents. mutating intentionally clicks Calculator\n  buttons/keys only and restores the display to 0.\n\nExamples:\n  node tools/validate-macuse.mjs quick\n  node tools/validate-macuse.mjs read-only\n  node tools/validate-macuse.mjs mutating\n  node tools/validate-macuse.mjs focus\n  node tools/validate-macuse.mjs mcp\n  node tools/validate-macuse.mjs read-only --app Calculator --tool-timeout-ms 120000\n`);
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

function run(name, command, args, opts = {}) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: { ...process.env, ...(opts.env || {}) },
    encoding: 'utf8',
    timeout: opts.timeoutMs || 120_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (!jsonOutput && (opts.verbose || result.status !== 0)) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }
  if (result.error) throw new Error(`${name} failed to start: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${name} exited ${result.status}${result.signal ? ` signal ${result.signal}` : ''}`);
  return result.stdout;
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
  for (const expected of ['list_apps', 'get_app_state', 'perform_secondary_action', 'press_key', 'type_text', 'set_value', 'select_text', 'scroll', 'click', 'drag']) {
    if (!names.includes(expected)) throw new Error('missing MCP tool: ' + expected);
  }
  const finder = await request('tools/call', { name: 'get_app_state', arguments: { app: 'Finder', approval: 'ask' } }, 120000);
  if (!sawElicitation || finder.isError !== true) throw new Error('MCP elicitation proxy did not decline Finder as expected');
  sawElicitation = false;
  const finderInherit = await request('tools/call', { name: 'get_app_state', arguments: { app: 'Finder' } }, 120000);
  if (finderInherit.isError === true) throw new Error('MCP default inherit did not auto-accept Finder app approval');
  const calculatorState = await request('tools/call', { name: 'get_app_state', arguments: { app: 'Calculator' } }, 120000);
  const clearTarget = text(calculatorState).includes('button Clear') ? { elementDescription: 'Clear' } : { elementId: 'AllClear' };
  await request('tools/call', { name: 'perform_secondary_action', arguments: { app: 'Calculator', ...clearTarget, action: 'Press' } }, 120000);
  let pointerGuarded = false;
  try {
    await request('tools/call', { name: 'click', arguments: { app: 'Calculator', elementId: 'One' } }, 120000);
  } catch (error) {
    pointerGuarded = /allowPointer/.test(error.message || '');
  }
  if (!pointerGuarded) throw new Error('MCP wrapper did not guard pointer click without allowPointer:true');
  await request('tools/call', { name: 'perform_secondary_action', arguments: { app: 'Calculator', elementId: 'AllClear', action: 'Press' } }, 120000);
  await request('tools/call', { name: 'perform_secondary_action', arguments: { app: 'Calculator', element: 6, action: 'Press' } }, 120000);
  await request('tools/call', { name: 'perform_secondary_action', arguments: { app: 'Calculator', elementId: 'One', action: 'Press' } }, 120000);
  await request('tools/call', { name: 'perform_secondary_action', arguments: { app: 'Calculator', elementDescription: 'Clear', action: 'Press' } }, 120000);
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
const mod = jiti('./.pi/extensions/codex-computer-use.ts');
const factory = mod.default || mod;
const tools = [];
factory({
  registerTool(def) { tools.push(def.name); },
  registerCommand() {},
  on() {},
});
for (const expected of ['codex_cu_list_apps', 'codex_cu_get_app_state', 'codex_cu_sequence']) {
  if (!tools.includes(expected)) {
    throw new Error('missing extension tool: ' + expected + '; saw ' + tools.join(','));
  }
}
console.log(tools.join(','));
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

function runPiExtensionPersistentSmoke(verbose) {
  const script = String.raw`
const { createJiti } = require('jiti');
const jiti = createJiti(process.cwd() + '/validate-extension-persistent.js', { interopDefault: true });
const mod = jiti('./.pi/extensions/codex-computer-use.ts');
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
  const running = await tools.get('codex_cu_list_apps').execute('running', { runningOnly: true, maxTextChars: 5000, toolTimeoutMs: 90000 }, signal, () => {});
  if (!running.content[0].text.includes('running')) throw new Error('pi extension runningOnly list_apps returned no running apps');
  const nonRunningLines = running.content[0].text.split('\n').filter((line) => line.trim() && !line.includes('running'));
  if (nonRunningLines.length > 0) throw new Error('pi extension runningOnly list_apps kept non-running lines: ' + nonRunningLines.slice(0, 3).join(' | '));
  const first = await tools.get('codex_cu_get_app_state').execute('first', { app: 'Calculator', maxTextChars: 500, toolTimeoutMs: 90000 }, signal, () => {});
  const second = await tools.get('codex_cu_get_app_state').execute('second', { app: 'Finder', maxTextChars: 500, toolTimeoutMs: 90000 }, signal, () => {});
  const firstThread = first.details.computerUse.threadId;
  const secondThread = second.details.computerUse.threadId;
  if (!firstThread || firstThread !== secondThread) throw new Error('pi extension did not reuse persistent app-server thread');
  if (second.details.computerUse.isError) throw new Error('pi extension default inherit returned isError for Finder');
  if (second.details.computerUse.elicitationCount < 1 || second.details.computerUse.acceptedElicitations < 1) throw new Error('pi extension did not auto-accept Finder app approval via inherit');
  if (!commands.has('macuse-stop')) throw new Error('pi extension did not register /macuse-stop');
  if (!commands.has('macuse-status')) throw new Error('pi extension did not register /macuse-status');
  const notifications = [];
  const commandCtx = { ui: { notify(message, level) { notifications.push({ message, level }); } } };
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

function runPiExtensionElementTargetSmoke(verbose) {
  const script = String.raw`
const { createJiti } = require('jiti');
const jiti = createJiti(process.cwd() + '/validate-extension-element-targets.js', { interopDefault: true });
const mod = jiti('./.pi/extensions/codex-computer-use.ts');
const factory = mod.default || mod;
const tools = new Map();
const handlers = new Map();
factory({
  registerTool(def) { tools.set(def.name, def); },
  registerCommand() {},
  on(name, handler) { handlers.set(name, handler); },
});
(async () => {
  const signal = new AbortController().signal;
  await tools.get('codex_cu_get_app_state').execute('state', { app: 'Calculator', detail: 'compact', maxTextChars: 1200, toolTimeoutMs: 90000 }, signal, () => {});
  const sequence = await tools.get('codex_cu_sequence').execute('sequence', {
    app: 'Calculator',
    steps: [
      { tool: 'press_key', arguments: { key: 'Escape' } },
      { tool: 'press_key', arguments: { key: 'Escape' } },
      { tool: 'perform_secondary_action', arguments: { elementId: 'AllClear', action: 'Press' } },
      { tool: 'perform_secondary_action', arguments: { elementDescription: 'Add', action: 'NotARealAction' }, allowError: true },
      { tool: 'perform_secondary_action', arguments: { role: 'button', name: '1', action: 'Press' } },
      { tool: 'waitForText', arguments: { text: '1', timeoutMs: 5000 } },
      { tool: 'get_app_state', arguments: {}, expectVisibleText: '1' },
      { tool: 'perform_secondary_action', arguments: { targets: [{ elementId: 'AllClear' }, { elementDescription: 'Clear' }], action: 'Press' } },
      { tool: 'get_app_state', arguments: {}, expectVisibleText: '0' },
      { tool: 'perform_secondary_action', arguments: { element_index: 6, action: 'Press' } },
      { tool: 'get_app_state', arguments: {}, expectText: 'text 0' },
    ],
    allowMutating: true,
    safetyNote: 'Validate Calculator-only default app, minimal output, normalized expectText, waits, element_index coercion, role/name, elementId and elementDescription targeting, and restore to zero.',
    detail: 'minimal',
    targetScope: 'main',
    maxTextChars: 1600,
    toolTimeoutMs: 90000,
  }, signal, () => {});
  if (sequence.details.computerUse.defaultApp !== 'Calculator') throw new Error('pi extension did not record the sequence-level default app');
  if (sequence.details.computerUse.steps.some((step) => step.arguments.app !== 'Calculator')) throw new Error('pi extension did not apply the sequence-level default app to every step');
  if (sequence.details.computerUse.targetScope !== 'main') throw new Error('pi extension did not record sequence targetScope');
  if (!Array.isArray(sequence.details.computerUse.steps[6].elements) || sequence.details.computerUse.steps[6].elements.length === 0) throw new Error('pi extension did not expose machine-readable get_app_state elements in sequence details');
  if (!Array.isArray(sequence.details.computerUse.steps[6].visibleText) || !sequence.details.computerUse.steps[6].visibleText.includes('1')) throw new Error('pi extension did not expose machine-readable visibleText in sequence details');
  if (sequence.details.computerUse.steps[2].arguments.element_index !== '6') throw new Error('pi extension did not resolve Calculator elementId AllClear to current element_index');
  if (sequence.details.computerUse.steps[3].arguments.element_index !== '20') throw new Error('pi extension did not resolve Calculator elementDescription Add to current element_index');
  if (sequence.details.computerUse.steps[4].arguments.element_index !== '17') throw new Error('pi extension did not resolve Calculator role/name target One to current element_index');
  if (!String(sequence.details.computerUse.steps[5].targetResolution || '').includes('waitForText matched')) throw new Error('pi extension waitForText helper did not report a match');
  if (sequence.details.computerUse.steps[7].arguments.element_index !== '6') throw new Error('pi extension did not resolve Calculator fallback targets to current Clear element_index');
  if (!String(sequence.details.computerUse.steps[7].targetResolution || '').includes('targets[')) throw new Error('pi extension did not report fallback target resolution');
  if (sequence.details.computerUse.steps[9].arguments.element_index !== '6') throw new Error('pi extension did not coerce numeric element_index to string');
  if (sequence.details.computerUse.implicitRefreshes < 5) throw new Error('pi extension did not refresh before element-targeted sequence steps');
  const staleGuard = await tools.get('codex_cu_sequence').execute('stale-guard', {
    app: 'Calculator',
    steps: [
      { tool: 'perform_secondary_action', arguments: { element_index: 17, expectedName: 'Not One', action: 'Press' } },
    ],
    allowMutating: true,
    safetyNote: 'Validate Calculator-only raw-index stale guard rejects mismatched expectedName before mutation.',
    detail: 'minimal',
    maxTextChars: 2000,
    toolTimeoutMs: 90000,
  }, signal, () => {});
  if (!staleGuard.details.computerUse.failed) throw new Error('pi extension stale guard did not fail');
  if (!/Guard failed before mutation|Stale element_index/.test(staleGuard.content[0].text)) throw new Error('pi extension stale guard did not explain stale element_index guard failure');
  const waitTargets = await tools.get('codex_cu_sequence').execute('wait-targets', {
    app: 'Calculator',
    steps: [
      { tool: 'waitForElement', arguments: { targets: [{ elementId: 'AllClear' }, { role: 'button', name: 'Clear' }], timeoutMs: 5000 } },
    ],
    detail: 'minimal',
    maxTextChars: 2000,
    toolTimeoutMs: 90000,
  }, signal, () => {});
  if (waitTargets.details.computerUse.failed) throw new Error('pi extension waitForElement targets fallback failed');
  if (!String(waitTargets.details.computerUse.steps[0].targetResolution || '').includes('waitForElement matched')) throw new Error('pi extension waitForElement targets fallback did not report match');
  const negativeStarted = Date.now();
  const negativeWait = await tools.get('codex_cu_sequence').execute('negative-wait', {
    app: 'Calculator',
    steps: [
      { tool: 'waitForText', arguments: { text: '999-not-visible', timeoutMs: 1000, intervalMs: 5000 } },
    ],
    detail: 'minimal',
    maxTextChars: 2000,
    toolTimeoutMs: 90000,
  }, signal, () => {});
  const negativeElapsed = Date.now() - negativeStarted;
  if (!negativeWait.details.computerUse.failed) throw new Error('pi extension negative waitForText did not fail');
  if (!negativeWait.content[0].text.includes('waitForText timed out')) throw new Error('pi extension negative waitForText did not report timeout');
  if (negativeElapsed > 3000) throw new Error('pi extension negative waitForText exceeded timeout budget: ' + negativeElapsed);
  const staleWait = await tools.get('codex_cu_sequence').execute('stale-wait', {
    app: 'Calculator',
    steps: [
      { tool: 'waitForElement', arguments: { element_index: 17, expectedName: 'Not One', timeoutMs: 1000 } },
    ],
    detail: 'minimal',
    maxTextChars: 2000,
    toolTimeoutMs: 90000,
  }, signal, () => {});
  if (!staleWait.details.computerUse.failed) throw new Error('pi extension stale waitForElement guard did not fail');
  if (!/Guard failed before mutation|Stale element_index/.test(staleWait.content[0].text)) throw new Error('pi extension stale waitForElement did not explain stale element_index guard failure');
  const readOnlyDefaultApp = await tools.get('codex_cu_sequence').execute('read-only-default-app', {
    app: 'Calculator',
    steps: [
      { tool: 'list_apps', arguments: {} },
      { tool: 'get_app_state', arguments: {} },
    ],
    detail: 'minimal',
    maxTextChars: 1200,
    toolTimeoutMs: 90000,
  }, signal, () => {});
  if ('app' in readOnlyDefaultApp.details.computerUse.steps[0].arguments) throw new Error('pi extension incorrectly applied sequence-level app to list_apps');
  if (readOnlyDefaultApp.details.computerUse.steps[1].arguments.app !== 'Calculator') throw new Error('pi extension did not apply sequence-level app to get_app_state');
  const compactElementDetails = await tools.get('codex_cu_sequence').execute('compact-element-details', {
    app: 'Calculator',
    steps: [{ tool: 'get_app_state', arguments: {} }],
    detail: 'compact',
    maxTextChars: 1200,
    toolTimeoutMs: 90000,
  }, signal, () => {});
  const pollutedAction = compactElementDetails.details.computerUse.steps[0].elements
    .flatMap((element) => element.secondaryActions || [])
    .find((action) => String(action).includes('target:'));
  if (pollutedAction) throw new Error('pi extension compact-mode machine-readable elements were polluted by rendered target hints: ' + pollutedAction);
  const appLessTargets = await tools.get('codex_cu_sequence').execute('app-less-targets', {
    steps: [
      { tool: 'perform_secondary_action', arguments: { targets: [{ element_index: 6 }], action: 'Press' } },
    ],
    allowMutating: true,
    safetyNote: 'Validate app-less Calculator-style targets fail before any under-targeted mutation is sent.',
    detail: 'minimal',
    maxTextChars: 3000,
    toolTimeoutMs: 90000,
  }, signal, () => {});
  if (!appLessTargets.details.computerUse.failed) throw new Error('pi extension app-less targets did not fail');
  if (!appLessTargets.content[0].text.includes('requires an app argument')) throw new Error('pi extension app-less targets failure did not explain missing app');
  const targetAppOverride = await tools.get('codex_cu_sequence').execute('target-app-override', {
    app: 'Calculator',
    steps: [
      { tool: 'get_app_state', arguments: {} },
      { tool: 'perform_secondary_action', arguments: { targets: [{ app: 'Finder', element_index: 6 }], action: 'Press' } },
    ],
    allowMutating: true,
    safetyNote: 'Validate Calculator-only target fallback rejects target-level app overrides before mutation.',
    detail: 'minimal',
    maxTextChars: 3000,
    toolTimeoutMs: 90000,
  }, signal, () => {});
  if (!targetAppOverride.details.computerUse.failed) throw new Error('pi extension target-level app override did not fail');
  if (!targetAppOverride.content[0].text.includes('must not include app')) throw new Error('pi extension target-level app override failure did not explain app scoping');
  const malformedTargets = await tools.get('codex_cu_sequence').execute('malformed-targets', {
    app: 'Calculator',
    steps: [
      { tool: 'get_app_state', arguments: {} },
      { tool: 'perform_secondary_action', arguments: { targets: [{}], action: 'Press' } },
    ],
    allowMutating: true,
    safetyNote: 'Validate malformed Calculator-only targets fail before any under-targeted mutation is sent.',
    detail: 'minimal',
    maxTextChars: 3000,
    toolTimeoutMs: 90000,
  }, signal, () => {});
  if (!malformedTargets.details.computerUse.failed) throw new Error('pi extension malformed targets did not fail');
  if (!malformedTargets.content[0].text.includes('does not contain element_index')) throw new Error('pi extension malformed targets failure did not explain missing target');
  const partial = await tools.get('codex_cu_sequence').execute('partial', {
    steps: [
      { tool: 'get_app_state', arguments: { app: 'Calculator' } },
      { tool: 'perform_secondary_action', arguments: { app: 'Calculator', elementId: 'NoSuchElementId', action: 'Press' } },
    ],
    allowMutating: true,
    safetyNote: 'Validate Calculator-only partial error reporting for an invalid elementId without completing mutation.',
    detail: 'compact',
    maxTextChars: 3000,
    toolTimeoutMs: 90000,
  }, signal, () => {});
  if (!partial.details.computerUse.failed) throw new Error('pi extension invalid elementId did not mark sequence failed');
  if (partial.details.computerUse.steps.length !== 2) throw new Error('pi extension invalid elementId did not return completed plus failed step results');
  if (!partial.content[0].text.includes('Available targets:')) throw new Error('pi extension invalid elementId error did not include element_index fallback hints');
  const lateFailure = await tools.get('codex_cu_sequence').execute('late-failure', {
    steps: [
      { tool: 'get_app_state', arguments: { app: 'Calculator' } },
      { tool: 'get_app_state', arguments: { app: 'Calculator' } },
      { tool: 'get_app_state', arguments: { app: 'Calculator' } },
      { tool: 'get_app_state', arguments: { app: 'Calculator' } },
      { tool: 'perform_secondary_action', arguments: { app: 'Calculator', elementId: 'NoSuchElementId', action: 'Press' } },
    ],
    allowMutating: true,
    safetyNote: 'Validate late Calculator-only failures keep the failed-step diagnostic under tight maxTextChars before mutation.',
    detail: 'compact',
    maxTextChars: 1000,
    toolTimeoutMs: 90000,
  }, signal, () => {});
  if (!lateFailure.details.computerUse.failed) throw new Error('pi extension late invalid elementId did not mark sequence failed');
  if (!lateFailure.content[0].text.includes('Step 5')) throw new Error('pi extension late failure output did not prioritize the failed step');
  if (!lateFailure.content[0].text.includes('Available targets:')) throw new Error('pi extension late failure output lost the failed-step diagnostic under maxTextChars');
  const allowed = await tools.get('codex_cu_sequence').execute('allowed', {
    steps: [
      { tool: 'get_app_state', arguments: { app: 'Calculator' } },
      { tool: 'perform_secondary_action', arguments: { app: 'Calculator', elementId: 'NoSuchElementId', action: 'Press' }, allowError: true },
      { tool: 'get_app_state', arguments: { app: 'Calculator' } },
      { tool: 'set_value', arguments: { app: 'Calculator', element_index: 4 }, value: '42', allowError: true },
      { tool: 'get_app_state', arguments: { app: 'Calculator' } },
    ],
    allowMutating: true,
    safetyNote: 'Validate Calculator-only allowError recovery and top-level set_value normalization without relying on mutation success.',
    detail: 'compact',
    maxTextChars: 3000,
    toolTimeoutMs: 90000,
  }, signal, () => {});
  if (allowed.details.computerUse.failed) throw new Error('pi extension allowError resolution failure still marked sequence failed');
  if (allowed.details.computerUse.steps.length !== 5) throw new Error('pi extension allowError resolution failure did not continue to later steps');
  if (allowed.details.computerUse.steps[3].arguments.value !== '42') throw new Error('pi extension did not normalize top-level set_value step.value into arguments.value');
  const textEdit = await tools.get('codex_cu_sequence').execute('textedit-id-regex', {
    steps: [
      { tool: 'get_app_state', arguments: { app: 'TextEdit' } },
      { tool: 'perform_secondary_action', arguments: { app: 'TextEdit', elementId: 'First Text View', action: 'NotARealAction' }, allowError: true },
    ],
    allowMutating: true,
    safetyNote: 'Validate TextEdit elementId parsing for a text view using an intentionally invalid action and stop.',
    detail: 'compact',
    maxTextChars: 3000,
    toolTimeoutMs: 90000,
  }, signal, () => {});
  const textEditText = textEdit.content[0].text;
  if (textEditText.includes('No elementId First Text View') && textEditText.includes('ID: First Text View')) throw new Error('pi extension failed to parse TextEdit ID preceded by whitespace');
  const compact = await tools.get('codex_cu_get_app_state').execute('compact', { app: 'TextEdit', detail: 'compact', maxTextChars: 6000, toolTimeoutMs: 90000 }, signal, () => {});
  if (/text 6\.5|text 7|text 7\.5/.test(compact.content[0].text)) throw new Error('pi extension compact mode kept TextEdit ruler marker text');
  // TextEdit may have no document window in clean environments; validate text-view compaction only when a text view is present.
  if (/text entry area|First Text View/.test(compact.content[0].text) && !compact.content[0].text.includes('First Text View')) throw new Error('pi extension compact mode omitted TextEdit text view');
  const minimal = await tools.get('codex_cu_get_app_state').execute('minimal', { app: 'Calculator', detail: 'minimal', maxTextChars: 3000, toolTimeoutMs: 90000 }, signal, () => {});
  if (!minimal.content[0].text.includes('Visible text:') || !minimal.content[0].text.includes('Targets:')) throw new Error('pi extension minimal get_app_state omitted visible text or target sections');
  if (minimal.content[0].text.includes('Help:')) throw new Error('pi extension minimal get_app_state kept verbose help text');
  if (handlers.has('session_shutdown')) await handlers.get('session_shutdown')({ reason: 'test' }, {});
  console.log(sequence.details.computerUse.steps.map((step) => step.arguments.element_index).filter(Boolean).join(','));
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
  const stdout = run('pi extension element target smoke', process.execPath, ['-e', script], {
    env: { NODE_PATH: nodePath },
    timeoutMs: 240_000,
    verbose,
  });
  return stdout.trim();
}

function parseJsonOutput(name, text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${name} returned invalid JSON: ${error.message}\n${text.slice(0, 1000)}`);
  }
}

function requireOk(name, json) {
  if (!json || json.ok !== true) throw new Error(`${name} did not return ok: true`);
}

function runCliSequenceFailureSmoke(opts) {
  const steps = [
    { label: 'before', tool: 'get_app_state', arguments: { app: 'Calculator' } },
    { label: 'bad-target', tool: 'perform_secondary_action', arguments: { app: 'Calculator', elementId: 'DefinitelyNotARealElement', action: 'Press' } },
  ];
  const result = spawnSync(process.execPath, [
    'tools/codex-computer-use-appserver.mjs',
    'sequence',
    '--allow-mutating',
    '--steps-json', JSON.stringify(steps),
    '--quiet',
    '--pretty',
    '--max-text-chars', '5000',
    '--tool-timeout-ms', String(opts.toolTimeoutMs),
  ], { cwd: process.cwd(), encoding: 'utf8', timeout: opts.toolTimeoutMs + 60_000, maxBuffer: 10 * 1024 * 1024 });
  if (opts.verbose && !jsonOutput) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }
  if (result.status === 0) throw new Error('CLI bad-target sequence unexpectedly exited 0');
  const payload = parseJsonOutput('CLI bad-target sequence', result.stdout);
  const text = payload.steps?.flatMap((step) => step.result?.content || []).map((block) => block.text || '').join('\n') || '';
  if (payload.ok !== false) throw new Error('CLI bad-target sequence did not return ok:false');
  if (payload.failedStepIndex !== 1 || payload.completedStepCount !== 1 || payload.resumeFromStepIndex !== 1) throw new Error('CLI bad-target sequence missing structured resume fields');
  if (!Array.isArray(payload.steps) || payload.steps.length !== 2) throw new Error('CLI bad-target sequence did not preserve completed plus failed step evidence');
  if (!text.includes('Closest elementId matches')) throw new Error('CLI bad-target sequence missing closest elementId suggestions');
  if (!text.includes('target: { elementId') && !text.includes('target: { elementDescription')) throw new Error('CLI bad-target sequence missing preferred target syntax hints');
  return `failedStepIndex=${payload.failedStepIndex}; completedStepCount=${payload.completedStepCount}; resumeFromStepIndex=${payload.resumeFromStepIndex}`;
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

function frontmostApp() {
  const front = spawnSync('/usr/bin/lsappinfo', ['front'], { encoding: 'utf8', timeout: 5000 });
  if (front.status !== 0 || !front.stdout.trim()) return null;
  const asn = front.stdout.trim();
  const bundle = spawnSync('/usr/bin/lsappinfo', ['info', '-only', 'bundleid', asn], { encoding: 'utf8', timeout: 5000 });
  const name = spawnSync('/usr/bin/lsappinfo', ['info', '-only', 'name', asn], { encoding: 'utf8', timeout: 5000 });
  return {
    bundleId: (bundle.stdout.match(/="([^"]+)"/) || [])[1] || null,
    name: (name.stdout.match(/="([^"]+)"/) || [])[1] || null,
  };
}

function mousePosition() {
  const script = 'import CoreGraphics; if let e = CGEvent(source: nil) { let p = e.location; print(Int(p.x), Int(p.y)) }';
  const result = spawnSync('swift', ['-e', script], { encoding: 'utf8', timeout: 10000 });
  if (result.status !== 0) return null;
  const [x, y] = result.stdout.trim().split(/\s+/).map((value) => Number(value));
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

function stepText(step) {
  return (step?.result?.content || [])
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

function calculatorDisplay(step) {
  const match = stepText(step).match(/(?:^|\n)\s*4 text\s+([^\n]+)/);
  return match ? match[1].replace(/[\u200e\u200f]/g, '').trim() : '';
}

function calculatorMutationSteps() {
  return [
    { tool: 'get_app_state', arguments: { app: 'Calculator' } },
    { tool: 'press_key', arguments: { app: 'Calculator', key: 'Escape' } },
    { tool: 'press_key', arguments: { app: 'Calculator', key: 'Escape' } },
    { tool: 'get_app_state', arguments: { app: 'Calculator' } },
    { tool: 'perform_secondary_action', arguments: { app: 'Calculator', elementId: 'AllClear', action: 'Press' } },
    { tool: 'get_app_state', arguments: { app: 'Calculator' } },
    { tool: 'perform_secondary_action', arguments: { app: 'Calculator', elementId: 'One', action: 'Press' } },
    { tool: 'get_app_state', arguments: { app: 'Calculator' } },
    { tool: 'perform_secondary_action', arguments: { app: 'Calculator', elementDescription: 'Clear', action: 'Press' } },
    { tool: 'get_app_state', arguments: { app: 'Calculator' } },
    { tool: 'press_key', arguments: { app: 'Calculator', key: '2' } },
    { tool: 'get_app_state', arguments: { app: 'Calculator' } },
    { tool: 'perform_secondary_action', arguments: { app: 'Calculator', elementDescription: 'Clear', action: 'Press' } },
    { tool: 'get_app_state', arguments: { app: 'Calculator' } },
  ];
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

  const piPersistentSmoke = runPiExtensionPersistentSmoke(opts.verbose);
  printPass('pi extension persistent app-server smoke', `thread=${piPersistentSmoke}`);

  const directDiscover = run('direct raw-MCP discover', process.execPath, ['tools/probe-codex-computer-use-mcp.mjs', 'discover'], { timeoutMs: 120_000, verbose: opts.verbose });
  if (!directDiscover.includes('Tools (10):') || !directDiscover.includes('list_apps')) throw new Error('direct discover did not show expected tools');
  printPass('direct raw-MCP discover', 'expected tool family found');

  const status = parseJsonOutput('app-server status', run('app-server status', process.execPath, ['tools/codex-computer-use-appserver.mjs', 'status', '--quiet'], { timeoutMs: 180_000, verbose: opts.verbose }));
  requireOk('app-server status', status);
  const computerUse = status.computerUse ?? status.status?.servers?.find((server) => server.name === 'computer-use');
  if (!computerUse?.present && !computerUse?.toolNames) throw new Error('app-server status did not include computer-use');
  printPass('app-server status', `${computerUse.toolCount ?? computerUse.toolNames?.length ?? 0} tools`);

  if (opts.mode === 'read-only' || opts.mode === 'mutating' || opts.mode === 'focus') {
    const directDeny = run('direct raw-MCP deny', process.execPath, ['tools/probe-codex-computer-use-mcp.mjs', 'deny', '--app', 'Finder'], { timeoutMs: 120_000, verbose: opts.verbose });
    if (!directDeny.includes('"isError": true') && !directDeny.includes('approval denied')) throw new Error('direct deny did not return expected denial');
    printPass('direct raw-MCP deny', 'Finder denial path returned');

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
    const stepsJson = JSON.stringify(calculatorMutationSteps());
    const sequence = parseJsonOutput('app-server Calculator mutation sequence', run('app-server Calculator mutation sequence', process.execPath, [
      'tools/codex-computer-use-appserver.mjs',
      'sequence',
      '--steps-json', stepsJson,
      '--allow-mutating',
      '--quiet',
      '--tool-timeout-ms', String(opts.toolTimeoutMs),
      '--max-text-chars', '2500',
    ], { timeoutMs: opts.toolTimeoutMs + 60_000, verbose: opts.verbose }));
    requireOk('app-server Calculator mutation sequence', sequence);
    if (sequence.steps?.length !== 14) throw new Error('Calculator mutation sequence returned unexpected step count');
    for (const step of sequence.steps) {
      if (step.result?.isError) throw new Error(`Calculator mutation step ${step.index} ${step.tool} returned isError`);
    }
    const afterOne = calculatorDisplay(sequence.steps[7]);
    const afterKey = calculatorDisplay(sequence.steps[11]);
    const afterRestore = calculatorDisplay(sequence.steps[13]);
    if (sequence.steps[4].arguments.element_index !== '6') throw new Error('Calculator AllClear elementId did not resolve to current index 6');
    if (sequence.steps[6].arguments.element_index !== '17') throw new Error('Calculator One elementId did not resolve to current index 17');
    if (sequence.steps[8].arguments.element_index !== '6' || sequence.steps[12].arguments.element_index !== '6') throw new Error('Calculator Clear elementDescription did not resolve to current index 6');
    if (afterOne !== '1') throw new Error(`Calculator click did not produce display 1; got ${JSON.stringify(afterOne)}`);
    if (afterKey !== '2') throw new Error(`Calculator press_key did not produce display 2; got ${JSON.stringify(afterKey)}`);
    if (afterRestore !== '0') throw new Error(`Calculator restore did not produce display 0; got ${JSON.stringify(afterRestore)}`);
    printPass('app-server Calculator action/key smoke', `afterOne=${afterOne}; afterKey=${afterKey}; afterRestore=${afterRestore}`);

    const elementTargetSmoke = runPiExtensionElementTargetSmoke(opts.verbose);
    printPass('pi extension element target smoke', elementTargetSmoke);

    const cliFailureSmoke = runCliSequenceFailureSmoke(opts);
    printPass('CLI sequence bad-target diagnostics', cliFailureSmoke);
  }

  if (opts.mode === 'mcp') {
    const mcpSmoke = runMcpServerSmoke(opts.verbose);
    printPass('app-server MCP wrapper smoke', mcpSmoke.split(',').length + ' tools');
  }

  if (opts.mode === 'focus') {
    const focusAfter = { frontmost: frontmostApp(), mouse: mousePosition() };
    const beforeBundle = focusBefore?.frontmost?.bundleId || 'unknown';
    const afterBundle = focusAfter.frontmost?.bundleId || 'unknown';
    if (beforeBundle !== 'com.apple.calculator' && afterBundle === 'com.apple.calculator') {
      throw new Error(`target app focus check failed: Calculator was left frontmost; before=${beforeBundle}, after=${afterBundle}`);
    }
    const beforeMouse = focusBefore?.mouse ? `${focusBefore.mouse.x},${focusBefore.mouse.y}` : 'unknown';
    const afterMouse = focusAfter.mouse ? `${focusAfter.mouse.x},${focusAfter.mouse.y}` : 'unknown';
    printPass('target app not left frontmost', `before=${beforeBundle}; after=${afterBundle}`);
    if (beforeBundle === afterBundle) printPass('exact frontmost app unchanged', beforeBundle);
    else printWarn('exact frontmost app changed', `before=${beforeBundle}; after=${afterBundle}`);
    if (beforeMouse === afterMouse) printPass('whole-run mouse position unchanged', beforeMouse);
    else printWarn('whole-run mouse position changed', `before=${beforeMouse}; after=${afterMouse}; treated as observational because the operator may move the mouse`);
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
