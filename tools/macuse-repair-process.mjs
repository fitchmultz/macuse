import { readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_COMPUTER_USE_APP, runCommand } from "./macuse-utils.mjs";

export const REGISTRY_DIR = "/tmp/macuse-appserver";
export const SERVICE_PATH = `${DEFAULT_COMPUTER_USE_APP}/Contents/MacOS/SkyComputerUseService`;
export const CLIENT_PATH = `${DEFAULT_COMPUTER_USE_APP}/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient`;

/** @typedef {{ help: boolean, apply: boolean, restartAppserver: boolean, restartService: boolean, unlockEnv: string | null, repairTcc: boolean, responsible: string, restartTccd: boolean, sudoPasswordEnv: string | null, out: string | null, json: boolean }} RepairOptions */

/** @typedef {{ status: string, name: string, summary: string, details: unknown }} RepairAction */
/** @typedef {{ ok: boolean, generatedAt: string, apply: boolean, options: Record<string, unknown>, actions: RepairAction[] }} RepairReport */

/**
 * Registry files are written by macuse itself, but they persist across
 * versions, so every read is validated before use.
 * @typedef {{ ownerPid: number, ownerStart?: string | null, appServerPid: number, appServerStart?: string | null }} RegistryRecord
 * @typedef {{ path: string, record: RegistryRecord | null, error?: string }} RegistryItem
 */

/**
 * @param {RepairReport} report
 * @param {RepairAction} action
 * @returns {void}
 */
export function add(report, action) {
  report.actions.push(action);
}

/**
 * @param {number} pid
 * @returns {boolean}
 */
export function pidExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
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
export function processStart(pid) {
  const result = runCommand("process start", "ps", ["-p", String(pid), "-o", "lstart="], {
    timeoutMs: 5000,
  });
  return result.ok ? result.stdout.trim() : "";
}

/**
 * @param {number} pid
 * @returns {string}
 */
export function processCommand(pid) {
  const result = runCommand("process command", "ps", ["-p", String(pid), "-o", "command="], {
    timeoutMs: 5000,
  });
  return result.ok ? result.stdout.trim() : "";
}

/**
 * @param {object} value
 * @returns {boolean}
 */
function hasOwnerFields(value) {
  return (
    "ownerPid" in value &&
    typeof value.ownerPid === "number" &&
    (!("ownerStart" in value) || value.ownerStart === null || typeof value.ownerStart === "string")
  );
}

/**
 * @param {object} value
 * @returns {boolean}
 */
function hasServerFields(value) {
  return (
    "appServerPid" in value &&
    typeof value.appServerPid === "number" &&
    (!("appServerStart" in value) ||
      value.appServerStart === null ||
      typeof value.appServerStart === "string")
  );
}

/**
 * @param {unknown} value
 * @returns {value is RegistryRecord}
 */
function isRegistryRecord(value) {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  return hasOwnerFields(value) && hasServerFields(value);
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
          if (!isRegistryRecord(record)) {
            return { path, record: null, error: "record does not match the registry schema" };
          }
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
 * @param {RegistryRecord} record
 * @returns {{ ownerAlive: boolean, serverAlive: boolean }}
 */
function registryLiveness(record) {
  const ownerAlive =
    pidExists(record.ownerPid) &&
    (missingStart(record.ownerStart) || processStart(record.ownerPid) === record.ownerStart);
  const serverAlive =
    pidExists(record.appServerPid) &&
    (missingStart(record.appServerStart) ||
      processStart(record.appServerPid) === record.appServerStart);
  return { ownerAlive, serverAlive };
}

/**
 * @param {RepairReport} report
 * @param {boolean} apply
 * @param {RegistryItem} item
 * @returns {void}
 */
function reapOne(report, apply, item) {
  const { path, record } = item;
  if (record === null) {
    if (apply) {
      unlinkSync(path);
    }
    add(report, {
      status: apply ? "fixed" : "would-fix",
      name: "registry malformed record",
      summary: path,
      details: item.error,
    });
    return;
  }
  const { ownerAlive, serverAlive } = registryLiveness(record);
  if (!ownerAlive || !serverAlive) {
    if (apply) {
      unlinkSync(path);
    }
    add(report, {
      status: apply ? "fixed" : "would-fix",
      name: "registry stale record",
      summary: path,
      details: {
        ownerAlive,
        serverAlive,
        record,
      },
    });
  } else {
    add(report, {
      status: "ok",
      name: "registry live record",
      summary: path,
      details: {
        ownerPid: record.ownerPid,
        appServerPid: record.appServerPid,
      },
    });
  }
}

/**
 * @param {RepairReport} report
 * @param {boolean} apply
 * @returns {void}
 */
export function reapRegistry(report, apply) {
  for (const item of registryRecords()) {
    reapOne(report, apply, item);
  }
}

export { isRegistryRecord, registryRecords };
