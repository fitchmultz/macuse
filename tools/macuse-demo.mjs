#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  REPO_ROOT,
  VERSION,
  commandLine,
  ensureDir,
  markdownTable,
  nowIsoForPath,
  parseJsonOutput,
  runCommand,
  writeJsonFile,
} from './macuse-utils.mjs';

function help() {
  process.stdout.write(`macuse live demo ${VERSION}\n\nUsage:\n  node tools/macuse-demo.mjs [options]\n\nOptions:\n  --out <dir>              Artifact directory. Default: .scratch/macuse-demo-<timestamp>.\n  --skip-doctor            Skip the embedded standard doctor pass.\n  --skip-mcp               Skip the standard-MCP wrapper validation pass.\n  --tool-timeout-ms <ms>   Tool timeout for live checks. Default: 90000.\n  -h, --help               Show this help.\n\nWhat it proves:\n  - app-server-backed Computer Use works outside Codex\n  - the pi extension survives a real Activity Monitor app flow\n  - Activity Monitor search-name drift is handled\n  - CPU/Memory tab actions restore safely\n  - strict frontmost focus validation passes\n  - Cursor/standard-MCP wrapper is ready, unless --skip-mcp is passed\n\nExamples:\n  node tools/macuse-demo.mjs\n  node tools/macuse-demo.mjs --out .scratch/demo\n`);
}

function parse(argv) {
  if (argv.includes('-h') || argv.includes('--help')) return { help: true };
  const opts = { out: resolve(REPO_ROOT, '.scratch', `macuse-demo-${nowIsoForPath()}`), skipDoctor: false, skipMcp: false, toolTimeoutMs: 90_000 };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`${token} requires a value`);
      return argv[i];
    };
    if (token === '--out') opts.out = resolve(next());
    else if (token === '--skip-doctor') opts.skipDoctor = true;
    else if (token === '--skip-mcp') opts.skipMcp = true;
    else if (token === '--tool-timeout-ms') {
      const n = Number(next());
      if (!Number.isInteger(n) || n <= 0) throw new Error('--tool-timeout-ms must be a positive integer');
      opts.toolTimeoutMs = n;
    } else throw new Error(`unknown option: ${token}`);
  }
  return opts;
}

function runJsonCommand(name, args, timeoutMs) {
  const result = runCommand(name, process.execPath, args, { timeoutMs });
  return {
    name,
    command: commandLine(process.execPath, args),
    durationMs: result.durationMs,
    ok: result.ok,
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    json: result.ok ? parseJsonOutput(name, result.stdout) : null,
  };
}

function renderReport(report) {
  return `# macuse live demo\n\nGenerated: ${report.generatedAt}\nArtifact directory: ${report.out}\n\n## Verdict\n\n${report.ok ? '✅ macuse actual-app demo passed.' : '❌ Demo found a problem. Inspect transcript.json.'}\n\n${markdownTable(['Proof point', 'Status', 'Evidence'], [
    ['Doctor', report.status.doctor === null ? 'skipped' : report.status.doctor ? '✅' : '❌', report.status.doctor === null ? 'not run' : 'standard checks passed'],
    ['Activity Monitor mutation', report.status.mutating ? '✅' : '❌', 'search drift, clear fallback, Memory, CPU restore'],
    ['Strict focus', report.status.focus ? '✅' : '❌', 'frontmost app unchanged'],
    ['MCP wrapper', report.status.mcp === null ? 'skipped' : report.status.mcp ? '✅' : '❌', report.status.mcp === null ? 'not run' : 'approval/get_state/pointer guard passed'],
  ])}\n\n## Artifacts\n\n${markdownTable(['Artifact', 'Path'], [
    ['Report', 'report.md'],
    ['HTML dashboard', 'index.html'],
    ['Transcript', 'transcript.json'],
    ['Cursor MCP config', 'cursor-mcp.json'],
  ])}\n\n## Re-run\n\n\`\`\`bash\nnode tools/macuse-demo.mjs --out ${report.out}\n\`\`\`\n`;
}

