import { execFile } from "node:child_process";
import { basename, isAbsolute } from "node:path";
import { promisify } from "node:util";
import { CUA_WATCHDOG_GRACE_MS } from "./cua-timeout.mjs";

/** @typedef {import("./cua-runtime.mjs").ProcessCommandReader} ProcessCommandReader */
const exec = promisify(execFile);

/** @type {ProcessCommandReader} */
async function readProcessCommand(command, args, signal) {
  if (process.platform !== "darwin") {
    return "";
  }
  const { stdout } = await exec(command, args, { encoding: "utf8", signal });
  return stdout;
}

/**
 * @param {string} app
 * @param {ProcessCommandReader} read
 * @param {AbortSignal} signal
 */
async function appProcessTarget(app, read, signal) {
  // Only a bundle identifier needs Launch Services. App names and paths are matched against ps.
  if (!/^[\da-z-]+(?:\.[\da-z-]+)+$/i.test(app)) {
    return app;
  }
  const info = await read(
    "/usr/bin/lsappinfo",
    ["info", "-only", "bundlepath", "-app", app],
    signal,
  );
  return info.match(/="(\/[^"\n]+\.app)"$/im)?.[1];
}

/**
 * @param {string} row
 * @param {string} target
 * @returns {{ pid: string, executable: string, name: string } | undefined}
 */
function appProcess(row, target) {
  const [, pid, executable, bundle] =
    row.match(/^\s*(\d+)\s+((\/.+\.app)\/Contents\/MacOS\/[^/]+)$/i) ?? [];
  if (pid === undefined || bundle === undefined || executable === undefined) {
    return;
  }
  const name = basename(bundle).replace(/\.app$/i, "");
  const matches = isAbsolute(target)
    ? target === bundle || target === executable
    : target === name || target === basename(bundle) || target === basename(executable);
  return matches ? { pid, executable, name } : undefined;
}

/**
 * @param {string} output
 * @param {{ pid: string, executable: string, name: string }[]} candidates
 */
function instanceLabels(output, candidates) {
  const instances = [];
  const byPid = new Map(candidates.map((candidate) => [candidate.pid, candidate]));
  for (const row of output.split("\n")) {
    const [, pid = "", command = ""] = row.match(/^\s*(\d+)\s+(.+)$/) ?? [];
    const app = byPid.get(pid);
    if (
      app === undefined ||
      (command !== app.executable && !command.startsWith(`${app.executable} `))
    ) {
      continue;
    }
    const args = command.slice(app.executable.length);
    if (/\s--type=/.test(args)) {
      continue;
    }
    const headless = /\s--headless(?:[=\s]|$)/.test(args) ? ", headless" : "";
    instances.push(`${JSON.stringify(app.name)} (PID ${pid}${headless})`);
  }
  return instances;
}

/**
 * Read only the current user's process names, then inspect arguments only for exact app matches.
 * @param {string} app
 * @param {ProcessCommandReader} [read]
 * @param {AbortSignal} [signal]
 * @returns {Promise<string | undefined>}
 */
export async function competingAppDiagnostic(app, read = readProcessCommand, signal) {
  const deadline = AbortSignal.timeout(CUA_WATCHDOG_GRACE_MS);
  const bounded = signal !== undefined ? AbortSignal.any([signal, deadline]) : deadline;
  try {
    bounded.throwIfAborted();
    const target = await appProcessTarget(app, read, bounded);
    if (target === undefined) {
      return;
    }
    bounded.throwIfAborted();
    const list = await read("/bin/ps", ["-xww", "-o", "pid=,comm="], bounded);
    const candidates = list
      .split("\n")
      .map((row) => appProcess(row, target))
      .filter((candidate) => candidate !== undefined);
    if (candidates.length < 2) {
      return;
    }
    const pids = candidates.map(({ pid }) => pid).join(",");
    bounded.throwIfAborted();
    const output = await read("/bin/ps", ["-ww", "-p", pids, "-o", "pid=,args="], bounded);
    bounded.throwIfAborted();
    const instances = instanceLabels(output, candidates);
    return instances.length < 2
      ? undefined
      : `Possible competing app instances: ${instances.join(", ")}. Sky may have selected a different process; confirm the intended instance before continuing.`;
  } catch {
    // A process lookup failure must not replace the original Sky error.
    return;
  }
}
