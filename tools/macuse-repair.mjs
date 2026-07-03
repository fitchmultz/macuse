#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  DEFAULT_COMPUTER_USE_APP,
  REPO_ROOT,
  VERSION,
  commandLine,
  ensureDir,
  runCommand,
  writeJsonFile,
} from './macuse-utils.mjs';

const REGISTRY_DIR = '/tmp/macuse-appserver';
const USER_TCC_DB = `${process.env.HOME}/Library/Application Support/com.apple.TCC/TCC.db`;
const SERVICE_PATH = `${DEFAULT_COMPUTER_USE_APP}/Contents/MacOS/SkyComputerUseService`;
const CLIENT_PATH = `${DEFAULT_COMPUTER_USE_APP}/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient`;
const SERVICE_BUNDLE_ID = 'com.openai.sky.CUAService';
const CLIENT_BUNDLE_ID = 'com.openai.sky.CUAService.cli';

function help() {
  process.stdout.write(`macuse repair ${VERSION}\n\nUsage:\n  node tools/macuse-repair.mjs [options]\n\nDefault mode is dry-run. Pass --apply to make safe local repairs.\n\nOptions:\n  --apply                         Perform safe repairs: wake display, stop screensaver, reap stale registry files.\n  --restart-appserver             With --apply, stop macuse-owned codex app-server processes from registry records.
  --restart-service               With --apply, stop global SkyComputerUseService and SkyComputerUseClient mcp helpers.\n  --unlock-with-env <VAR>         With --apply, unlock the console using a password stored in environment variable VAR.\n                                  Uses a temporary local Swift HID-event helper; the password is not placed in argv.\n  --repair-tcc                    With --apply, add user TCC AppleEvents grants for the responsible launcher to control ${SERVICE_BUNDLE_ID}.\n  --responsible <path|auto>       Responsible launcher for --repair-tcc. Default auto. SSH sessions map to /usr/libexec/sshd-keygen-wrapper.\n  --restart-tccd                  With --apply and --sudo-password-env, restart tccd after TCC repair.\n  --sudo-password-env <VAR>       Environment variable containing sudo password for --restart-tccd.\n  --out <path>                    Write machine-readable report JSON.\n  --json                          Print JSON instead of Markdown.\n  -h, --help                      Show this help.\n\nExamples:\n  node tools/macuse-repair.mjs\n  node tools/macuse-repair.mjs --apply\n  node tools/macuse-repair.mjs --apply --restart-appserver
  node tools/macuse-repair.mjs --apply --restart-service\n  node tools/macuse-repair.mjs --apply --unlock-with-env MACUSE_UNLOCK_PASSWORD\n  node tools/macuse-repair.mjs --apply --repair-tcc --responsible auto --restart-tccd --sudo-password-env MACUSE_SUDO_PASSWORD\n\nSafety:\n  --repair-tcc edits only the current user's TCC database and writes a timestamped backup first.\n  --restart-appserver stops macuse-owned app-server records only. --restart-service is separate and broader.\n  No sends, deletes, purchases, installs, or account/security/privacy UI changes are performed.\n`);
}

function parse(argv) {
  if (argv.includes('-h') || argv.includes('--help')) return { help: true };
  const opts = {
    apply: false,
    restartAppserver: false,
    restartService: false,
    unlockEnv: null,
    repairTcc: false,
    responsible: 'auto',
    restartTccd: false,
    sudoPasswordEnv: null,
    out: null,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`${token} requires a value`);
      return argv[i];
    };
    if (token === '--apply') opts.apply = true;
    else if (token === '--restart-appserver') opts.restartAppserver = true;
    else if (token === '--restart-service') opts.restartService = true;
    else if (token === '--unlock-with-env') opts.unlockEnv = next();
    else if (token === '--repair-tcc') opts.repairTcc = true;
    else if (token === '--responsible') opts.responsible = next();
    else if (token === '--restart-tccd') opts.restartTccd = true;
    else if (token === '--sudo-password-env') opts.sudoPasswordEnv = next();
    else if (token === '--out') opts.out = resolve(next());
    else if (token === '--json') opts.json = true;
    else throw new Error(`unknown option: ${token}`);
  }
  return opts;
}

function add(report, status, name, summary, details = null) {
  report.actions.push({ status, name, summary, details });
}

function pidExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function processStart(pid) {
  const result = runCommand('process start', 'ps', ['-p', String(pid), '-o', 'lstart='], { timeoutMs: 5000 });
  return result.ok ? result.stdout.trim() : '';
}

function processCommand(pid) {
  const result = runCommand('process command', 'ps', ['-p', String(pid), '-o', 'command='], { timeoutMs: 5000 });
  return result.ok ? result.stdout.trim() : '';
}

function registryRecords() {
  try {
    return readdirSync(REGISTRY_DIR)
      .filter((name) => name.startsWith('macuse-appserver-') && name.endsWith('.json'))
      .map((name) => {
        const path = join(REGISTRY_DIR, name);
        try {
          return { path, record: JSON.parse(readFileSync(path, 'utf8')) };
        } catch (error) {
          return { path, record: null, error: error.message };
        }
      });
  } catch {
    return [];
  }
}

function reapRegistry(report, apply) {
  for (const item of registryRecords()) {
    const { path, record } = item;
    if (!record) {
      if (apply) unlinkSync(path);
      add(report, apply ? 'fixed' : 'would-fix', 'registry malformed record', path, item.error);
      continue;
    }
    const ownerAlive = pidExists(record.ownerPid) && (!record.ownerStart || processStart(record.ownerPid) === record.ownerStart);
    const serverAlive = pidExists(record.appServerPid) && (!record.appServerStart || processStart(record.appServerPid) === record.appServerStart);
    if (!ownerAlive || !serverAlive) {
      if (apply) unlinkSync(path);
      add(report, apply ? 'fixed' : 'would-fix', 'registry stale record', path, { ownerAlive, serverAlive, record });
    } else {
      add(report, 'ok', 'registry live record', path, { ownerPid: record.ownerPid, appServerPid: record.appServerPid });
    }
  }
}

