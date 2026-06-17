#!/usr/bin/env node
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  COMPUTER_USE_TOOL_NAMES,
  DEFAULT_CODEX_BIN,
  DEFAULT_COMPUTER_USE_APP,
  DEFAULT_COMPUTER_USE_PLUGIN_DIR,
  REPO_ROOT,
  commandLine,
  ensureDir,
  fileExists,
  frontmostApp,
  isExecutable,
  markdownTable,
  parseJsonOutput,
  readJsonFile,
  runCommand,
  writeJsonFile,
} from './macuse-utils.mjs';

const VERSION = '0.1.0';

function help() {
  process.stdout.write(`macuse doctor ${VERSION}\n\nUsage:\n  node tools/macuse-doctor.mjs [options]\n\nOptions:\n  --out <dir>              Write doctor.json and doctor.md to a directory.\n  --json                   Print JSON to stdout instead of Markdown.\n  --full                   Also run focus and MCP wrapper mutation smokes.\n  --app <app>              Read-only get_app_state target. Default: Activity Monitor.\n  --codex <path>           Codex app-server binary. Default: ${DEFAULT_CODEX_BIN}\n  --tool-timeout-ms <ms>   Tool timeout for live checks. Default: 90000.\n  -h, --help               Show this help.\n\nExamples:\n  node tools/macuse-doctor.mjs\n  node tools/macuse-doctor.mjs --out .scratch/doctor --full\n  node tools/macuse-doctor.mjs --json --full\n`);
}

function parse(argv) {
  if (argv.includes('-h') || argv.includes('--help')) return { help: true };
  const opts = { out: null, json: false, full: false, app: 'Activity Monitor', codex: process.env.CODEX_BIN || DEFAULT_CODEX_BIN, toolTimeoutMs: 90_000 };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`${token} requires a value`);
      return argv[i];
    };
    if (token === '--out') opts.out = resolve(next());
    else if (token === '--json') opts.json = true;
    else if (token === '--full') opts.full = true;
    else if (token === '--app') opts.app = next();
    else if (token === '--codex') opts.codex = next();
    else if (token === '--tool-timeout-ms') {
      const n = Number(next());
      if (!Number.isInteger(n) || n <= 0) throw new Error('--tool-timeout-ms must be a positive integer');
      opts.toolTimeoutMs = n;
    } else throw new Error(`unknown option: ${token}`);
  }
  return opts;
}

function checkStatus(ok, warn = false) {
  if (ok) return 'pass';
  return warn ? 'warn' : 'fail';
}

function addCheck(checks, check) {
  checks.push({
    status: check.status,
    name: check.name,
    summary: check.summary,
    details: check.details ?? null,
    command: check.command ?? null,
    durationMs: check.durationMs ?? null,
  });
}

function commandCheck(name, command, args, opts = {}) {
  const result = runCommand(name, command, args, opts);
  return {
    result,
    check: {
      status: checkStatus(result.ok, opts.warn),
      name,
      summary: result.ok ? 'ok' : (result.error || result.stderr || result.stdout || `exit ${result.status}`).trim().slice(0, 500),
      command: commandLine(command, args),
      durationMs: result.durationMs,
      details: opts.keepOutput ? { stdout: result.stdout.slice(0, 4000), stderr: result.stderr.slice(0, 4000) } : null,
    },
  };
}

function toolNamesFromStatus(statusJson) {
  return statusJson?.computerUse?.toolNames || statusJson?.status?.servers?.find((server) => server.name === 'computer-use')?.toolNames || [];
}

