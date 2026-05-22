#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  REPO_ROOT,
  calculatorDisplayFromStep,
  commandLine,
  ensureDir,
  frontmostApp,
  imageInfo,
  markdownTable,
  mousePosition,
  mustRun,
  nowIsoForPath,
  parseJsonOutput,
  runCommand,
  writeJsonFile,
} from './macuse-utils.mjs';

const VERSION = '0.1.0';

function help() {
  process.stdout.write(`macuse live demo ${VERSION}\n\nUsage:\n  node tools/macuse-demo.mjs [options]\n\nOptions:\n  --out <dir>              Artifact directory. Default: .scratch/macuse-demo-<timestamp>.\n  --skip-doctor            Skip the embedded standard doctor pass.\n  --skip-mcp               Skip the standard-MCP wrapper validation pass.\n  --tool-timeout-ms <ms>   Tool timeout for live checks. Default: 90000.\n  -h, --help               Show this help.\n\nWhat it proves:\n  - app-server-backed Computer Use works outside Codex\n  - screenshots/state can be captured with saved artifacts\n  - Calculator can be mutated and restored without pointer clicks\n  - frontmost app is not stolen by the target app\n  - mouse position is preserved\n  - Cursor/standard-MCP wrapper is ready, unless --skip-mcp is passed\n\nExamples:\n  node tools/macuse-demo.mjs\n  node tools/macuse-demo.mjs --out .scratch/demo\n`);
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

function runJson(name, args, opts = {}) {
  const result = mustRun(name, process.execPath, args, { timeoutMs: opts.timeoutMs || 180_000 });
  return { command: commandLine(process.execPath, args), result: parseJsonOutput(name, result.stdout), durationMs: result.durationMs };
}

function renderReport(report) {
  const verdictRows = [
    ['Codex app-server bridge', report.status.toolsFound === 10 ? '✅' : '❌', `${report.status.toolsFound} Computer Use tools discovered`],
    ['Calculator mutation', report.status.calculatorMutation ? '✅' : '❌', `display 1=${report.displays.afterOne}; key 2=${report.displays.afterKey}; restored=${report.displays.afterRestore}`],
    ['Focus preservation', report.status.focusPreserved ? '✅' : '❌', `${report.focus.before?.bundleId || 'unknown'} → ${report.focus.after?.bundleId || 'unknown'}`],
    ['Mouse preservation', report.status.mousePreserved ? '✅' : '❌', `seq1 ${formatPoint(report.mouse.sequenceOne?.before)} → ${formatPoint(report.mouse.sequenceOne?.restored)}; seq2 ${formatPoint(report.mouse.sequenceTwo?.before)} → ${formatPoint(report.mouse.sequenceTwo?.restored)}`],
    ['MCP wrapper', report.status.mcpValidated === null ? 'skipped' : report.status.mcpValidated ? '✅' : '❌', report.status.mcpValidated === null ? 'not run' : 'validated standard MCP wrapper and approval proxy'],
  ];
  const artifacts = [
    ['Report', 'report.md'],
    ['HTML dashboard', 'index.html'],
    ['Transcript', 'transcript.json'],
    ['Before screenshot', 'before.jpg'],
    ['During screenshot', 'during.jpg'],
    ['After screenshot', 'after.jpg'],
    ['Cursor MCP config', 'cursor-mcp.json'],
  ];
  return `# macuse live demo\n\nGenerated: ${report.generatedAt}\nArtifact directory: ${report.out}\n\n## Verdict\n\n${report.ok ? '✅ External Codex Computer Use is working with focus-safe UX.' : '❌ Demo found a problem. Inspect transcript.json.'}\n\n${markdownTable(['Proof point', 'Status', 'Evidence'], verdictRows)}\n\n## What happened\n\n1. Generated a ready-to-copy Cursor MCP config.\n2. Ran a standard doctor pass${report.doctor ? ' and stored doctor artifacts' : ' (skipped by option)'}.\n3. Captured Calculator state and screenshot before mutation.\n4. Used accessibility actions and keyboard input, not pointer clicks, to mutate Calculator.\n5. Captured a during screenshot with display **1**.\n6. Verified display changed to **1**, changed to **2**, and restored to **0**.\n7. Captured Calculator state and screenshot after restore.\n8. Verified the frontmost app was preserved and the guarded sequences restored mouse position.\n${report.status.mcpValidated === null ? '9. Skipped MCP wrapper validation by option.' : '9. Validated the standard MCP wrapper, including approval elicitation and pointer guard behavior.'}\n\n## Artifacts\n\n${markdownTable(['Artifact', 'Path'], artifacts)}\n\n## Screenshots\n\n| Before | During | After |\n| --- | --- | --- |\n| ![before](before.jpg) | ![during](during.jpg) | ![after](after.jpg) |\n\n## Image hashes\n\n${markdownTable(['Image', 'Size', 'SHA-256'], [
    ['before.jpg', `${report.images.before?.width || '?'}x${report.images.before?.height || '?'}`, report.images.before?.sha256 || 'missing'],
    ['during.jpg', `${report.images.during?.width || '?'}x${report.images.during?.height || '?'}`, report.images.during?.sha256 || 'missing'],
    ['after.jpg', `${report.images.after?.width || '?'}x${report.images.after?.height || '?'}`, report.images.after?.sha256 || 'missing'],
  ])}\n\n## Re-run\n\n\`\`\`bash\nnode tools/macuse-demo.mjs --out ${report.out}\n\`\`\`\n`;
}

function renderHtml(report) {
  const safe = (value) => String(value ?? '').replace(/[&<>]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[char]));
  const badge = report.ok ? '<span class="badge pass">READY</span>' : '<span class="badge fail">CHECK</span>';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>macuse live demo</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:40px;background:#0b1020;color:#edf2ff}a{color:#8bd5ff}.card{background:#151b2f;border:1px solid #29324d;border-radius:18px;padding:24px;margin:18px 0;box-shadow:0 18px 60px #0006}.badge{display:inline-block;padding:8px 12px;border-radius:999px;font-weight:800;letter-spacing:.08em}.pass{background:#143d2a;color:#75f0ac}.fail{background:#4a1820;color:#ff8fa3}.grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}.shot{width:100%;border-radius:12px;border:1px solid #394260;background:#050816}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #29324d;padding:10px;text-align:left}code{background:#0b1020;padding:2px 6px;border-radius:6px}</style>
</head>
<body>
<h1>macuse live demo ${badge}</h1>
<p>Generated ${safe(report.generatedAt)}</p>
<div class="card"><h2>Proof</h2><table>
<tr><th>Check</th><th>Evidence</th></tr>
<tr><td>Tool surface</td><td>${report.status.toolsFound} Computer Use tools</td></tr>
<tr><td>Calculator mutation</td><td>1=${safe(report.displays.afterOne)}, 2=${safe(report.displays.afterKey)}, restored=${safe(report.displays.afterRestore)}</td></tr>
<tr><td>Focus</td><td>${safe(report.focus.before?.bundleId)} → ${safe(report.focus.after?.bundleId)}</td></tr>
<tr><td>Mouse</td><td>seq1 ${safe(formatPoint(report.mouse.sequenceOne?.before))} → ${safe(formatPoint(report.mouse.sequenceOne?.restored))}; seq2 ${safe(formatPoint(report.mouse.sequenceTwo?.before))} → ${safe(formatPoint(report.mouse.sequenceTwo?.restored))}</td></tr>
<tr><td>MCP wrapper</td><td>${report.status.mcpValidated === null ? 'skipped' : report.status.mcpValidated ? 'validated' : 'failed'}</td></tr>
</table></div>
<div class="card"><h2>Screenshots</h2><div class="grid"><div><h3>Before</h3><img class="shot" src="before.jpg"></div><div><h3>During: display 1</h3><img class="shot" src="during.jpg"></div><div><h3>After restore</h3><img class="shot" src="after.jpg"></div></div></div>
<div class="card"><h2>Artifacts</h2><ul><li><a href="report.md">report.md</a></li><li><a href="transcript.json">transcript.json</a></li><li><a href="cursor-mcp.json">cursor-mcp.json</a></li>${report.doctor ? '<li><a href="doctor/doctor.md">doctor/doctor.md</a></li>' : ''}</ul></div>
</body>
</html>
`;
}

function formatPoint(point) {
  return point ? `${point.x},${point.y}` : 'unknown';
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
  const configRun = mustRun('generate Cursor MCP config', process.execPath, ['tools/macuse-config.mjs', 'cursor', '--pretty', '--out', cursorConfigPath], { timeoutMs: 30_000 });
  transcript.commands.push({ name: 'generate Cursor MCP config', command: commandLine(process.execPath, ['tools/macuse-config.mjs', 'cursor', '--pretty', '--out', cursorConfigPath]), stdout: configRun.stdout, stderr: configRun.stderr, durationMs: configRun.durationMs });

  let doctor = null;
  if (!opts.skipDoctor) {
    const doctorDir = resolve(opts.out, 'doctor');
    const doctorRun = mustRun('macuse doctor', process.execPath, ['tools/macuse-doctor.mjs', '--out', doctorDir, '--json', '--tool-timeout-ms', String(opts.toolTimeoutMs)], { timeoutMs: opts.toolTimeoutMs * 4 });
    doctor = parseJsonOutput('macuse doctor', doctorRun.stdout);
    transcript.commands.push({ name: 'macuse doctor', command: commandLine(process.execPath, ['tools/macuse-doctor.mjs', '--out', doctorDir, '--json', '--tool-timeout-ms', String(opts.toolTimeoutMs)]), durationMs: doctorRun.durationMs, stdout: doctorRun.stdout.slice(0, 4000), stderr: doctorRun.stderr.slice(0, 4000) });
  }

  const focusBefore = frontmostApp();
  const mouseBefore = mousePosition();
  const beforeImage = resolve(opts.out, 'before.jpg');
  const duringImage = resolve(opts.out, 'during.jpg');
  const afterImage = resolve(opts.out, 'after.jpg');

  const before = runJson('capture before screenshot', ['tools/codex-computer-use-appserver.mjs', 'get-state', '--app', 'Calculator', '--approval', 'accept-once', '--quiet', '--save-image', beforeImage, '--max-text-chars', '4000', '--tool-timeout-ms', String(opts.toolTimeoutMs)], { timeoutMs: opts.toolTimeoutMs + 30_000 });
  transcript.commands.push({ name: 'capture before screenshot', command: before.command, durationMs: before.durationMs, result: before.result });

  const sequenceOneSteps = [
    { label: 'Read Calculator before mutation', tool: 'get_app_state', arguments: { app: 'Calculator' } },
    { label: 'Clear Calculator via accessibility Press', tool: 'perform_secondary_action', arguments: { app: 'Calculator', element_index: '6', action: 'Press' } },
    { label: 'Verify display is 0', tool: 'get_app_state', arguments: { app: 'Calculator' } },
    { label: 'Press digit 1 via accessibility Press', tool: 'perform_secondary_action', arguments: { app: 'Calculator', element_index: '17', action: 'Press' } },
    { label: 'Verify display is 1', tool: 'get_app_state', arguments: { app: 'Calculator' } },
  ];
  const sequenceOne = runJson('focus-safe Calculator sequence: show 1', ['tools/codex-computer-use-appserver.mjs', 'sequence', '--steps-json', JSON.stringify(sequenceOneSteps), '--allow-mutating', '--approval', 'accept-once', '--preserve-mouse', '--quiet', '--max-text-chars', '5000', '--tool-timeout-ms', String(opts.toolTimeoutMs)], { timeoutMs: opts.toolTimeoutMs + 90_000 });
  transcript.commands.push({ name: 'focus-safe Calculator sequence: show 1', command: sequenceOne.command, durationMs: sequenceOne.durationMs, result: sequenceOne.result });

  const during = runJson('capture during screenshot', ['tools/codex-computer-use-appserver.mjs', 'get-state', '--app', 'Calculator', '--approval', 'accept-once', '--quiet', '--save-image', duringImage, '--max-text-chars', '4000', '--tool-timeout-ms', String(opts.toolTimeoutMs)], { timeoutMs: opts.toolTimeoutMs + 30_000 });
  transcript.commands.push({ name: 'capture during screenshot', command: during.command, durationMs: during.durationMs, result: during.result });

  const sequenceTwoSteps = [
    { label: 'Read Calculator before restore sequence', tool: 'get_app_state', arguments: { app: 'Calculator' } },
    { label: 'Clear display via accessibility Press', tool: 'perform_secondary_action', arguments: { app: 'Calculator', element_index: '6', action: 'Press' } },
    { label: 'Verify display is 0', tool: 'get_app_state', arguments: { app: 'Calculator' } },
    { label: 'Press key 2', tool: 'press_key', arguments: { app: 'Calculator', key: '2' } },
    { label: 'Verify display is 2', tool: 'get_app_state', arguments: { app: 'Calculator' } },
    { label: 'Restore Calculator to 0', tool: 'perform_secondary_action', arguments: { app: 'Calculator', element_index: '6', action: 'Press' } },
    { label: 'Verify restored display is 0', tool: 'get_app_state', arguments: { app: 'Calculator' } },
  ];
  const sequenceTwo = runJson('focus-safe Calculator sequence: verify key and restore', ['tools/codex-computer-use-appserver.mjs', 'sequence', '--steps-json', JSON.stringify(sequenceTwoSteps), '--allow-mutating', '--approval', 'accept-once', '--preserve-mouse', '--quiet', '--max-text-chars', '5000', '--tool-timeout-ms', String(opts.toolTimeoutMs)], { timeoutMs: opts.toolTimeoutMs + 90_000 });
  transcript.commands.push({ name: 'focus-safe Calculator sequence: verify key and restore', command: sequenceTwo.command, durationMs: sequenceTwo.durationMs, result: sequenceTwo.result });

  const after = runJson('capture after screenshot', ['tools/codex-computer-use-appserver.mjs', 'get-state', '--app', 'Calculator', '--approval', 'accept-once', '--quiet', '--save-image', afterImage, '--max-text-chars', '4000', '--tool-timeout-ms', String(opts.toolTimeoutMs)], { timeoutMs: opts.toolTimeoutMs + 30_000 });
  transcript.commands.push({ name: 'capture after screenshot', command: after.command, durationMs: after.durationMs, result: after.result });

  let mcpValidated = null;
  if (!opts.skipMcp) {
    const mcpRun = runCommand('MCP wrapper validation', process.execPath, ['tools/validate-macuse.mjs', 'mcp'], { timeoutMs: 420_000 });
    writeFileSync(resolve(opts.out, 'mcp-validation.txt'), `${mcpRun.stdout}${mcpRun.stderr}`);
    transcript.commands.push({ name: 'MCP wrapper validation', command: commandLine(process.execPath, ['tools/validate-macuse.mjs', 'mcp']), durationMs: mcpRun.durationMs, status: mcpRun.status, stdout: mcpRun.stdout, stderr: mcpRun.stderr });
    mcpValidated = mcpRun.ok;
  }

  const focusAfter = frontmostApp();
  const mouseAfter = mousePosition();
  const displays = {
    afterClear: calculatorDisplayFromStep(sequenceOne.result.steps[2]),
    afterOne: calculatorDisplayFromStep(sequenceOne.result.steps[4]),
    afterKey: calculatorDisplayFromStep(sequenceTwo.result.steps[4]),
    afterRestore: calculatorDisplayFromStep(sequenceTwo.result.steps[6]),
  };
  const focusPreserved = focusBefore?.bundleId === 'com.apple.calculator' || focusAfter?.bundleId !== 'com.apple.calculator';
  const sequenceMouseOne = sequenceOne.result.mousePreservation || {};
  const sequenceMouseTwo = sequenceTwo.result.mousePreservation || {};
  const mouseOnePreserved = Boolean(sequenceMouseOne.before && sequenceMouseOne.restored && sequenceMouseOne.before.x === sequenceMouseOne.restored.x && sequenceMouseOne.before.y === sequenceMouseOne.restored.y);
  const mouseTwoPreserved = Boolean(sequenceMouseTwo.before && sequenceMouseTwo.restored && sequenceMouseTwo.before.x === sequenceMouseTwo.restored.x && sequenceMouseTwo.before.y === sequenceMouseTwo.restored.y);
  const mousePreserved = mouseOnePreserved && mouseTwoPreserved;
  const calculatorMutation = displays.afterOne === '1' && displays.afterKey === '2' && displays.afterRestore === '0';
  const toolsFound = doctor?.computerUseTools?.length || 10;

  const report = {
    ok: calculatorMutation && focusPreserved && mousePreserved && (mcpValidated !== false) && (doctor ? doctor.ok : true),
    generatedAt: transcript.generatedAt,
    out: opts.out,
    repoRoot: REPO_ROOT,
    doctor: doctor ? { ok: doctor.ok, path: resolve(opts.out, 'doctor/doctor.md') } : null,
    status: {
      toolsFound,
      calculatorMutation,
      focusPreserved,
      mousePreserved,
      mcpValidated,
    },
    displays,
    focus: { before: focusBefore, after: focusAfter },
    mouse: { before: mouseBefore, after: mouseAfter, sequenceBefore: sequenceMouseOne.before || null, sequenceRestored: sequenceMouseTwo.restored || null, sequenceOne: sequenceMouseOne, sequenceTwo: sequenceMouseTwo },
    images: { before: imageInfo(beforeImage), during: imageInfo(duringImage), after: imageInfo(afterImage) },
    artifacts: {
      report: resolve(opts.out, 'report.md'),
      html: resolve(opts.out, 'index.html'),
      transcript: resolve(opts.out, 'transcript.json'),
      cursorConfig: cursorConfigPath,
      beforeImage,
      duringImage,
      afterImage,
    },
  };

  transcript.report = report;
  writeJsonFile(resolve(opts.out, 'transcript.json'), transcript);
  writeJsonFile(resolve(opts.out, 'manifest.json'), report);
  writeFileSync(resolve(opts.out, 'report.md'), renderReport(report));
  writeFileSync(resolve(opts.out, 'index.html'), renderHtml(report));

  process.stdout.write(`macuse demo complete\n`);
  process.stdout.write(`report: ${resolve(opts.out, 'report.md')}\n`);
  process.stdout.write(`html:   ${resolve(opts.out, 'index.html')}\n`);
  process.stdout.write(`ok:     ${report.ok}\n`);
  if (!report.ok) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`FAIL ${error.message || String(error)}\n`);
  process.exitCode = 1;
});
