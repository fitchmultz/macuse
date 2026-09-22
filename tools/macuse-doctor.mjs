#!/usr/bin/env node
import { existsSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { REPO_ROOT, VERSION, ensureDir, markdownTable, parseJsonOutput, runCommand, writeJsonFile } from './macuse-utils.mjs';

function commandCheck(name, command, args, options = {}) {
  const result = runCommand(name, command, args, options);
  return { result, check: { name, status: result.ok ? 'pass' : 'fail', summary: result.ok ? result.stdout.trim().slice(0, 500) : (result.error || result.stderr || result.stdout || `exit ${result.status}`).trim().slice(0, 500), durationMs: result.durationMs } };
}

// Read-only: no permission request, activation, or settings changes.
export function nativeRequirementChecks() {
  if (process.platform !== 'darwin') return [{ status: 'fail', name: 'Native Accessibility helper', summary: 'Native Accessibility requires macOS.' }];
  const compiler = commandCheck('Native helper Swift compiler', '/usr/bin/xcrun', ['--find', 'swiftc'], { timeoutMs: 10000 });
  const checks = [{ ...compiler.check, summary: compiler.result.ok ? `swiftc: ${compiler.result.stdout.trim()}` : `Native helper compiler unavailable: ${compiler.check.summary}` }];
  if (!compiler.result.ok) return [...checks, { status: 'warn', name: 'Native helper Accessibility trust', summary: 'Unknown: compiler unavailable; native helper trust was not checked.' }];
  const probe = `import { MacOSNative } from ${JSON.stringify(new URL('./macos-native.mjs', import.meta.url).href)};
const native = new MacOSNative();
try { const state = await native.inspectApp(process.pid); console.log(JSON.stringify({ accessibilityTrusted: state.accessibilityTrusted })); }
finally { await native.stop(); }`;
  const trust = commandCheck('Native helper Accessibility trust', process.execPath, ['--input-type=module', '-e', probe], { timeoutMs: 60000 });
  if (!trust.result.ok) checks.push({ ...trust.check, summary: `Native helper unavailable; Accessibility trust unknown: ${trust.check.summary}` });
  else {
    let trusted;
    try { trusted = parseJsonOutput('native helper trust', trust.result.stdout).accessibilityTrusted; } catch { /* Unknown remains unknown. */ }
    checks.push({ ...trust.check, status: trusted === true ? 'pass' : 'fail', summary: trusted === true
      ? 'accessibilityTrusted=true under this launcher. Other Pi/CLI/MCP hosts may have different grants.'
      : trusted === false ? 'accessibilityTrusted=false: AX inspection/insertion unavailable. No permission prompt was requested.' : 'Native helper trust is unknown.' });
  }
  return checks;
}

async function main() {
  const { values } = parseArgs({ options: { out: { type: 'string' }, json: { type: 'boolean' }, full: { type: 'boolean' }, app: { type: 'string', default: 'Activity Monitor' }, 'tool-timeout-ms': { type: 'string', default: '90000' }, help: { type: 'boolean', short: 'h' } } });
  if (values.help) { console.log(`macuse doctor ${VERSION}\n\n--out <dir> --json --app <name> --tool-timeout-ms <ms>\nDefault checks are read-only. --full also switches/restores Activity Monitor tabs and checks the MCP wrapper.\nNo installs, privacy changes, recording starts, or permission prompts.`); return; }
  const checks = nativeRequirementChecks();
  const validation = commandCheck('Native runtime and app observation', process.execPath, ['tools/validate-macuse.mjs', 'read-only', '--json', '--app', values.app, '--tool-timeout-ms', values['tool-timeout-ms']], { timeoutMs: 300000 });
  checks.push({ ...validation.check, summary: validation.result.ok ? 'Persistent native JavaScript, computer-only inventory, app state and screenshot passed.' : validation.check.summary });
  let runtime;
  if (validation.result.ok) runtime = parseJsonOutput('runtime validation', validation.result.stdout);
  // Optional recording/history services never gate ordinary Computer Use readiness.
  const auxiliary = commandCheck('Recording/history status', process.execPath, ['tools/macuse.mjs', 'call', 'computer_history_status', '{}'], { timeoutMs: 120000 });
  checks.push({ ...auxiliary.check, status: auxiliary.result.ok ? 'pass' : 'warn', summary: auxiliary.result.ok ? 'Read-only Computer History status returned through its separate authenticated transport.' : `Auxiliary service unavailable: ${auxiliary.check.summary}` });
  if (values.full) for (const mode of ['focus', 'mcp']) {
    const check = commandCheck(`${mode} validation`, process.execPath, ['tools/validate-macuse.mjs', mode, '--json'], { timeoutMs: 420000 });
    checks.push({ ...check.check, summary: check.result.ok ? 'Passed; see command output for scoped evidence.' : check.check.summary });
  }
  const report = { ok: checks.every(c => c.status !== 'fail'), version: VERSION, generatedAt: new Date().toISOString(), repoRoot: REPO_ROOT, full: Boolean(values.full), checks, runtime };
  const markdown = `# macuse doctor\n\n${report.ok ? 'Checks passed.' : 'Attention required.'} These checks do not certify every app or guarantee uninterrupted input.\n\n${markdownTable(['Status', 'Check', 'Result'], checks.map(c => [c.status, c.name, c.summary]))}\n`;
  if (values.out) {
    ensureDir(values.out);
    writeJsonFile(resolve(values.out, 'doctor.json'), report);
    writeFileSync(resolve(values.out, 'doctor.md'), markdown);
  }
  console.log(values.json ? JSON.stringify(report, null, 2) : markdown);
  if (!report.ok) process.exitCode = 1;
}
if (process.argv[1] && existsSync(process.argv[1]) && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) main().catch(error => { console.error(error.message); process.exitCode = 1; });