function renderMarkdown(report) {
  const rows = report.checks.map((check) => [
    check.status === 'pass' ? '✅ pass' : check.status === 'warn' ? '⚠️ warn' : '❌ fail',
    check.name,
    check.summary,
  ]);
  const failed = report.checks.filter((check) => check.status === 'fail');
  const warned = report.checks.filter((check) => check.status === 'warn');
  return `# macuse doctor report\n\nGenerated: ${report.generatedAt}\nMode: ${report.full ? 'full' : 'standard'}\nRepo: ${report.repoRoot}\n\n## Verdict\n\n${report.ok ? '✅ macuse is ready.' : '❌ macuse needs attention.'}\n\n- Failed checks: ${failed.length}\n- Warnings: ${warned.length}\n- Computer Use tools found: ${report.computerUseTools.length}\n\n## Checks\n\n${markdownTable(['Status', 'Check', 'Summary'], rows)}\n\n## Tool surface\n\n${report.computerUseTools.length ? report.computerUseTools.map((tool) => `- ${tool}`).join('\n') : 'No Computer Use tools were discovered.'}\n\n## Recommended next commands\n\n\`\`\`bash\nnode tools/validate-macuse.mjs quick\nnode tools/validate-macuse.mjs mutating\nnode tools/validate-macuse.mjs focus\nnode tools/validate-macuse.mjs mcp\n\`\`\`\n`;
}