function stopMacuseAppservers(report, apply) {
  const targets = [];
  for (const { record } of registryRecords()) {
    if (!record?.appServerPid || !pidExists(record.appServerPid)) continue;
    const cmd = processCommand(record.appServerPid);
    if (cmd.includes('codex app-server') && cmd.includes('--enable computer_use')) targets.push({ pid: record.appServerPid, cmd });
  }
  if (targets.length === 0) {
    add(report, 'ok', 'macuse app-server restart', 'no live macuse-owned app-server registry entries to stop');
    return;
  }
  if (!apply) {
    add(report, 'would-fix', 'macuse app-server restart', `would stop ${targets.length} app-server process(es)`, targets);
    return;
  }
  for (const target of targets) {
    try { process.kill(target.pid, 'SIGTERM'); } catch {}
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
  for (const target of targets) {
    if (pidExists(target.pid)) {
      try { process.kill(target.pid, 'SIGKILL'); } catch {}
    }
  }
  add(report, 'fixed', 'macuse app-server restart', `stopped ${targets.length} macuse-owned app-server process(es)`, targets);
}

function stopComputerUseService(report, apply) {
  const ps = runCommand('process list', 'ps', ['-axo', 'pid=,command='], { timeoutMs: 10_000 });
  const targets = [];
  for (const line of ps.stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [pidText, ...rest] = trimmed.split(/\s+/);
    const pid = Number(pidText);
    const cmd = rest.join(' ');
    if (!Number.isInteger(pid) || pid === process.pid) continue;
    if (cmd === SERVICE_PATH || cmd.endsWith('SkyComputerUseClient mcp')) targets.push({ pid, cmd });
  }
  if (targets.length === 0) {
    add(report, 'ok', 'Computer Use service restart', 'no SkyComputerUseService or SkyComputerUseClient mcp helpers found');
    return;
  }
  if (!apply) {
    add(report, 'would-fix', 'Computer Use service restart', `would stop ${targets.length} Computer Use service/helper process(es)`, targets);
    return;
  }
  for (const target of targets) {
    try { process.kill(target.pid, 'SIGTERM'); } catch {}
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
  for (const target of targets) {
    if (pidExists(target.pid)) {
      try { process.kill(target.pid, 'SIGKILL'); } catch {}
    }
  }
  add(report, 'fixed', 'Computer Use service restart', `stopped ${targets.length} Computer Use service/helper process(es)`, targets);
}

function wakeAndStopScreensaver(report, apply) {
  const screensavers = runCommand('screensaver pgrep', 'pgrep', ['-fl', 'ScreenSaver.Engine|ScreenSaverEngine'], { timeoutMs: 5000 });
  if (!apply) {
    add(report, screensavers.stdout.trim() ? 'would-fix' : 'ok', 'wake display / stop screensaver', screensavers.stdout.trim() ? 'would wake display and stop ScreenSaver.Engine' : 'no ScreenSaver.Engine process detected');
    return;
  }
  runCommand('caffeinate wake', '/usr/bin/caffeinate', ['-u', '-t', '3'], { timeoutMs: 5000 });
  runCommand('stop ScreenSaverEngine', '/usr/bin/killall', ['ScreenSaverEngine'], { timeoutMs: 5000 });
  runCommand('stop ScreenSaver.Engine', '/usr/bin/killall', ['ScreenSaver.Engine'], { timeoutMs: 5000 });
  add(report, 'fixed', 'wake display / stop screensaver', 'sent user-activity wake and stopped ScreenSaver.Engine if present');
}

function unlockConsole(report, apply, envName) {
  if (!envName) return;
  if (!process.env[envName]) throw new Error(`--unlock-with-env ${envName} was set, but ${envName} is empty`);
  if (!apply) {
    add(report, 'would-fix', 'unlock console', `would run temporary HID unlock helper using ${envName}`);
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'macuse-unlock-'));
  const source = join(dir, 'unlock.swift');
  const bin = join(dir, 'unlock');
  writeFileSync(source, `import CoreGraphics\nimport Foundation\nimport IOKit.pwr_mgt\nfunc wake(){var id: IOPMAssertionID = 0; _ = IOPMAssertionDeclareUserActivity("macuse repair" as CFString, kIOPMUserActiveLocal, &id)}\nfunc key(_ k: CGKeyCode){let s=CGEventSource(stateID:.hidSystemState); CGEvent(keyboardEventSource:s, virtualKey:k, keyDown:true)?.post(tap:.cghidEventTap); CGEvent(keyboardEventSource:s, virtualKey:k, keyDown:false)?.post(tap:.cghidEventTap)}\nfunc type(_ t:String){let s=CGEventSource(stateID:.hidSystemState); let c=Array(t.utf16); var i=0; while i<c.count{let l=min(20,c.count-i); var chunk=Array(c[i..<(i+l)]); if let e=CGEvent(keyboardEventSource:s, virtualKey:49, keyDown:true){chunk.withUnsafeMutableBufferPointer{e.keyboardSetUnicodeString(stringLength:l, unicodeString:$0.baseAddress!)}; e.post(tap:.cghidEventTap)}; CGEvent(keyboardEventSource:s, virtualKey:49, keyDown:false)?.post(tap:.cghidEventTap); usleep(80000); i += l}}\nguard let p=ProcessInfo.processInfo.environment["MACUSE_UNLOCK_PASSWORD"], p.count > 1 else { exit(2) }\nwake(); usleep(700000); key(49); usleep(700000); type(p); usleep(200000); key(52); usleep(2000000)\n`);
  const compile = runCommand('compile unlock helper', 'swiftc', [source, '-o', bin], { timeoutMs: 60_000 });
  if (!compile.ok) throw new Error(`failed to compile unlock helper: ${compile.stderr || compile.stdout || compile.error}`);
  const run = runCommand('run unlock helper', bin, [], { timeoutMs: 20_000, env: { MACUSE_UNLOCK_PASSWORD: process.env[envName] } });
  rmSync(dir, { recursive: true, force: true });
  add(report, run.ok ? 'fixed' : 'fail', 'unlock console', run.ok ? 'temporary HID unlock helper completed' : (run.stderr || run.stdout || run.error || `exit ${run.status}`));
}

function sqlQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function requirementHex(path, dir) {
  if (!existsSync(path)) throw new Error(`code object does not exist: ${path}`);
  const codesign = spawnSync('/usr/bin/codesign', ['-dr', '-', path], { encoding: 'utf8' });
  const text = `${codesign.stdout || ''}\n${codesign.stderr || ''}`;
  const requirement = text.split('\n').find((line) => line.startsWith('designated => '))?.replace('designated => ', '');
  if (!requirement) throw new Error(`could not read designated requirement for ${path}: ${text.slice(0, 500)}`);
  const reqPath = join(dir, `${Buffer.from(path).toString('hex').slice(0, 16)}.req`);
  const outPath = join(dir, `${Buffer.from(path).toString('hex').slice(0, 16)}.csreq`);
  writeFileSync(reqPath, `${requirement}\n`);
  const csreq = runCommand('compile csreq', '/usr/bin/csreq', ['-r', reqPath, '-b', outPath], { timeoutMs: 20_000 });
  if (!csreq.ok) throw new Error(`csreq failed for ${path}: ${csreq.stderr || csreq.stdout || csreq.error}`);
  return readFileSync(outPath).toString('hex');
}

function sqliteValue(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return String(value);
  if (value && typeof value === 'object' && value.hex) return `x'${value.hex}'`;
  return sqlQuote(value);
}

function insertTccRowSql(columns, row) {
  const wanted = Object.entries(row).filter(([key]) => columns.includes(key));
  return `insert or replace into access (${wanted.map(([key]) => key).join(',')}) values (${wanted.map(([, value]) => sqliteValue(value)).join(',')});`;
}

function executableFromBundle(bundlePath) {
  const plist = `${bundlePath}/Contents/Info.plist`;
  const result = runCommand('bundle executable', '/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleExecutable', plist], { timeoutMs: 5000 });
  const executable = result.ok ? result.stdout.trim() : '';
  return executable ? `${bundlePath}/Contents/MacOS/${executable}` : null;
}

