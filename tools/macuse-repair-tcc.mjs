import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { firstText, runCommand } from "./macuse-utils.mjs";
import { CLIENT_PATH, SERVICE_PATH, add } from "./macuse-repair-process.mjs";

/** @typedef {import("./macuse-repair-process.mjs").RepairOptions} RepairOptions */
/** @typedef {import("./macuse-repair-process.mjs").RepairReport} RepairReport */

export const USER_TCC_DB = `${String(process.env.HOME)}/Library/Application Support/com.apple.TCC/TCC.db`;
export const SERVICE_BUNDLE_ID = "com.openai.sky.CUAService";
export const CLIENT_BUNDLE_ID = "com.openai.sky.CUAService.cli";

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
  if (!existsSync(path)) {
    throw new Error(`code object does not exist: ${path}`);
  }
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
  if (requirement === undefined || requirement === "") {
    throw new Error(`could not read designated requirement for ${path}: ${text.slice(0, 500)}`);
  }
  const reqPath = join(dir, `${Buffer.from(path).toString("hex").slice(0, 16)}.req`);
  const outPath = join(dir, `${Buffer.from(path).toString("hex").slice(0, 16)}.csreq`);
  writeFileSync(reqPath, `${requirement}\n`);
  const csreq = runCommand("compile csreq", "/usr/bin/csreq", ["-r", reqPath, "-b", outPath], {
    timeoutMs: 20_000,
  });
  if (!csreq.ok) {
    throw new Error(
      `csreq failed for ${path}: ${firstText([csreq.stderr, csreq.stdout, csreq.error]) ?? "no output"}`,
    );
  }
  return readFileSync(outPath).toString("hex");
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function sqliteValue(value) {
  if (value === null || value === undefined) {
    return "NULL";
  }
  if (typeof value === "number") {
    return String(value);
  }
  if (typeof value === "object" && "hex" in value && typeof value.hex === "string") {
    return `x'${value.hex}'`;
  }
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
  if (!result.ok) {
    return null;
  }
  const match = result.stdout.trim().match(/^(\d+)\s+([\s\S]+)$/);
  if (!match) {
    return null;
  }
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
    if (!info) {
      return null;
    }
    const appExecutable = appExecutableFromArgs(info.args);
    if (appExecutable !== null && existsSync(appExecutable)) {
      return appExecutable;
    }
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
  ) {
    return "/usr/libexec/sshd-keygen-wrapper";
  }
  return responsibleFromProcessTree();
}

/**
 * Resolve the responsible launcher, failing when auto-detection is empty.
 * @param {RepairOptions} opts
 * @returns {string}
 */
function responsibleLauncherPath(opts) {
  const responsible = opts.responsible === "auto" ? autoResponsiblePath() : opts.responsible;
  if (responsible === null || responsible === "") {
    throw new Error("could not auto-detect responsible launcher; pass --responsible <path>");
  }
  return responsible;
}

/**
 * Read the TCC access-table column names.
 * @returns {string[]}
 */
function tccColumns() {
  const colsResult = runCommand(
    "sqlite columns",
    "/usr/bin/sqlite3",
    [USER_TCC_DB, "pragma table_info(access);"],
    { timeoutMs: 10_000 },
  );
  if (!colsResult.ok) {
    throw new Error(
      `could not inspect TCC schema: ${
        firstText([colsResult.stderr, colsResult.stdout, colsResult.error]) ?? "no output"
      }`,
    );
  }
  return colsResult.stdout
    .split("\n")
    .map((line) => line.split("|")[1] ?? "")
    .filter((column) => column.length > 0);
}

/**
 * @param {string} serviceHex
 * @param {number} now
 * @returns {Record<string, unknown>}
 */
function tccBaseRow(serviceHex, now) {
  return {
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
}

/**
 * @param {RepairReport} report
 * @param {boolean} apply
 * @param {RepairOptions} opts
 * @returns {void}
 */
export function repairTcc(report, apply, opts) {
  if (!opts.repairTcc) {
    return;
  }
  const responsible = responsibleLauncherPath(opts);
  if (!existsSync(USER_TCC_DB)) {
    throw new Error(`user TCC DB not found: ${USER_TCC_DB}`);
  }
  if (!apply) {
    add(report, {
      status: "would-fix",
      name: "TCC AppleEvents repair",
      summary: `would add ${responsible} and ${CLIENT_BUNDLE_ID} -> ${SERVICE_BUNDLE_ID} to ${USER_TCC_DB}`,
      details: null,
    });
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "macuse-tcc-"));
  const now = Math.floor(Date.now() / 1000);
  const backup = `${USER_TCC_DB}.macuse-repair-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  copyFileSync(USER_TCC_DB, backup);
  const serviceHex = requirementHex(SERVICE_PATH, dir);
  const responsibleHex = requirementHex(responsible, dir);
  const clientHex = existsSync(CLIENT_PATH) ? requirementHex(CLIENT_PATH, dir) : null;
  const columns = tccColumns();
  const base = tccBaseRow(serviceHex, now);
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
  if (!sqlite.ok) {
    throw new Error(
      `TCC sqlite repair failed: ${firstText([sqlite.stderr, sqlite.stdout, sqlite.error]) ?? "no output"}`,
    );
  }
  add(report, {
    status: "fixed",
    name: "TCC AppleEvents repair",
    summary: `added AppleEvents grants for ${responsible} and ${CLIENT_BUNDLE_ID} to ${SERVICE_BUNDLE_ID}`,
    details: {
      backup,
      userTccDb: USER_TCC_DB,
    },
  });
}

/**
 * Read the sudo password from the configured environment variable.
 * @param {RepairOptions} opts
 * @returns {string}
 */
function sudoPasswordFor(opts) {
  const envVar = opts.sudoPasswordEnv;
  const sudoPassword = envVar === null ? undefined : process.env[envVar];
  if (envVar === null || envVar === "" || sudoPassword === undefined || sudoPassword === "") {
    throw new Error("--restart-tccd requires --sudo-password-env <VAR> with a non-empty value");
  }
  return sudoPassword;
}

/**
 * @param {RepairReport} report
 * @param {boolean} apply
 * @param {RepairOptions} opts
 * @returns {void}
 */
export function restartTccd(report, apply, opts) {
  if (!opts.restartTccd) {
    return;
  }
  const envVar = opts.sudoPasswordEnv;
  const sudoPassword = sudoPasswordFor(opts);
  if (!apply) {
    add(report, {
      status: "would-fix",
      name: "restart tccd",
      summary: `would run sudo killall tccd using ${envVar ?? ""}`,
      details: null,
    });
    return;
  }
  const run = runCommand(
    "restart tccd",
    "/usr/bin/sudo",
    ["-S", "-p", "", "/usr/bin/killall", "tccd"],
    { input: `${sudoPassword}\n`, timeoutMs: 20_000 },
  );
  const succeeded = run.ok || run.status === 1;
  add(report, {
    status: succeeded ? "fixed" : "fail",
    name: "restart tccd",
    summary: succeeded
      ? "sent tccd restart request"
      : (firstText([run.stderr, run.stdout, run.error]) ?? `exit ${String(run.status)}`),
    details: null,
  });
}
