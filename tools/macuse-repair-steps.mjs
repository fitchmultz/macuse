import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { firstText, runCommand } from "./macuse-utils.mjs";
import {
  SERVICE_PATH,
  add,
  pidExists,
  processCommand,
  registryRecords,
} from "./macuse-repair-process.mjs";

/** @typedef {import("./macuse-repair-process.mjs").RepairReport} RepairReport */

/**
 * Stop targets with SIGTERM, wait briefly, then SIGKILL survivors.
 * @param {Array<{ pid: number, cmd: string }>} targets
 * @returns {void}
 */
function terminateTargets(targets) {
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
}

/**
 * @returns {Array<{ pid: number, cmd: string }>}
 */
function macuseAppserverTargets() {
  const targets = [];
  for (const { record } of registryRecords()) {
    if (record === null || !pidExists(record.appServerPid)) {
      continue;
    }
    const cmd = processCommand(record.appServerPid);
    if (cmd.includes("codex app-server") && cmd.includes("--enable computer_use")) {
      targets.push({ pid: record.appServerPid, cmd });
    }
  }
  return targets;
}

/**
 * @param {RepairReport} report
 * @param {boolean} apply
 * @returns {void}
 */
export function stopMacuseAppservers(report, apply) {
  const targets = macuseAppserverTargets();
  if (targets.length === 0) {
    add(report, {
      status: "ok",
      name: "macuse app-server restart",
      summary: "no live macuse-owned app-server registry entries to stop",
      details: null,
    });
    return;
  }
  if (!apply) {
    add(report, {
      status: "would-fix",
      name: "macuse app-server restart",
      summary: `would stop ${targets.length} app-server process(es)`,
      details: targets,
    });
    return;
  }
  terminateTargets(targets);
  add(report, {
    status: "fixed",
    name: "macuse app-server restart",
    summary: `stopped ${targets.length} macuse-owned app-server process(es)`,
    details: targets,
  });
}

/**
 * @returns {Array<{ pid: number, cmd: string }>}
 */
function computerUseTargets() {
  const ps = runCommand("process list", "ps", ["-axo", "pid=,command="], { timeoutMs: 10_000 });
  const targets = [];
  for (const line of ps.stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const [pidText, ...rest] = trimmed.split(/\s+/);
    const pid = Number(pidText);
    const cmd = rest.join(" ");
    if (!Number.isInteger(pid) || pid === process.pid) {
      continue;
    }
    if (cmd === SERVICE_PATH || cmd.endsWith("SkyComputerUseClient mcp")) {
      targets.push({ pid, cmd });
    }
  }
  return targets;
}

/**
 * @param {RepairReport} report
 * @param {boolean} apply
 * @returns {void}
 */
export function stopComputerUseService(report, apply) {
  const targets = computerUseTargets();
  if (targets.length === 0) {
    add(report, {
      status: "ok",
      name: "Computer Use service restart",
      summary: "no SkyComputerUseService or SkyComputerUseClient mcp helpers found",
      details: null,
    });
    return;
  }
  if (!apply) {
    add(report, {
      status: "would-fix",
      name: "Computer Use service restart",
      summary: `would stop ${targets.length} Computer Use service/helper process(es)`,
      details: targets,
    });
    return;
  }
  terminateTargets(targets);
  add(report, {
    status: "fixed",
    name: "Computer Use service restart",
    summary: `stopped ${targets.length} Computer Use service/helper process(es)`,
    details: targets,
  });
}

/**
 * @param {RepairReport} report
 * @param {boolean} apply
 * @returns {void}
 */