async function main() {
  const opts = parse(process.argv.slice(2));
  if (opts.help) {
    help();
    return;
  }

  const checks = [];
  const started = Date.now();
  const report = {
    ok: false,
    generatedAt: new Date().toISOString(),
    repoRoot: REPO_ROOT,
    full: opts.full,
    codexBin: opts.codex,
    computerUsePluginDir: DEFAULT_COMPUTER_USE_PLUGIN_DIR,
    computerUseApp: DEFAULT_COMPUTER_USE_APP,
    computerUseTools: [],
    checks,
  };

  addCheck(checks, { status: 'pass', name: 'repo root', summary: REPO_ROOT });
  addCheck(checks, { status: checkStatus(isExecutable(opts.codex)), name: 'Codex app-server binary', summary: opts.codex });
  addCheck(checks, { status: checkStatus(fileExists(DEFAULT_COMPUTER_USE_APP), true), name: 'Computer Use app bundle', summary: DEFAULT_COMPUTER_USE_APP });
  addCheck(checks, { status: checkStatus(fileExists(DEFAULT_COMPUTER_USE_PLUGIN_DIR), true), name: 'Computer Use plugin cache', summary: DEFAULT_COMPUTER_USE_PLUGIN_DIR });

  const pluginJsonPath = resolve(DEFAULT_COMPUTER_USE_PLUGIN_DIR, '.codex-plugin/plugin.json');
  if (existsSync(pluginJsonPath)) {
    const plugin = readJsonFile(pluginJsonPath);
    report.plugin = { name: plugin.name, version: plugin.version, description: plugin.description };
    addCheck(checks, { status: 'pass', name: 'Computer Use plugin metadata', summary: `${plugin.name} ${plugin.version}` });
  } else {
    addCheck(checks, { status: 'warn', name: 'Computer Use plugin metadata', summary: `missing ${pluginJsonPath}` });
  }

  const nodeVersion = commandCheck('Node version', process.execPath, ['--version']);
  addCheck(checks, { ...nodeVersion.check, summary: nodeVersion.result.stdout.trim() || nodeVersion.check.summary });

  const codexVersion = commandCheck('Codex version', opts.codex, ['--version'], { warn: true });
  addCheck(checks, { ...codexVersion.check, summary: codexVersion.result.stdout.trim() || codexVersion.result.stderr.trim() || codexVersion.check.summary });

  const frontmost = frontmostApp();
  report.frontmostApp = frontmost;
  addCheck(checks, {
    status: frontmost?.bundleId && !['com.apple.loginwindow', 'com.apple.ScreenSaver.Engine'].includes(frontmost.bundleId) ? 'pass' : 'warn',
    name: 'console frontmost app',
    summary: frontmost?.bundleId ? `${frontmost.name || '<unknown>'} (${frontmost.bundleId})` : 'no frontmost app detected; console may be locked, asleep, or outside the active WindowServer session',
    details: frontmost,
  });

  for (const script of ['tools/probe-codex-computer-use-mcp.mjs', 'tools/codex-computer-use-appserver.mjs', 'tools/codex-computer-use-appserver-mcp.mjs', 'tools/validate-macuse.mjs', 'tools/macuse-utils.mjs', 'tools/macuse-config.mjs', 'tools/macuse-doctor.mjs', 'tools/macuse-repair.mjs', 'tools/macuse-demo.mjs']) {
    const syntax = commandCheck(`syntax ${script}`, process.execPath, ['--check', script]);
    addCheck(checks, syntax.check);
  }

  const statusRun = commandCheck('app-server status', process.execPath, ['tools/codex-computer-use-appserver.mjs', 'status', '--quiet', '--codex', opts.codex], { timeoutMs: opts.toolTimeoutMs + 30_000, warn: true });
  if (statusRun.result.ok) {
    try {
      const json = parseJsonOutput('app-server status', statusRun.result.stdout);
      const names = toolNamesFromStatus(json).sort();
      report.computerUseTools = names;
      const missing = COMPUTER_USE_TOOL_NAMES.filter((tool) => !names.includes(tool));
      addCheck(checks, {
        status: missing.length ? 'fail' : 'pass',
        name: 'Computer Use app-server tool surface',
        summary: missing.length ? `missing ${missing.join(', ')}` : `${names.length} expected tools`,
        command: statusRun.check.command,
        durationMs: statusRun.result.durationMs,
      });
    } catch (error) {
      addCheck(checks, { status: 'fail', name: 'Computer Use app-server tool surface', summary: error.message, command: statusRun.check.command, durationMs: statusRun.result.durationMs });
    }
  } else {
    addCheck(checks, statusRun.check);
  }

  const validation = commandCheck('validation read-only smoke', process.execPath, ['tools/validate-macuse.mjs', 'read-only', '--json', '--app', opts.app, '--tool-timeout-ms', String(opts.toolTimeoutMs)], { timeoutMs: opts.toolTimeoutMs * 5, keepOutput: true, env: { CODEX_BIN: opts.codex } });
  if (validation.result.ok) {
    const json = parseJsonOutput('validation read-only smoke', validation.result.stdout);
    addCheck(checks, {
      ...validation.check,
      status: json.ok ? 'pass' : 'fail',
      summary: json.ok ? `${json.counts?.pass ?? 0} validation checks passed` : (json.checks?.find((check) => check.status === 'fail')?.detail || 'validation failed'),
      details: json,
    });
  } else {
    addCheck(checks, validation.check);
  }

  const config = commandCheck('config generator', process.execPath, ['tools/macuse-config.mjs', 'cursor', '--pretty']);
  addCheck(checks, { ...config.check, summary: config.result.ok && config.result.stdout.includes('macuse-codex-computer-use') ? 'generated Cursor MCP config' : config.check.summary });

  if (opts.full) {
    const focus = commandCheck('focus validation', process.execPath, ['tools/validate-macuse.mjs', 'focus'], { timeoutMs: 420_000, keepOutput: true, env: { CODEX_BIN: opts.codex } });
    addCheck(checks, focus.check);
    const mcp = commandCheck('MCP wrapper validation', process.execPath, ['tools/validate-macuse.mjs', 'mcp'], { timeoutMs: 420_000, keepOutput: true, env: { CODEX_BIN: opts.codex } });
    addCheck(checks, mcp.check);
  }

  report.durationMs = Date.now() - started;
  report.ok = checks.every((check) => check.status !== 'fail');

  if (opts.out) {
    ensureDir(opts.out);
    writeJsonFile(resolve(opts.out, 'doctor.json'), report);
    writeFileSync(resolve(opts.out, 'doctor.md'), renderMarkdown(report));
  }

  if (opts.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else process.stdout.write(renderMarkdown(report));

  if (!report.ok) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`FAIL ${error.message || String(error)}\n`);
  process.exitCode = 1;
});
