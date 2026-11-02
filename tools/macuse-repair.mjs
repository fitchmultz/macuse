#!/usr/bin/env node
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  DEFAULT_COMPUTER_USE_APP,
  REPO_ROOT,
  VERSION,
  firstText,
  ensureDir,
  runCommand,
  writeJsonFile,
} from "./macuse-utils.mjs";

const REGISTRY_DIR = "/tmp/macuse-appserver";
const USER_TCC_DB = `${String(process.env.HOME)}/Library/Application Support/com.apple.TCC/TCC.db`;
const SERVICE_PATH = `${DEFAULT_COMPUTER_USE_APP}/Contents/MacOS/SkyComputerUseService`;
const CLIENT_PATH = `${DEFAULT_COMPUTER_USE_APP}/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient`;
const SERVICE_BUNDLE_ID = "com.openai.sky.CUAService";
const CLIENT_BUNDLE_ID = "com.openai.sky.CUAService.cli";

/** @typedef {{ help: boolean, apply: boolean, restartAppserver: boolean, restartService: boolean, unlockEnv: string | null, repairTcc: boolean, responsible: string, restartTccd: boolean, sudoPasswordEnv: string | null, out: string | null, json: boolean }} RepairOptions */

/** @typedef {{ status: string, name: string, summary: string, details: unknown }} RepairAction */
/** @typedef {{ ok: boolean, generatedAt: string, apply: boolean, options: Record<string, unknown>, actions: RepairAction[] }} RepairReport */

/**
 * Registry files are written by macuse itself, but they persist across
 * versions, so every read is validated before use.
 * @typedef {{ ownerPid: number, ownerStart?: string | null, appServerPid: number, appServerStart?: string | null }} RegistryRecord
 * @typedef {{ path: string, record: RegistryRecord | null, error?: string }} RegistryItem
 */

function help() {
  process.stdout
    .write(`macuse repair ${VERSION}\n\nUsage:\n  node tools/macuse-repair.mjs [options]\n\nDefault mode is dry-run. Pass --apply to make safe local repairs.\n\nOptions:\n  --apply                         Perform safe repairs: wake display, stop screensaver, reap stale registry files.\n  --restart-appserver             With --apply, stop macuse-owned codex app-server processes from registry records.\n  --restart-service               With --apply, stop global SkyComputerUseService and SkyComputerUseClient mcp helpers.\n  --unlock-with-env <VAR>         With --apply, unlock the console using a password stored in environment variable VAR.\n                                  Uses a temporary local Swift HID-event helper; the password is not placed in argv.\n  --repair-tcc                    With --apply, add user TCC AppleEvents grants for the responsible launcher to control ${SERVICE_BUNDLE_ID}.\n  --responsible <path|auto>       Responsible launcher for --repair-tcc. Default auto. SSH sessions map to /usr/libexec/sshd-keygen-wrapper.\n  --restart-tccd                  With --apply and --sudo-password-env, restart tccd after TCC repair.\n  --sudo-password-env <VAR>       Environment variable containing sudo password for --restart-tccd.\n  --out <path>                    Write machine-readable report JSON.\n  --json                          Print JSON instead of Markdown.\n  -h, --help                      Show this help.\n\nExamples:\n  node tools/macuse-repair.mjs\n  node tools/macuse-repair.mjs --apply\n  node tools/macuse-repair.mjs --apply --restart-appserver
  node tools/macuse-repair.mjs --apply --restart-service\n  node tools/macuse-repair.mjs --apply --unlock-with-env MACUSE_UNLOCK_PASSWORD\n  node tools/macuse-repair.mjs --apply --repair-tcc --responsible auto --restart-tccd --sudo-password-env MACUSE_SUDO_PASSWORD\n\nSafety:\n  --repair-tcc edits only the current user's TCC database and writes a timestamped backup first.\n  --restart-appserver stops macuse-owned app-server records only. --restart-service is separate and broader.\n  No sends, deletes, purchases, installs, or account/security/privacy UI changes are performed.\n`);
}

