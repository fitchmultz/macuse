#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const VERSION = '0.1.0';
const DEFAULT_APP = 'Calculator';
const DEFAULT_TIMEOUT_MS = 90_000;

function help() {
  process.stdout.write(`macuse validation ${VERSION}\n\nUsage:\n  node tools/validate-macuse.mjs quick [options]\n  node tools/validate-macuse.mjs read-only [options]\n  node tools/validate-macuse.mjs mutating [options]\n  node tools/validate-macuse.mjs focus [options]\n  node tools/validate-macuse.mjs mcp [options]\n\nModes:\n  quick\n      Syntax-check bridge scripts, smoke-load the pi extension, run direct\n      raw-MCP discovery, and verify Codex app-server can discover Computer Use.\n\n  read-only\n      Run quick plus safe read-only/denial probes: direct raw-MCP deny for\n      Finder, app-server list_apps, and app-server get_app_state for an app.\n\n  mutating\n      Run read-only plus a harmless Calculator mutation smoke test: clear,\n      activate digit 1, verify, press key 2, verify, clear, and verify restore.\n\n  focus\n      Run mutating plus a frontmost-app preservation check. This fails if the\n      Calculator target is left frontmost after the sequence. Mouse position is\n      reported for operator review because humans may move it during the run.\n\n  mcp\n      Smoke-test the Cursor/standard-MCP wrapper: initialize, tools/list,\n      get_app_state, perform_secondary_action, and restore Calculator.\n\nOptions:\n  --app <name|bundle|path>       App for read-only get_app_state. Default: ${DEFAULT_APP}\n  --tool-timeout-ms <ms>         Tool timeout for app-server probes. Default: ${DEFAULT_TIMEOUT_MS}\n  --verbose                      Print child stdout/stderr.\n  -h, --help                     Show this help.\n\nSafety:\n  quick/read-only do not click, type, drag, scroll, press keys, set values, or\n  mutate GUI state. get_app_state may launch or foreground the target app and\n  can reveal visible app contents. mutating intentionally clicks Calculator\n  buttons/keys only and restores the display to 0.\n\nExamples:\n  node tools/validate-macuse.mjs quick\n  node tools/validate-macuse.mjs read-only\n  node tools/validate-macuse.mjs mutating\n  node tools/validate-macuse.mjs focus\n  node tools/validate-macuse.mjs mcp\n  node tools/validate-macuse.mjs read-only --app Calculator --tool-timeout-ms 120000\n`);
}
function parse(argv) {
  if (argv.includes('-h') || argv.includes('--help')) return { help: true };
  const mode = argv.shift() || 'quick';
  if (!['quick', 'read-only', 'mutating', 'focus', 'mcp'].includes(mode)) throw new Error(`unknown mode: ${mode}`);
  const opts = { mode, app: DEFAULT_APP, toolTimeoutMs: DEFAULT_TIMEOUT_MS, verbose: false };
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
  if (opts.verbose || result.status !== 0) {
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
const pending = new Map();
function send(message) { proc.stdin.write(JSON.stringify(message) + '\n'); }
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
  await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'validate-macuse', version: '0' } }, 5000);
  send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
  const listed = await request('tools/list', {}, 5000);
  const names = listed.tools.map((tool) => tool.name);
  for (const expected of ['list_apps', 'get_app_state', 'perform_secondary_action', 'press_key', 'type_text', 'set_value', 'select_text', 'scroll', 'click', 'drag']) {
    if (!names.includes(expected)) throw new Error('missing MCP tool: ' + expected);
  }
  await request('tools/call', { name: 'get_app_state', arguments: { app: 'Calculator', approval: 'accept-once' } }, 120000);
  await request('tools/call', { name: 'perform_secondary_action', arguments: { app: 'Calculator', element_index: '17', action: 'Press' } }, 120000);
  await request('tools/call', { name: 'perform_secondary_action', arguments: { app: 'Calculator', element_index: '6', action: 'Press' } }, 120000);
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

function printPass(name, detail = '') {
  process.stdout.write(`PASS ${name}${detail ? ` — ${detail}` : ''}\n`);
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
    { tool: 'perform_secondary_action', arguments: { app: 'Calculator', element_index: '6', action: 'Press' } },
    { tool: 'get_app_state', arguments: { app: 'Calculator' } },
    { tool: 'perform_secondary_action', arguments: { app: 'Calculator', element_index: '17', action: 'Press' } },
    { tool: 'get_app_state', arguments: { app: 'Calculator' } },
    { tool: 'perform_secondary_action', arguments: { app: 'Calculator', element_index: '6', action: 'Press' } },
    { tool: 'get_app_state', arguments: { app: 'Calculator' } },
    { tool: 'press_key', arguments: { app: 'Calculator', key: '2' } },
    { tool: 'get_app_state', arguments: { app: 'Calculator' } },
    { tool: 'perform_secondary_action', arguments: { app: 'Calculator', element_index: '6', action: 'Press' } },
    { tool: 'get_app_state', arguments: { app: 'Calculator' } },
  ];
}