function appExecutableFromArgs(args) {
  const bundlePath = String(args || '').match(/(\/.*?\.app)(?:\/Contents\/MacOS(?:\/|\s|$)|\s|$)/)?.[1];
  return bundlePath && existsSync(bundlePath) ? executableFromBundle(bundlePath) : null;
}

function parentProcessInfo(pid) {
  const result = runCommand('parent process', 'ps', ['-p', String(pid), '-o', 'ppid=', '-o', 'args='], { timeoutMs: 5000 });
  if (!result.ok) return null;
  const match = result.stdout.trim().match(/^(\d+)\s+([\s\S]+)$/);
  if (!match) return null;
  return { ppid: Number(match[1]), args: match[2] };
}

function responsibleFromProcessTree(startPid = process.ppid) {
  let pid = startPid;
  for (let depth = 0; Number.isInteger(pid) && pid > 1 && depth < 20; depth += 1) {
    const info = parentProcessInfo(pid);
    if (!info) return null;
    const appExecutable = appExecutableFromArgs(info.args);
    if (appExecutable && existsSync(appExecutable)) return appExecutable;
    pid = info.ppid;
  }
  return null;
}

function autoResponsiblePath() {
  if (process.env.SSH_CONNECTION || process.env.SSH_TTY) return '/usr/libexec/sshd-keygen-wrapper';
  return responsibleFromProcessTree();
}