/**
 * @param {string[]} argv
 * @returns {RepairOptions}
 */
function parse(argv) {
  /** @type {RepairOptions} */
  const opts = {
    help: false,
    apply: false,
    restartAppserver: false,
    restartService: false,
    unlockEnv: null,
    repairTcc: false,
    responsible: "auto",
    restartTccd: false,
    sudoPasswordEnv: null,
    out: null,
    json: false,
  };
  if (argv.includes("-h") || argv.includes("--help")) {
    opts.help = true;
    return opts;
  }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = () => {
      i += 1;
      const value = argv[i];
      if (value === undefined) throw new Error(`${String(token)} requires a value`);
      return value;
    };
    if (token === "--apply") opts.apply = true;
    else if (token === "--restart-appserver") opts.restartAppserver = true;
    else if (token === "--restart-service") opts.restartService = true;
    else if (token === "--unlock-with-env") opts.unlockEnv = next();
    else if (token === "--repair-tcc") opts.repairTcc = true;
    else if (token === "--responsible") opts.responsible = next();
    else if (token === "--restart-tccd") opts.restartTccd = true;
    else if (token === "--sudo-password-env") opts.sudoPasswordEnv = next();
    else if (token === "--out") opts.out = resolve(next());
    else if (token === "--json") opts.json = true;
    else throw new Error(`unknown option: ${String(token)}`);
  }
  return opts;
}

/**
 * @param {RepairReport} report
 * @param {string} status
 * @param {string} name
 * @param {string} summary
 * @param {unknown} [details]
 * @returns {void}
 */
function add(report, status, name, summary, details = null) {
  report.actions.push({ status, name, summary, details });
}

/**
 * @param {number} pid
 * @returns {boolean}
 */
function pidExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {number} pid
 * @returns {string}
 */
function processStart(pid) {
  const result = runCommand("process start", "ps", ["-p", String(pid), "-o", "lstart="], {
    timeoutMs: 5000,
  });
  return result.ok ? result.stdout.trim() : "";
}

/**
 * @param {number} pid
 * @returns {string}
 */
function processCommand(pid) {
  const result = runCommand("process command", "ps", ["-p", String(pid), "-o", "command="], {
    timeoutMs: 5000,
  });
  return result.ok ? result.stdout.trim() : "";
}

/**
 * @param {unknown} value
 * @returns {value is RegistryRecord}
 */
function isRegistryRecord(value) {
  if (typeof value !== "object" || value === null) return false;
  if (!("ownerPid" in value) || typeof value.ownerPid !== "number") return false;
  if (!("appServerPid" in value) || typeof value.appServerPid !== "number") return false;
  if ("ownerStart" in value && value.ownerStart !== null && typeof value.ownerStart !== "string")
    return false;
  if (
    "appServerStart" in value &&
    value.appServerStart !== null &&
    typeof value.appServerStart !== "string"
  )
    return false;
  return true;
}

/**
 * @returns {RegistryItem[]}
 */
