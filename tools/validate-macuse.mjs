#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { frontmostApp, mousePosition, parseJsonOutput } from './macuse-utils.mjs';

const VERSION = '0.1.0';
const DEFAULT_APP = 'Activity Monitor';
const DEFAULT_TIMEOUT_MS = 90_000;
const validationChecks = [];
let jsonOutput = false;
let activeOpts = null;

function recordCheck(status, name, detail = '') {
  validationChecks.push({ status, name, detail });
}

function help() {
  process.stdout.write(`macuse validation ${VERSION}\n\nUsage:\n  node tools/validate-macuse.mjs quick [options]\n  node tools/validate-macuse.mjs read-only [options]\n  node tools/validate-macuse.mjs mutating [options]\n  node tools/validate-macuse.mjs focus [options]\n  node tools/validate-macuse.mjs mcp [options]\n\nModes:\n  quick\n      Syntax-check bridge scripts, smoke-load the pi extension, verify the pi\n      extension reuses one persistent app-server thread, run direct raw-MCP\n      discovery, and verify Codex app-server can discover Computer Use.\n\n  read-only\n      Run quick plus safe read-only/denial probes: direct raw-MCP deny for\n      Finder, app-server list_apps, and app-server get_app_state for an app.\n\n  mutating\n      Run read-only plus an Activity Monitor real-app mutation smoke: filter\n      search, clear search after the field name changes, switch Memory, restore\n      CPU, and verify focus is restored.\n\n  focus\n      Run mutating plus the extension sequence focus-restoration check.\n      Harness-level frontmost drift is reported only as context.\n\n  mcp\n      Smoke-test the Cursor/standard-MCP wrapper: initialize, tools/list,\n      approval elicitation, get_app_state, and pointer guard behavior.\n\nOptions:\n  --app <name|bundle|path>       App for read-only get_app_state. Default: ${DEFAULT_APP}\n  --tool-timeout-ms <ms>         Tool timeout for app-server probes. Default: ${DEFAULT_TIMEOUT_MS}\n  --verbose                      Print child stdout/stderr.\n  --json                         Print a machine-readable validation summary.\n  -h, --help                     Show this help.\n\nSafety:\n  quick/read-only do not click, type, drag, scroll, press keys, set values, or\n  mutate GUI state. get_app_state may launch or foreground the target app and\n  can reveal visible app contents. mutating edits only Activity Monitor's\n  search field and tab selection, then restores CPU/search state.\n\nExamples:\n  node tools/validate-macuse.mjs quick\n  node tools/validate-macuse.mjs read-only\n  node tools/validate-macuse.mjs mutating\n  node tools/validate-macuse.mjs focus\n  node tools/validate-macuse.mjs mcp\n  node tools/validate-macuse.mjs read-only --app \"Activity Monitor\" --tool-timeout-ms 120000\n`);
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
  const activityState = await request('tools/call', { name: 'get_app_state', arguments: { app: 'Activity Monitor' } }, 120000);
  if (!text(activityState).includes('Activity Monitor')) throw new Error('MCP Activity Monitor get_app_state did not expose app content');
  let pointerGuarded = false;
  try {
    await request('tools/call', { name: 'click', arguments: { app: 'Activity Monitor', elementDescription: 'CPU' } }, 120000);
  } catch (error) {
    pointerGuarded = /allowPointer/.test(error.message || '');
  }
  if (!pointerGuarded) throw new Error('MCP wrapper did not guard pointer click without allowPointer:true');
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
  const commandCtx = { ui: { notify(message, level) { notifications.push({ message, level }); } } };
  await commands.get('macuse-status').handler('', commandCtx);
  const lazyStatus = notifications.at(-1)?.message || '';
  if (!lazyStatus.includes('has not been started')) throw new Error('pi extension /macuse-status started or missed lazy stopped state before any tool call: ' + lazyStatus);
  const running = await tools.get('codex_cu_list_apps').execute('running', { runningOnly: true, maxTextChars: 5000, toolTimeoutMs: 90000 }, signal, () => {});
  if (!running.content[0].text.includes('running')) throw new Error('pi extension runningOnly list_apps returned no running apps');
  const nonRunningLines = running.content[0].text.split('\n').filter((line) => line.trim() && !line.includes('running'));
  if (nonRunningLines.length > 0) throw new Error('pi extension runningOnly list_apps kept non-running lines: ' + nonRunningLines.slice(0, 3).join(' | '));
  const first = await tools.get('codex_cu_get_app_state').execute('first', { app: 'Activity Monitor', maxTextChars: 500, toolTimeoutMs: 90000 }, signal, () => {});
  const second = await tools.get('codex_cu_get_app_state').execute('second', { app: 'Finder', maxTextChars: 500, toolTimeoutMs: 90000 }, signal, () => {});
  const firstThread = first.details.computerUse.threadId;
  const secondThread = second.details.computerUse.threadId;
  if (!firstThread || firstThread !== secondThread) throw new Error('pi extension did not reuse persistent app-server thread');
  if (second.details.computerUse.isError) throw new Error('pi extension default inherit returned isError for Finder');
  if (second.details.computerUse.elicitationCount < 1 || second.details.computerUse.acceptedElicitations < 1) throw new Error('pi extension did not auto-accept Finder app approval via inherit');
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
const jiti = createJiti(process.cwd() + '/validate-extension-actual-app.js', { interopDefault: true });
const mod = jiti('./extensions/codex-computer-use.ts');
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
  const sequence = await tools.get('codex_cu_sequence').execute('actual-app', {
    app: 'Activity Monitor',
    steps: [
      { label: 'before', tool: 'get_app_state', arguments: {}, expectVisibleText: 'CPU' },
      { label: 'filter', tool: 'set_value', arguments: { role: 'search', name: 'search', value: 'Codex' }, requireStateChange: true },
      { label: 'filtered-state', tool: 'get_app_state', arguments: {}, expectVisibleText: 'Codex' },
      { label: 'clear-after-name-drift', tool: 'set_value', arguments: { role: 'search', name: 'search', value: '' }, requireStateChange: true },
      { label: 'cleared-state', tool: 'get_app_state', arguments: {}, expectVisibleText: 'Activity Monitor All Processes' },
      { label: 'memory-tab', tool: 'perform_secondary_action', arguments: { elementDescription: 'Memory', action: 'Press' }, requireStateChange: true },
      { label: 'memory-state', tool: 'get_app_state', arguments: {}, expectVisibleText: 'Memory' },
      { label: 'cpu-restore', tool: 'perform_secondary_action', arguments: { elementDescription: 'CPU', action: 'Press' }, requireStateChange: true },
      { label: 'cpu-state', tool: 'get_app_state', arguments: {}, expectVisibleText: 'CPU' },
    ],
    allowMutating: true,
    safetyNote: 'Validate Activity Monitor only: temporary search text and CPU/Memory tab selection; do not press Stop, Inspector, Actions, or terminate processes.',
    detail: 'minimal',
    targetScope: 'main',
    maxTextChars: 12000,
    toolTimeoutMs: 120000,
  }, signal, () => {});
  if (sequence.details.computerUse.failed) throw new Error('actual-app sequence failed:\n' + sequence.content[0].text);
  const clearStep = sequence.details.computerUse.steps[3];
  if (!String(clearStep.targetResolution || '').includes('empty set_value fallback used clear-control')) throw new Error('search clear did not use drift-safe clear-control fallback');
  const searchAfterClear = sequence.details.computerUse.steps[4].elements.find((element) => element.role === 'search' || element.tags?.includes('search-field'));
  if (!searchAfterClear || searchAfterClear.value) throw new Error('search clear did not leave Activity Monitor search field empty');
  const memoryState = sequence.details.computerUse.steps[6].elements.find((element) => element.description === 'Memory' || element.name === 'Memory');
  if (memoryState?.value !== '1') throw new Error('Memory tab was not selected after Memory action');
  const finalElements = sequence.details.computerUse.steps[8].elements;
  const cpuState = finalElements.find((element) => element.description === 'CPU' || element.name === 'CPU');
  const finalMemoryState = finalElements.find((element) => element.description === 'Memory' || element.name === 'Memory');
  if (cpuState?.value !== '1' || finalMemoryState?.value !== '0') throw new Error('CPU tab was not restored after Activity Monitor sequence');
  const focus = sequence.details.computerUse.focus;
  if (!focus || focus.changed !== false) throw new Error('actual-app sequence did not prove frontmost focus restoration');
  if (handlers.has('session_shutdown')) await handlers.get('session_shutdown')({ reason: 'test' }, {});
  console.log('activity-monitor-search-clear-tabs-focus');
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

function restoreFrontmostApp(app) {
  if (!app?.bundleId) return false;
  return spawnSync('/usr/bin/open', ['-b', app.bundleId], { encoding: 'utf8', timeout: 10000 }).status === 0;
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
  if (Array.isArray(computerUse.missingTools) && computerUse.missingTools.length > 0) throw new Error(`app-server status missing Computer Use tools: ${computerUse.missingTools.join(', ')}`);
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
    const actualAppSmoke = runPiExtensionActualAppSmoke(opts.verbose);
    printPass('pi extension Activity Monitor mutation smoke', actualAppSmoke);
  }

  if (opts.mode === 'mcp') {
    const mcpSmoke = runMcpServerSmoke(opts.verbose);
    printPass('app-server MCP wrapper smoke', mcpSmoke.split(',').length + ' tools');
  }

  if (opts.mode === 'focus') {
    let focusAfter = { frontmost: frontmostApp(), mouse: mousePosition() };
    const beforeBundle = focusBefore?.frontmost?.bundleId || 'unknown';
    let afterBundle = focusAfter.frontmost?.bundleId || 'unknown';
    let harnessRestored = false;
    if (beforeBundle !== 'unknown' && beforeBundle !== afterBundle) {
      harnessRestored = restoreFrontmostApp(focusBefore.frontmost);
      await new Promise((resolve) => setTimeout(resolve, 300));
      focusAfter = { frontmost: frontmostApp(), mouse: mousePosition() };
      afterBundle = focusAfter.frontmost?.bundleId || 'unknown';
    }
    if (beforeBundle !== afterBundle) throw new Error(`focus harness failed to restore frontmost app: before=${beforeBundle}; after=${afterBundle}`);
    const beforeMouse = focusBefore?.mouse ? `${focusBefore.mouse.x},${focusBefore.mouse.y}` : 'unknown';
    const afterMouse = focusAfter.mouse ? `${focusAfter.mouse.x},${focusAfter.mouse.y}` : 'unknown';
    printPass('extension and harness restored frontmost focus', `${beforeBundle}; harnessRestored=${harnessRestored}`);
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