function repairTcc(report, apply, opts) {
  if (!opts.repairTcc) return;
  const responsible = opts.responsible === 'auto' ? autoResponsiblePath() : opts.responsible;
  if (!responsible) throw new Error('could not auto-detect responsible launcher; pass --responsible <path>');
  if (!existsSync(USER_TCC_DB)) throw new Error(`user TCC DB not found: ${USER_TCC_DB}`);
  if (!apply) {
    add(report, 'would-fix', 'TCC AppleEvents repair', `would add ${responsible} and ${CLIENT_BUNDLE_ID} -> ${SERVICE_BUNDLE_ID} to ${USER_TCC_DB}`);
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'macuse-tcc-'));
  const now = Math.floor(Date.now() / 1000);
  const backup = `${USER_TCC_DB}.macuse-repair-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  copyFileSync(USER_TCC_DB, backup);
  const serviceHex = requirementHex(SERVICE_PATH, dir);
  const responsibleHex = requirementHex(responsible, dir);
  const clientHex = existsSync(CLIENT_PATH) ? requirementHex(CLIENT_PATH, dir) : null;
  const colsResult = runCommand('sqlite columns', '/usr/bin/sqlite3', [USER_TCC_DB, 'pragma table_info(access);'], { timeoutMs: 10_000 });
  if (!colsResult.ok) throw new Error(`could not inspect TCC schema: ${colsResult.stderr || colsResult.stdout || colsResult.error}`);
  const columns = colsResult.stdout.split('\n').map((line) => line.split('|')[1]).filter(Boolean);
  const base = {
    service: 'kTCCServiceAppleEvents',
    auth_value: 2,
    auth_reason: 3,
    auth_version: 1,
    policy_id: null,
    indirect_object_identifier_type: 0,
    indirect_object_identifier: SERVICE_BUNDLE_ID,
    indirect_object_code_identity: { hex: serviceHex },
    flags: 0,
    last_modified: now,
    pid: null,
    pid_version: null,
    boot_uuid: 'UNUSED',
    last_reminded: now,
  };
  const sql = [
    insertTccRowSql(columns, { ...base, client: responsible, client_type: 1, csreq: { hex: responsibleHex } }),
    clientHex ? insertTccRowSql(columns, { ...base, client: CLIENT_BUNDLE_ID, client_type: 0, csreq: { hex: clientHex } }) : '',
  ].filter(Boolean).join('\n');
  const sqlite = runCommand('sqlite TCC repair', '/usr/bin/sqlite3', [USER_TCC_DB, sql], { timeoutMs: 20_000 });
  rmSync(dir, { recursive: true, force: true });
  if (!sqlite.ok) throw new Error(`TCC sqlite repair failed: ${sqlite.stderr || sqlite.stdout || sqlite.error}`);
  add(report, 'fixed', 'TCC AppleEvents repair', `added AppleEvents grants for ${responsible} and ${CLIENT_BUNDLE_ID} to ${SERVICE_BUNDLE_ID}`, { backup, userTccDb: USER_TCC_DB });
}

function restartTccd(report, apply, opts) {
  if (!opts.restartTccd) return;
  if (!opts.sudoPasswordEnv || !process.env[opts.sudoPasswordEnv]) throw new Error('--restart-tccd requires --sudo-password-env <VAR> with a non-empty value');
  if (!apply) {
    add(report, 'would-fix', 'restart tccd', `would run sudo killall tccd using ${opts.sudoPasswordEnv}`);
    return;
  }
  const run = runCommand('restart tccd', '/usr/bin/sudo', ['-S', '-p', '', '/usr/bin/killall', 'tccd'], { input: `${process.env[opts.sudoPasswordEnv]}\n`, timeoutMs: 20_000 });
  add(report, run.ok || run.status === 1 ? 'fixed' : 'fail', 'restart tccd', run.ok || run.status === 1 ? 'sent tccd restart request' : (run.stderr || run.stdout || run.error || `exit ${run.status}`));
}

function renderMarkdown(report) {
  const rows = report.actions.map((action) => `| ${action.status} | ${action.name} | ${String(action.summary).replaceAll('|', '\\|')} |`).join('\n');
  return `# macuse repair report\n\nGenerated: ${report.generatedAt}\nMode: ${report.apply ? 'apply' : 'dry-run'}\nRepo: ${REPO_ROOT}\n\n| Status | Action | Summary |\n| --- | --- | --- |\n${rows || '| ok | no-op | no actions requested |'}\n\nRun doctor after repair:\n\n\`\`\`bash\nnode tools/macuse-doctor.mjs --out .scratch/doctor\n\`\`\`\n`;
}

async function main() {
  const opts = parse(process.argv.slice(2));
  if (opts.help) {
    help();
    return;
  }
  const report = { ok: false, generatedAt: new Date().toISOString(), apply: opts.apply, options: { ...opts, sudoPasswordEnv: opts.sudoPasswordEnv || null, unlockEnv: opts.unlockEnv || null }, actions: [] };
  wakeAndStopScreensaver(report, opts.apply);
  reapRegistry(report, opts.apply);
  if (opts.restartAppserver) stopMacuseAppservers(report, opts.apply);
  if (opts.restartService) stopComputerUseService(report, opts.apply);
  unlockConsole(report, opts.apply, opts.unlockEnv);
  repairTcc(report, opts.apply, opts);
  restartTccd(report, opts.apply, opts);
  report.ok = report.actions.every((action) => action.status !== 'fail');
  if (opts.out) {
    ensureDir(dirname(opts.out));
    writeJsonFile(opts.out, report);
  }
  if (opts.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else process.stdout.write(renderMarkdown(report));
  if (!report.ok) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`FAIL ${error.message || String(error)}\n`);
  process.exitCode = 1;
});