function registryRecords() {
  try {
    return readdirSync(REGISTRY_DIR)
      .filter((name) => name.startsWith("macuse-appserver-") && name.endsWith(".json"))
      .map((name) => {
        const path = join(REGISTRY_DIR, name);
        try {
          const record = /** @type {unknown} */ (JSON.parse(readFileSync(path, "utf8")));
          if (!isRegistryRecord(record))
            return { path, record: null, error: "record does not match the registry schema" };
          return { path, record };
        } catch (error) {
          return {
            path,
            record: null,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      });
  } catch {
    return [];
  }
}

/**
 * Registry start stamps are advisory; missing or empty values skip the
 * identity check, mirroring the original truthiness guard.
 * @param {string | null | undefined} start
 * @returns {boolean}
 */
const missingStart = (start) => start === null || start === undefined || start === "";

/**
 * @param {RepairReport} report
 * @param {boolean} apply
 * @returns {void}
 */
function reapRegistry(report, apply) {
  for (const item of registryRecords()) {
    const { path, record } = item;
    if (record === null) {
      if (apply) unlinkSync(path);
      add(report, apply ? "fixed" : "would-fix", "registry malformed record", path, item.error);
      continue;
    }
    const ownerAlive =
      pidExists(record.ownerPid) &&
      (missingStart(record.ownerStart) || processStart(record.ownerPid) === record.ownerStart);
    const serverAlive =
      pidExists(record.appServerPid) &&
      (missingStart(record.appServerStart) ||
        processStart(record.appServerPid) === record.appServerStart);
    if (!ownerAlive || !serverAlive) {
      if (apply) unlinkSync(path);
      add(report, apply ? "fixed" : "would-fix", "registry stale record", path, {
        ownerAlive,
        serverAlive,
        record,
      });
    } else {
      add(report, "ok", "registry live record", path, {
        ownerPid: record.ownerPid,
        appServerPid: record.appServerPid,
      });
    }
  }
}

/**
 * @param {RepairReport} report
 * @param {boolean} apply
 * @returns {void}
 */
function stopMacuseAppservers(report, apply) {
  const targets = [];
  for (const { record } of registryRecords()) {
    if (record === null || !pidExists(record.appServerPid)) continue;
    const cmd = processCommand(record.appServerPid);
    if (cmd.includes("codex app-server") && cmd.includes("--enable computer_use"))
      targets.push({ pid: record.appServerPid, cmd });
  }
  if (targets.length === 0) {
    add(
      report,
      "ok",
      "macuse app-server restart",
      "no live macuse-owned app-server registry entries to stop",
    );
    return;
  }
  if (!apply) {
    add(
      report,
      "would-fix",
      "macuse app-server restart",
      `would stop ${targets.length} app-server process(es)`,
      targets,
    );
    return;
  }
  for (const target of targets) {
    try {
      process.kill(target.pid, "SIGTERM");
    } catch {
      // Process already exited.
    }
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
  for (const target of targets) {
    if (pidExists(target.pid)) {
      try {
        process.kill(target.pid, "SIGKILL");
      } catch {
        // Process already exited.
      }
    }
  }
  add(
    report,
    "fixed",
    "macuse app-server restart",
    `stopped ${targets.length} macuse-owned app-server process(es)`,
    targets,
  );
}

/**
 * @param {RepairReport} report
 * @param {boolean} apply
 * @returns {void}
 */
function stopComputerUseService(report, apply) {
  const ps = runCommand("process list", "ps", ["-axo", "pid=,command="], { timeoutMs: 10_000 });
  const targets = [];
  for (const line of ps.stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const [pidText, ...rest] = trimmed.split(/\s+/);
    const pid = Number(pidText);
    const cmd = rest.join(" ");
    if (!Number.isInteger(pid) || pid === process.pid) continue;
    if (cmd === SERVICE_PATH || cmd.endsWith("SkyComputerUseClient mcp"))
      targets.push({ pid, cmd });
  }
  if (targets.length === 0) {
    add(
      report,
      "ok",
      "Computer Use service restart",
      "no SkyComputerUseService or SkyComputerUseClient mcp helpers found",
    );
    return;
  }
  if (!apply) {
    add(
      report,
      "would-fix",
      "Computer Use service restart",
      `would stop ${targets.length} Computer Use service/helper process(es)`,
      targets,
    );
    return;
  }
  for (const target of targets) {
    try {
      process.kill(target.pid, "SIGTERM");
    } catch {
      // Process already exited.
    }
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
  for (const target of targets) {
    if (pidExists(target.pid)) {
      try {
        process.kill(target.pid, "SIGKILL");
      } catch {
        // Process already exited.
      }
    }
  }
  add(
    report,
    "fixed",
    "Computer Use service restart",
    `stopped ${targets.length} Computer Use service/helper process(es)`,
    targets,
  );
}

/**
 * @param {RepairReport} report
 * @param {boolean} apply
 * @returns {void}
 */
function wakeAndStopScreensaver(report, apply) {
  const screensavers = runCommand(
    "screensaver pgrep",
    "pgrep",
    ["-fl", "ScreenSaver.Engine|ScreenSaverEngine"],
    { timeoutMs: 5000 },
  );
  if (!apply) {
    add(
      report,
      screensavers.stdout.trim().length > 0 ? "would-fix" : "ok",
      "wake display / stop screensaver",
      screensavers.stdout.trim().length > 0
        ? "would wake display and stop ScreenSaver.Engine"
        : "no ScreenSaver.Engine process detected",
    );
    return;
  }
  runCommand("caffeinate wake", "/usr/bin/caffeinate", ["-u", "-t", "3"], { timeoutMs: 5000 });
  runCommand("stop ScreenSaverEngine", "/usr/bin/killall", ["ScreenSaverEngine"], {
    timeoutMs: 5000,
  });
  runCommand("stop ScreenSaver.Engine", "/usr/bin/killall", ["ScreenSaver.Engine"], {
    timeoutMs: 5000,
  });
  add(
    report,
    "fixed",
    "wake display / stop screensaver",
    "sent user-activity wake and stopped ScreenSaver.Engine if present",
  );
}

/**
 * @param {RepairReport} report
 * @param {boolean} apply
 * @param {string | null} envName
 * @returns {void}
 */
function unlockConsole(report, apply, envName) {
  if (envName === null || envName === "") return;
  const password = process.env[envName];
  if (password === undefined || password === "")
    throw new Error(`--unlock-with-env ${envName} was set, but ${envName} is empty`);
  if (!apply) {
    add(
      report,
      "would-fix",
      "unlock console",
      `would run temporary HID unlock helper using ${envName}`,
    );
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "macuse-unlock-"));
  const source = join(dir, "unlock.swift");
  const bin = join(dir, "unlock");
  writeFileSync(
    source,
    `import CoreGraphics\nimport Foundation\nimport IOKit.pwr_mgt\nfunc wake(){var id: IOPMAssertionID = 0; _ = IOPMAssertionDeclareUserActivity("macuse repair" as CFString, kIOPMUserActiveLocal, &id)}\nfunc key(_ k: CGKeyCode){let s=CGEventSource(stateID:.hidSystemState); CGEvent(keyboardEventSource:s, virtualKey:k, keyDown:true)?.post(tap:.cghidEventTap); CGEvent(keyboardEventSource:s, virtualKey:k, keyDown:false)?.post(tap:.cghidEventTap)}\nfunc type(_ t:String){let s=CGEventSource(stateID:.hidSystemState); let c=Array(t.utf16); var i=0; while i<c.count{let l=min(20,c.count-i); var chunk=Array(c[i..<(i+l)]); if let e=CGEvent(keyboardEventSource:s, virtualKey:49, keyDown:true){chunk.withUnsafeMutableBufferPointer{e.keyboardSetUnicodeString(stringLength:l, unicodeString:$0.baseAddress!)}; e.post(tap:.cghidEventTap)}; CGEvent(keyboardEventSource:s, virtualKey:49, keyDown:false)?.post(tap:.cghidEventTap); usleep(80000); i += l}}\nguard let p=ProcessInfo.processInfo.environment["MACUSE_UNLOCK_PASSWORD"], p.count > 1 else { exit(2) }\nwake(); usleep(700000); key(49); usleep(700000); type(p); usleep(200000); key(52); usleep(2000000)\n`,
  );
  const compile = runCommand("compile unlock helper", "swiftc", [source, "-o", bin], {
    timeoutMs: 60_000,
  });
  if (!compile.ok)
    throw new Error(
      `failed to compile unlock helper: ${
        firstText([compile.stderr, compile.stdout, compile.error]) ?? "no compiler output"
      }`,
    );
  const run = runCommand("run unlock helper", bin, [], {
    timeoutMs: 20_000,
    env: { MACUSE_UNLOCK_PASSWORD: password },
  });
  rmSync(dir, { recursive: true, force: true });
  add(
    report,
    run.ok ? "fixed" : "fail",
    "unlock console",
    run.ok
      ? "temporary HID unlock helper completed"
      : (firstText([run.stderr, run.stdout, run.error]) ?? `exit ${String(run.status)}`),
  );
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function sqlQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

/**
 * @param {string} path
 * @param {string} dir
 * @returns {string}
 */
function requirementHex(path, dir) {
  if (!existsSync(path)) throw new Error(`code object does not exist: ${path}`);
  const codesign = runCommand("codesign designated requirement", "/usr/bin/codesign", [
    "-dr",
    "-",
    path,
  ]);
  const text = `${codesign.stdout}\n${codesign.stderr}`;
  const requirement = text
    .split("\n")
    .find((line) => line.startsWith("designated => "))
    ?.replace("designated => ", "");
  if (requirement === undefined || requirement === "")
    throw new Error(`could not read designated requirement for ${path}: ${text.slice(0, 500)}`);
  const reqPath = join(dir, `${Buffer.from(path).toString("hex").slice(0, 16)}.req`);
  const outPath = join(dir, `${Buffer.from(path).toString("hex").slice(0, 16)}.csreq`);
  writeFileSync(reqPath, `${requirement}\n`);
  const csreq = runCommand("compile csreq", "/usr/bin/csreq", ["-r", reqPath, "-b", outPath], {
    timeoutMs: 20_000,
  });
  if (!csreq.ok)
    throw new Error(
      `csreq failed for ${path}: ${firstText([csreq.stderr, csreq.stdout, csreq.error]) ?? "no output"}`,
    );
  return readFileSync(outPath).toString("hex");
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function sqliteValue(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  if (typeof value === "object" && "hex" in value && typeof value.hex === "string")
    return `x'${value.hex}'`;
  return sqlQuote(value);
}

/**
 * @param {string[]} columns
 * @param {Record<string, unknown>} row
 * @returns {string}
 */
function insertTccRowSql(columns, row) {
  const wanted = Object.entries(row).filter(([key]) => columns.includes(key));
  return `insert or replace into access (${wanted.map(([key]) => key).join(",")}) values (${wanted
    .map(([, value]) => sqliteValue(value))
    .join(",")});`;
}

/**
 * @param {string} bundlePath
 * @returns {string | null}
 */
function executableFromBundle(bundlePath) {
  const plist = `${bundlePath}/Contents/Info.plist`;
  const result = runCommand(
    "bundle executable",
    "/usr/libexec/PlistBuddy",
    ["-c", "Print :CFBundleExecutable", plist],
    { timeoutMs: 5000 },
  );
  const executable = result.ok ? result.stdout.trim() : "";
  return executable !== "" ? `${bundlePath}/Contents/MacOS/${executable}` : null;
}

/**
 * @param {string} args
 * @returns {string | null}
 */
function appExecutableFromArgs(args) {
  const bundlePath = args.match(/(\/.*?\.app)(?:\/Contents\/MacOS(?:\/|\s|$)|\s|$)/)?.[1];
  return bundlePath !== undefined && existsSync(bundlePath)
    ? executableFromBundle(bundlePath)
    : null;
}

/**
 * @param {number} pid
 * @returns {{ ppid: number, args: string } | null}
 */
function parentProcessInfo(pid) {
  const result = runCommand(
    "parent process",
    "ps",
    ["-p", String(pid), "-o", "ppid=", "-o", "args="],
    { timeoutMs: 5000 },
  );
  if (!result.ok) return null;
  const match = result.stdout.trim().match(/^(\d+)\s+([\s\S]+)$/);
  if (!match) return null;
  return { ppid: Number(match[1]), args: match[2] ?? "" };
}

/**
 * @param {number} [startPid]
 * @returns {string | null}
 */
function responsibleFromProcessTree(startPid = process.ppid) {
  let pid = startPid;
  for (let depth = 0; Number.isInteger(pid) && pid > 1 && depth < 20; depth += 1) {
    const info = parentProcessInfo(pid);
    if (!info) return null;
    const appExecutable = appExecutableFromArgs(info.args);
    if (appExecutable !== null && existsSync(appExecutable)) return appExecutable;
    pid = info.ppid;
  }
  return null;
}

/**
 * @returns {string | null}
 */
function autoResponsiblePath() {
  const sshConnection = process.env.SSH_CONNECTION;
  const sshTty = process.env.SSH_TTY;
  if (
    (sshConnection !== undefined && sshConnection !== "") ||
    (sshTty !== undefined && sshTty !== "")
  )
    return "/usr/libexec/sshd-keygen-wrapper";
  return responsibleFromProcessTree();
}

/**
 * @param {RepairReport} report
 * @param {boolean} apply
 * @param {RepairOptions} opts
 * @returns {void}
 */
function repairTcc(report, apply, opts) {
  if (!opts.repairTcc) return;
  const responsible = opts.responsible === "auto" ? autoResponsiblePath() : opts.responsible;
  if (responsible === null || responsible === "")
    throw new Error("could not auto-detect responsible launcher; pass --responsible <path>");
  if (!existsSync(USER_TCC_DB)) throw new Error(`user TCC DB not found: ${USER_TCC_DB}`);
  if (!apply) {
    add(
      report,
      "would-fix",
      "TCC AppleEvents repair",
      `would add ${responsible} and ${CLIENT_BUNDLE_ID} -> ${SERVICE_BUNDLE_ID} to ${USER_TCC_DB}`,
    );
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "macuse-tcc-"));
  const now = Math.floor(Date.now() / 1000);
  const backup = `${USER_TCC_DB}.macuse-repair-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  copyFileSync(USER_TCC_DB, backup);
  const serviceHex = requirementHex(SERVICE_PATH, dir);
  const responsibleHex = requirementHex(responsible, dir);
  const clientHex = existsSync(CLIENT_PATH) ? requirementHex(CLIENT_PATH, dir) : null;
  const colsResult = runCommand(
    "sqlite columns",
    "/usr/bin/sqlite3",
    [USER_TCC_DB, "pragma table_info(access);"],
    { timeoutMs: 10_000 },
  );
  if (!colsResult.ok)
    throw new Error(
      `could not inspect TCC schema: ${
        firstText([colsResult.stderr, colsResult.stdout, colsResult.error]) ?? "no output"
      }`,
    );
  const columns = colsResult.stdout
    .split("\n")
    .map((line) => line.split("|")[1] ?? "")
    .filter((column) => column.length > 0);
  const base = {
    service: "kTCCServiceAppleEvents",
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
    boot_uuid: "UNUSED",
    last_reminded: now,
  };
  const sql = [
    insertTccRowSql(columns, {
      ...base,
      client: responsible,
      client_type: 1,
      csreq: { hex: responsibleHex },
    }),
    clientHex !== null
      ? insertTccRowSql(columns, {
          ...base,
          client: CLIENT_BUNDLE_ID,
          client_type: 0,
          csreq: { hex: clientHex },
        })
      : "",
  ]
    .filter((statement) => statement !== "")
    .join("\n");
  const sqlite = runCommand("sqlite TCC repair", "/usr/bin/sqlite3", [USER_TCC_DB, sql], {
    timeoutMs: 20_000,
  });
  rmSync(dir, { recursive: true, force: true });
  if (!sqlite.ok)
    throw new Error(
      `TCC sqlite repair failed: ${firstText([sqlite.stderr, sqlite.stdout, sqlite.error]) ?? "no output"}`,
    );
  add(
    report,
    "fixed",
    "TCC AppleEvents repair",
    `added AppleEvents grants for ${responsible} and ${CLIENT_BUNDLE_ID} to ${SERVICE_BUNDLE_ID}`,
    { backup, userTccDb: USER_TCC_DB },
  );
}

/**
 * @param {RepairReport} report
 * @param {boolean} apply
 * @param {RepairOptions} opts
 * @returns {void}
 */
function restartTccd(report, apply, opts) {
  if (!opts.restartTccd) return;
  const envVar = opts.sudoPasswordEnv;
  const sudoPassword = envVar === null ? undefined : process.env[envVar];
  if (envVar === null || envVar === "" || sudoPassword === undefined || sudoPassword === "")
    throw new Error("--restart-tccd requires --sudo-password-env <VAR> with a non-empty value");
  if (!apply) {
    add(report, "would-fix", "restart tccd", `would run sudo killall tccd using ${envVar}`);
    return;
  }
  const run = runCommand(
    "restart tccd",
    "/usr/bin/sudo",
    ["-S", "-p", "", "/usr/bin/killall", "tccd"],
    { input: `${sudoPassword}\n`, timeoutMs: 20_000 },
  );
  add(
    report,
    run.ok || run.status === 1 ? "fixed" : "fail",
    "restart tccd",
    run.ok || run.status === 1
      ? "sent tccd restart request"
      : (firstText([run.stderr, run.stdout, run.error]) ?? `exit ${String(run.status)}`),
  );
}

/**
 * @param {RepairReport} report
 * @returns {string}
 */
function renderMarkdown(report) {
  const rows = report.actions
    .map(
      (action) =>
        `| ${action.status} | ${action.name} | ${action.summary.replaceAll("|", "\\|")} |`,
    )
    .join("\n");
  return `# macuse repair report\n\nGenerated: ${report.generatedAt}\nMode: ${report.apply ? "apply" : "dry-run"}\nRepo: ${REPO_ROOT}\n\n| Status | Action | Summary |\n| --- | --- | --- |\n${
    rows.length > 0 ? rows : "| ok | no-op | no actions requested |"
  }\n\nRun doctor after repair:\n\n\`\`\`bash\nnode tools/macuse-doctor.mjs --out .scratch/doctor\n\`\`\`\n`;
}

async function main() {
  const opts = parse(process.argv.slice(2));
  if (opts.help) {
    help();
    return;
  }
  /** @type {RepairReport} */
  const report = {
    ok: false,
    generatedAt: new Date().toISOString(),
    apply: opts.apply,
    options: {
      apply: opts.apply,
      restartAppserver: opts.restartAppserver,
      restartService: opts.restartService,
      unlockEnv: opts.unlockEnv !== null && opts.unlockEnv !== "" ? opts.unlockEnv : null,
      repairTcc: opts.repairTcc,
      responsible: opts.responsible,
      restartTccd: opts.restartTccd,
      sudoPasswordEnv:
        opts.sudoPasswordEnv !== null && opts.sudoPasswordEnv !== "" ? opts.sudoPasswordEnv : null,
      out: opts.out,
      json: opts.json,
    },
    actions: [],
  };
  wakeAndStopScreensaver(report, opts.apply);
  reapRegistry(report, opts.apply);
  if (opts.restartAppserver) stopMacuseAppservers(report, opts.apply);
  if (opts.restartService) stopComputerUseService(report, opts.apply);
  unlockConsole(report, opts.apply, opts.unlockEnv);
  repairTcc(report, opts.apply, opts);
  restartTccd(report, opts.apply, opts);
  report.ok = report.actions.every((action) => action.status !== "fail");
  if (opts.out !== null) {
    ensureDir(dirname(opts.out));
    writeJsonFile(opts.out, report);
  }
  if (opts.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else process.stdout.write(renderMarkdown(report));
  if (!report.ok) process.exitCode = 1;
}

main().catch((/** @type {unknown} */ error) => {
  const message = error instanceof Error ? error.message : "";
  process.stderr.write(`FAIL ${message !== "" ? message : String(error)}\n`);
  process.exitCode = 1;
});
