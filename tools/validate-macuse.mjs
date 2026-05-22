#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const VERSION = '0.1.0';
const DEFAULT_APP = 'Calculator';
const DEFAULT_TIMEOUT_MS = 90_000;

function help() {
  process.stdout.write(`macuse validation ${VERSION}\n\nUsage:\n  node tools/validate-macuse.mjs quick [options]\n  node tools/validate-macuse.mjs read-only [options]\n\nModes:\n  quick\n      Syntax-check bridge scripts, smoke-load the pi extension, run direct\n      raw-MCP discovery, and verify Codex app-server can discover Computer Use.\n\n  read-only\n      Run quick plus safe read-only/denial probes: direct raw-MCP deny for\n      Finder, app-server list_apps, and app-server get_app_state for an app.\n\nOptions:\n  --app <name|bundle|path>       App for read-only get_app_state. Default: ${DEFAULT_APP}\n  --tool-timeout-ms <ms>         Tool timeout for app-server probes. Default: ${DEFAULT_TIMEOUT_MS}\n  --verbose                      Print child stdout/stderr.\n  -h, --help                     Show this help.\n\nSafety:\n  This script only runs syntax checks, discovery, app-approval denial,\n  list_apps, and get_app_state. It does not click, type, drag, scroll, press\n  keys, set values, or mutate GUI state. get_app_state may launch or foreground\n  the target app and can reveal visible app contents.\n\nExamples:\n  node tools/validate-macuse.mjs quick\n  node tools/validate-macuse.mjs read-only\n  node tools/validate-macuse.mjs read-only --app Calculator --tool-timeout-ms 120000\n`);
}

function parse(argv) {
  if (argv.includes('-h') || argv.includes('--help')) return { help: true };
  const mode = argv.shift() || 'quick';
  if (!['quick', 'read-only'].includes(mode)) throw new Error(`unknown mode: ${mode}`);
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
for (const expected of ['codex_cu_list_apps', 'codex_cu_get_app_state']) {
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

async function main() {
  const opts = parse(process.argv.slice(2));
  if (opts.help) {
    help();
    return;
  }
  if (!existsSync('tools/probe-codex-computer-use-mcp.mjs')) throw new Error('missing tools/probe-codex-computer-use-mcp.mjs');
  if (!existsSync('tools/codex-computer-use-appserver.mjs')) throw new Error('missing tools/codex-computer-use-appserver.mjs');

  run('node --check probe', process.execPath, ['--check', 'tools/probe-codex-computer-use-mcp.mjs'], { verbose: opts.verbose });
  printPass('node --check tools/probe-codex-computer-use-mcp.mjs');

  run('node --check appserver', process.execPath, ['--check', 'tools/codex-computer-use-appserver.mjs'], { verbose: opts.verbose });
  printPass('node --check tools/codex-computer-use-appserver.mjs');

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

  if (opts.mode === 'read-only') {
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

  process.stdout.write(`OK ${opts.mode} validation complete.\n`);
}

main().catch((error) => {
  process.stderr.write(`FAIL ${error.message || String(error)}\n`);
  process.exitCode = 1;
});