async function main() {
  const opts = parse(process.argv.slice(2));
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

  const directDiscover = run('direct raw-MCP discover', process.execPath, ['tools/probe-codex-computer-use-mcp.mjs', 'discover'], { timeoutMs: 120_000, verbose: opts.verbose });
  if (!directDiscover.includes('Tools (10):') || !directDiscover.includes('list_apps')) throw new Error('direct discover did not show expected tools');
  printPass('direct raw-MCP discover', 'expected tool family found');

  const status = parseJsonOutput('app-server status', run('app-server status', process.execPath, ['tools/codex-computer-use-appserver.mjs', 'status', '--quiet'], { timeoutMs: 180_000, verbose: opts.verbose }));
  requireOk('app-server status', status);
  const computerUse = status.status?.servers?.find((server) => server.name === 'computer-use');
  if (!computerUse) throw new Error('app-server status did not include computer-use');
  printPass('app-server status', `${computerUse.toolNames?.length || 0} tools`);

  if (opts.mode === 'read-only' || opts.mode === 'mutating' || opts.mode === 'focus') {
    const directDeny = run('direct raw-MCP deny', process.execPath, ['tools/probe-codex-computer-use-mcp.mjs', 'deny', '--app', 'Finder'], { timeoutMs: 120_000, verbose: opts.verbose });
    if (!directDeny.includes('"isError": true') && !directDeny.includes('approval denied')) throw new Error('direct deny did not return expected denial');
    printPass('direct raw-MCP deny', 'Finder denial path returned');

    const list = parseJsonOutput('app-server list-apps', run('app-server list-apps', process.execPath, ['tools/codex-computer-use-appserver.mjs', 'list-apps', '--quiet', '--tool-timeout-ms', String(opts.toolTimeoutMs), '--max-text-chars', '1000'], { timeoutMs: opts.toolTimeoutMs + 30_000, verbose: opts.verbose }));
    requireOk('app-server list-apps', list);
    if (list.result?.isError) throw new Error('app-server list-apps returned isError');
    printPass('app-server list_apps', `${list.result?.content?.[0]?.text?.length || 0} text chars`);

    const state = parseJsonOutput('app-server get-state', run('app-server get-state', process.execPath, ['tools/codex-computer-use-appserver.mjs', 'get-state', '--app', opts.app, '--approval', 'accept-once', '--quiet', '--tool-timeout-ms', String(opts.toolTimeoutMs), '--max-text-chars', '1000'], { timeoutMs: opts.toolTimeoutMs + 30_000, verbose: opts.verbose }));
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
      '--approval', 'accept-once',
      '--quiet',
      '--tool-timeout-ms', String(opts.toolTimeoutMs),
      '--max-text-chars', '2500',
    ], { timeoutMs: opts.toolTimeoutMs + 60_000, verbose: opts.verbose }));
    requireOk('app-server Calculator mutation sequence', sequence);
    if (sequence.steps?.length !== 11) throw new Error('Calculator mutation sequence returned unexpected step count');
    for (const step of sequence.steps) {
      if (step.result?.isError) throw new Error(`Calculator mutation step ${step.index} ${step.tool} returned isError`);
    }
    const afterOne = calculatorDisplay(sequence.steps[4]);
    const afterKey = calculatorDisplay(sequence.steps[8]);
    const afterRestore = calculatorDisplay(sequence.steps[10]);
    if (afterOne !== '1') throw new Error(`Calculator click did not produce display 1; got ${JSON.stringify(afterOne)}`);
    if (afterKey !== '2') throw new Error(`Calculator press_key did not produce display 2; got ${JSON.stringify(afterKey)}`);
    if (afterRestore !== '0') throw new Error(`Calculator restore did not produce display 0; got ${JSON.stringify(afterRestore)}`);
    printPass('app-server Calculator action/key smoke', `afterOne=${afterOne}; afterKey=${afterKey}; afterRestore=${afterRestore}`);
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
      throw new Error(`focus preservation failed: Calculator was left frontmost; before=${beforeBundle}, after=${afterBundle}`);
    }
    const beforeMouse = focusBefore?.mouse ? `${focusBefore.mouse.x},${focusBefore.mouse.y}` : 'unknown';
    const afterMouse = focusAfter.mouse ? `${focusAfter.mouse.x},${focusAfter.mouse.y}` : 'unknown';
    printPass('frontmost app preservation', `before=${beforeBundle}; after=${afterBundle}`);
    process.stdout.write(`INFO mouse position report — before=${beforeMouse}; after=${afterMouse}\n`);
  }

  process.stdout.write(`OK ${opts.mode} validation complete.\n`);
}

main().catch((error) => {
  process.stderr.write(`FAIL ${error.message || String(error)}\n`);
  process.exitCode = 1;
});