export function wakeAndStopScreensaver(report, apply) {
  const screensavers = runCommand(
    "screensaver pgrep",
    "pgrep",
    ["-fl", "ScreenSaver.Engine|ScreenSaverEngine"],
    { timeoutMs: 5000 },
  );
  if (!apply) {
    const active = screensavers.stdout.trim().length > 0;
    add(report, {
      status: active ? "would-fix" : "ok",
      name: "wake display / stop screensaver",
      summary: active
        ? "would wake display and stop ScreenSaver.Engine"
        : "no ScreenSaver.Engine process detected",
      details: null,
    });
    return;
  }
  runCommand("caffeinate wake", "/usr/bin/caffeinate", ["-u", "-t", "3"], { timeoutMs: 5000 });
  runCommand("stop ScreenSaverEngine", "/usr/bin/killall", ["ScreenSaverEngine"], {
    timeoutMs: 5000,
  });
  runCommand("stop ScreenSaver.Engine", "/usr/bin/killall", ["ScreenSaver.Engine"], {
    timeoutMs: 5000,
  });
  add(report, {
    status: "fixed",
    name: "wake display / stop screensaver",
    summary: "sent user-activity wake and stopped ScreenSaver.Engine if present",
    details: null,
  });
}

/**
 * Compile the temporary HID unlock helper; throws on compile failure.
 * The password reaches the helper through its environment, never argv.
 * @param {string} dir
 * @returns {string}
 */
function compileUnlockHelper(dir) {
  const source = join(dir, "unlock.swift");
  const bin = join(dir, "unlock");
  writeFileSync(
    source,
    `import CoreGraphics\nimport Foundation\nimport IOKit.pwr_mgt\nfunc wake(){var id: IOPMAssertionID = 0; _ = IOPMAssertionDeclareUserActivity("macuse repair" as CFString, kIOPMUserActiveLocal, &id)}\nfunc key(_ k: CGKeyCode){let s=CGEventSource(stateID:.hidSystemState); CGEvent(keyboardEventSource:s, virtualKey:k, keyDown:true)?.post(tap:.cghidEventTap); CGEvent(keyboardEventSource:s, virtualKey:k, keyDown:false)?.post(tap:.cghidEventTap)}\nfunc type(_ t:String){let s=CGEventSource(stateID:.hidSystemState); let c=Array(t.utf16); var i=0; while i<c.count{let l=min(20,c.count-i); var chunk=Array(c[i..<(i+l)]); if let e=CGEvent(keyboardEventSource:s, virtualKey:49, keyDown:true){chunk.withUnsafeMutableBufferPointer{e.keyboardSetUnicodeString(stringLength:l, unicodeString:$0.baseAddress!)}; e.post(tap:.cghidEventTap)}; CGEvent(keyboardEventSource:s, virtualKey:49, keyDown:false)?.post(tap:.cghidEventTap); usleep(80000); i += l}}\nguard let p=ProcessInfo.processInfo.environment["MACUSE_UNLOCK_PASSWORD"], p.count > 1 else { exit(2) }\nwake(); usleep(700000); key(49); usleep(700000); type(p); usleep(200000); key(52); usleep(2000000)\n`,
  );
  const compile = runCommand("compile unlock helper", "swiftc", [source, "-o", bin], {
    timeoutMs: 60_000,
  });
  if (!compile.ok) {
    throw new Error(
      `failed to compile unlock helper: ${
        firstText([compile.stderr, compile.stdout, compile.error]) ?? "no compiler output"
      }`,
    );
  }
  return bin;
}

/**
 * @param {RepairReport} report
 * @param {boolean} apply
 * @param {string | null} envName
 * @returns {void}
 */
export function unlockConsole(report, apply, envName) {
  if (envName === null || envName === "") {
    return;
  }
  const password = process.env[envName];
  if (password === undefined || password === "") {
    throw new Error(`--unlock-with-env ${envName} was set, but ${envName} is empty`);
  }
  if (!apply) {
    add(report, {
      status: "would-fix",
      name: "unlock console",
      summary: `would run temporary HID unlock helper using ${envName}`,
      details: null,
    });
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "macuse-unlock-"));
  const bin = compileUnlockHelper(dir);
  const run = runCommand("run unlock helper", bin, [], {
    timeoutMs: 20_000,
    env: { MACUSE_UNLOCK_PASSWORD: password },
  });
  rmSync(dir, { recursive: true, force: true });
  add(report, {
    status: run.ok ? "fixed" : "fail",
    name: "unlock console",
    summary: run.ok
      ? "temporary HID unlock helper completed"
      : (firstText([run.stderr, run.stdout, run.error]) ?? `exit ${String(run.status)}`),
    details: null,
  });
}