function renderHtml(report) {
  const safe = (value) => String(value ?? '').replace(/[&<>]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[char]));
  const badge = report.ok ? '<span class="badge pass">READY</span>' : '<span class="badge fail">CHECK</span>';
  return `<!doctype html><meta charset="utf-8"><title>macuse live demo</title><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:40px;background:#0b1020;color:#edf2ff}.card{background:#151b2f;border:1px solid #29324d;border-radius:18px;padding:24px;margin:18px 0}.badge{display:inline-block;padding:8px 12px;border-radius:999px;font-weight:800}.pass{background:#143d2a;color:#75f0ac}.fail{background:#4a1820;color:#ff8fa3}td,th{border-bottom:1px solid #29324d;padding:10px;text-align:left}</style><h1>macuse actual-app demo ${badge}</h1><p>Generated ${safe(report.generatedAt)}</p><div class="card"><h2>Proof</h2><table><tr><th>Check</th><th>Status</th></tr><tr><td>Doctor</td><td>${safe(report.status.doctor)}</td></tr><tr><td>Activity Monitor mutation</td><td>${safe(report.status.mutating)}</td></tr><tr><td>Strict focus</td><td>${safe(report.status.focus)}</td></tr><tr><td>MCP wrapper</td><td>${safe(report.status.mcp)}</td></tr></table></div><div class="card"><h2>Artifacts</h2><ul><li><a href="report.md">report.md</a></li><li><a href="transcript.json">transcript.json</a></li><li><a href="cursor-mcp.json">cursor-mcp.json</a></li></ul></div>`;
}

async function main() {
  const opts = parse(process.argv.slice(2));
  if (opts.help) {
    help();
    return;
  }
  ensureDir(opts.out);

  const transcript = { generatedAt: new Date().toISOString(), out: opts.out, commands: [] };
  const cursorConfigPath = resolve(opts.out, 'cursor-mcp.json');
  const config = runCommand('generate Cursor MCP config', process.execPath, ['tools/macuse-config.mjs', 'cursor', '--pretty', '--out', cursorConfigPath], { timeoutMs: 30_000 });
  transcript.commands.push({ name: 'generate Cursor MCP config', command: commandLine(process.execPath, ['tools/macuse-config.mjs', 'cursor', '--pretty', '--out', cursorConfigPath]), ok: config.ok, durationMs: config.durationMs, stdout: config.stdout, stderr: config.stderr });

  const doctor = opts.skipDoctor ? null : runJsonCommand('macuse doctor', ['tools/macuse-doctor.mjs', '--out', resolve(opts.out, 'doctor'), '--json', '--tool-timeout-ms', String(opts.toolTimeoutMs)], opts.toolTimeoutMs * 4);
  if (doctor) transcript.commands.push(doctor);

  const mutating = runJsonCommand('actual-app mutating validation', ['tools/validate-macuse.mjs', 'mutating', '--json', '--tool-timeout-ms', String(opts.toolTimeoutMs)], 600_000);
  transcript.commands.push(mutating);

  const focus = runJsonCommand('strict focus validation', ['tools/validate-macuse.mjs', 'focus', '--json', '--tool-timeout-ms', String(opts.toolTimeoutMs)], 600_000);
  transcript.commands.push(focus);

  const mcp = opts.skipMcp ? null : runJsonCommand('MCP wrapper validation', ['tools/validate-macuse.mjs', 'mcp', '--json', '--tool-timeout-ms', String(opts.toolTimeoutMs)], 600_000);
  if (mcp) transcript.commands.push(mcp);

  const report = {
    ok: config.ok && (doctor ? doctor.json?.ok === true : true) && mutating.json?.ok === true && focus.json?.ok === true && (mcp ? mcp.json?.ok === true : true),
    generatedAt: transcript.generatedAt,
    out: opts.out,
    repoRoot: REPO_ROOT,
    status: {
      doctor: doctor ? doctor.json?.ok === true : null,
      mutating: mutating.json?.ok === true,
      focus: focus.json?.ok === true,
      mcp: mcp ? mcp.json?.ok === true : null,
    },
    artifacts: { report: resolve(opts.out, 'report.md'), html: resolve(opts.out, 'index.html'), transcript: resolve(opts.out, 'transcript.json'), cursorConfig: cursorConfigPath },
  };

  transcript.report = report;
  writeJsonFile(resolve(opts.out, 'transcript.json'), transcript);
  writeJsonFile(resolve(opts.out, 'manifest.json'), report);
  writeFileSync(resolve(opts.out, 'report.md'), renderReport(report));
  writeFileSync(resolve(opts.out, 'index.html'), renderHtml(report));

  process.stdout.write(`macuse demo complete\nreport: ${resolve(opts.out, 'report.md')}\nhtml:   ${resolve(opts.out, 'index.html')}\nok:     ${report.ok}\n`);
  if (!report.ok) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`FAIL ${error.message || String(error)}\n`);
  process.exitCode = 1;
});
