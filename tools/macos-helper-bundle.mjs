import { execFile, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { Socket, createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

export const HELPER_BUNDLE_ID = "com.fitchmultz.macuse.helper";
export const HELPER_NAME = "Macuse Helper";
export const HELPER_EXECUTABLE = "MacuseHelper";
const execFileAsync = promisify(execFile);

/** @typedef {{ socket: import("node:net").Socket, close: () => Promise<void> }} HelperSession */

/** @returns {string} */
export const helperSupportDir = () =>
  process.env.MACUSE_HELPER_DIR ?? join(homedir(), "Library", "Application Support", "macuse");

/**
 * Resolve a stable code-signing identity when available so macOS TCC retains
 * the user's single grant across helper rebuilds; fall back to ad-hoc `-`.
 * @returns {{ identity: string, mode: "configured" | "developer-id" | "apple-development" | "adhoc" }}
 */
export function discoverSigningIdentity() {
  const configured = process.env.MACUSE_HELPER_SIGN_IDENTITY?.trim();
  if (configured !== undefined && configured !== "") {
    return { identity: configured, mode: "configured" };
  }
  const result = spawnSync("/usr/bin/security", ["find-identity", "-v", "-p", "codesigning"], {
    encoding: "utf8",
  });
  if (result.status !== 0 || typeof result.stdout !== "string") {
    return { identity: "-", mode: "adhoc" };
  }
  const identities = parseSigningIdentities(result.stdout);
  const devId = identities.find((item) => item.label.startsWith("Developer ID Application:"));
  if (devId !== undefined) {
    return { identity: devId.sha1, mode: "developer-id" };
  }
  const appleDev = identities.find((item) => item.label.startsWith("Apple Development:"));
  if (appleDev !== undefined) {
    return { identity: appleDev.sha1, mode: "apple-development" };
  }
  return { identity: "-", mode: "adhoc" };
}

/**
 * @param {string} output
 * @returns {Array<{ sha1: string, label: string }>}
 */
function parseSigningIdentities(output) {
  /** @type {Array<{ sha1: string, label: string }>} */
  const list = [];
  for (const line of output.split("\n")) {
    const match = /^\s*\d+\)\s+([0-9A-F]{40})\s+"([^"]+)"/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      list.push({ sha1: match[1], label: match[2] });
    }
  }
  return list;
}

/**
 * @param {string} text
 * @returns {string}
 */
function xmlEscape(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * @param {string} version
 * @returns {string}
 */
function infoPlist(version) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>${xmlEscape(HELPER_BUNDLE_ID)}</string>
  <key>CFBundleName</key>
  <string>${xmlEscape(HELPER_NAME)}</string>
  <key>CFBundleDisplayName</key>
  <string>${xmlEscape(HELPER_NAME)}</string>
  <key>CFBundleExecutable</key>
  <string>${xmlEscape(HELPER_EXECUTABLE)}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleVersion</key>
  <string>${xmlEscape(version)}</string>
  <key>CFBundleShortVersionString</key>
  <string>${xmlEscape(version)}</string>
  <key>LSUIElement</key>
  <true/>
</dict>
</plist>
`;
}

/**
 * @param {string} appPath
 * @returns {Promise<boolean>}
 */
async function bundleReady(appPath) {
  try {
    await stat(join(appPath, "Contents", "Info.plist"));
    await stat(join(appPath, "Contents", "MacOS", HELPER_EXECUTABLE));
    return true;
  } catch {
    return false;
  }
}

/**
 * Compile and code-sign content-addressed `MacuseHelper.app` when missing.
 * Content-addressed directories avoid cross-process delete/replace races without a lockfile;
 * TCC keys grants on the bundle ID + signing identity across builds.
 * @param {string} sourcePath
 * @param {string} version
 * @returns {Promise<{ appPath: string, bundleId: string, signingMode: string }>}
 */
export async function ensureHelperBundle(sourcePath, version) {
  if (process.platform !== "darwin") {
    throw new Error("Native Accessibility requires macOS");
  }
  const bundlesDir = join(helperSupportDir(), "bundles");
  await mkdir(bundlesDir, { recursive: true, mode: 0o700 });
  const signing = discoverSigningIdentity();
  const buildHash = createHash("sha256")
    .update(await readFile(sourcePath))
    .update(process.arch)
    .update(signing.identity)
    .update(HELPER_BUNDLE_ID)
    .update(version)
    .digest("hex")
    .slice(0, 24);
  const versionDir = join(bundlesDir, buildHash);
  const appPath = join(versionDir, "MacuseHelper.app");
  if (await bundleReady(appPath)) {
    return { appPath, bundleId: HELPER_BUNDLE_ID, signingMode: signing.mode };
  }
  await buildVersionedBundle({ sourcePath, version, bundlesDir, versionDir, appPath, signing });
  return { appPath, bundleId: HELPER_BUNDLE_ID, signingMode: signing.mode };
}

/**
 * @param {{ sourcePath: string, version: string, bundlesDir: string, versionDir: string, appPath: string, signing: { identity: string, mode: string } }} spec
 * @returns {Promise<void>}
 */
async function buildVersionedBundle(spec) {
  const stagedDir = await mkdtemp(join(spec.bundlesDir, ".build-"));
  const stagedApp = join(stagedDir, "MacuseHelper.app");
  try {
    await mkdir(join(stagedApp, "Contents", "MacOS"), { recursive: true, mode: 0o755 });
    await writeFile(join(stagedApp, "Contents", "Info.plist"), infoPlist(spec.version), {
      mode: 0o644,
    });
    await execFileAsync("/usr/bin/xcrun", [
      "swiftc",
      spec.sourcePath,
      "-o",
      join(stagedApp, "Contents", "MacOS", HELPER_EXECUTABLE),
    ]);
    const signArgs = [
      "--force",
      "--sign",
      spec.signing.identity,
      ...(spec.signing.identity === "-" ? [] : ["--options", "runtime"]),
      "--identifier",
      HELPER_BUNDLE_ID,
      stagedApp,
    ];
    await execFileAsync("/usr/bin/codesign", signArgs);
    await chmod(stagedDir, 0o755);
    try {
      await rename(stagedDir, spec.versionDir);
    } catch (error) {
      if (!(await bundleReady(spec.appPath))) {
        throw error;
      }
    }
  } finally {
    await rm(stagedDir, { recursive: true, force: true });
  }
}

/**
 * Create a `0700` session directory keeping `sun_path` within macOS's 104-byte `sockaddr_un` limit.
 * @returns {Promise<{ dir: string, sockPath: string, errPath: string, pidPath: string }>}
 */
async function createSessionDir() {
  const systemTmp = tmpdir();
  const base = Buffer.byteLength(systemTmp) <= 70 ? systemTmp : "/tmp";
  const dir = await mkdtemp(join(base, "mu-"));
  await chmod(dir, 0o700);
  const errPath = join(dir, "err.log");
  await writeFile(errPath, "", { mode: 0o600 });
  return { dir, sockPath: join(dir, "s.sock"), errPath, pidPath: join(dir, "p") };
}

/**
 * @param {string} errPath
 * @returns {string}
 */
function readHelperStderr(errPath) {
  try {
    return readFileSync(errPath, "utf8").trim();
  } catch {
    return "";
  }
}

/**
 * @param {string} pidPath
 * @param {import("node:child_process").ChildProcess} openChild
 * @returns {Promise<void>}
 */
async function killWedgedHelper(pidPath, openChild) {
  const pidText = await readFile(pidPath, "utf8").catch(() => "");
  const helperPid = Number.parseInt(pidText.trim(), 10);
  if (
    Number.isInteger(helperPid) &&
    helperPid > 0 &&
    openChild.exitCode === null &&
    openChild.signalCode === null
  ) {
    try {
      process.kill(helperPid, "SIGKILL");
    } catch {
      /* Already exited. */
    }
  }
  openChild.kill("SIGKILL");
}

/**
 * @param {{ startupAbort: AbortController, timeoutSignal: AbortSignal, startTimeoutMs: number, callerSignal: AbortSignal | undefined, error: unknown }} spec
 * @returns {never}
 */
function rethrowLaunchFailure(spec) {
  if (spec.startupAbort.signal.aborted && spec.startupAbort.signal.reason instanceof Error) {
    throw spec.startupAbort.signal.reason;
  }
  if (spec.timeoutSignal.aborted) {
    throw new Error(`Native helper did not connect within ${spec.startTimeoutMs} ms.`, {
      cause: spec.error,
    });
  }
  if (spec.callerSignal !== undefined && spec.callerSignal.aborted) {
    const reason = /** @type {unknown} */ (spec.callerSignal.reason);
    throw reason instanceof Error ? reason : new Error(String(reason), { cause: spec.error });
  }
  if (spec.error instanceof Error) {
    throw spec.error;
  }
  throw new Error(String(spec.error), { cause: spec.error });
}

/**
 * Launch `MacuseHelper.app` via LaunchServices (`open -g -n -W`) so macOS TCC
 * attributes Accessibility to `com.fitchmultz.macuse.helper` rather than each host app.
 * @param {string} appPath
 * @param {(error: Error, closed?: boolean) => void} onDisconnect
 * @param {{ startTimeoutMs: number, stopGraceMs: number, signal?: AbortSignal | undefined }} options
 * @returns {Promise<HelperSession>}
 */
export async function launchHelperSession(appPath, onDisconnect, options) {
  const { dir, sockPath, errPath, pidPath } = await createSessionDir();
  const server = createServer();
  /** @type {import("node:net").Socket | undefined} */
  let socket;
  const listening = once(server, "listening");
  server.listen(sockPath);
  await listening;
  await chmod(sockPath, 0o600);

  const startupAbort = new AbortController();
  const timeoutSignal = AbortSignal.timeout(options.startTimeoutMs);
  const signals = [startupAbort.signal, timeoutSignal];
  if (options.signal !== undefined) {
    signals.push(options.signal);
  }
  const signal = AbortSignal.any(signals);
  const openChild = spawn(
    "/usr/bin/open",
    ["-g", "-n", "-W", "--stderr", errPath, appPath, "--args", "--connect", sockPath],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let openStderr = "";
  openChild.stderr.on("data", (/** @type {Buffer} */ chunk) => {
    openStderr += chunk.toString();
  });
  const onOpenError = (/** @type {Error} */ error) => startupAbort.abort(error);
  const onOpenExit = (
    /** @type {number | null} */ code,
    /** @type {NodeJS.Signals | null} */ sig,
  ) => {
    const detail = [openStderr.trim(), readHelperStderr(errPath)].filter(Boolean).join(": ");
    startupAbort.abort(
      new Error(
        `LaunchServices failed to open MacuseHelper.app (${sig ?? code ?? "unknown"})${detail !== "" ? `: ${detail}` : ""}.`,
      ),
    );
  };
  openChild.once("error", onOpenError);
  openChild.once("exit", onOpenExit);

  try {
    const connected = await once(server, "connection", { signal });
    const candidate = /** @type {unknown} */ (connected[0]);
    if (!(candidate instanceof Socket)) {
      throw new Error("Native helper server did not yield a socket.");
    }
    socket = candidate;
    server.close();
    openChild.off("error", onOpenError);
    openChild.off("exit", onOpenExit);
    return makeHelperSession({
      socket,
      openChild,
      dir,
      errPath,
      pidPath,
      stopGraceMs: options.stopGraceMs,
      onDisconnect,
    });
  } catch (error) {
    openChild.off("error", onOpenError);
    openChild.off("exit", onOpenExit);
    server.close();
    socket?.destroy();
    await killWedgedHelper(pidPath, openChild);
    await rm(dir, { recursive: true, force: true });
    return rethrowLaunchFailure({
      startupAbort,
      timeoutSignal,
      startTimeoutMs: options.startTimeoutMs,
      callerSignal: options.signal,
      error,
    });
  }
}

/**
 * @param {{ socket: import("node:net").Socket, openChild: import("node:child_process").ChildProcess, dir: string, errPath: string, pidPath: string, stopGraceMs: number, onDisconnect: (error: Error, closed?: boolean) => void }} spec
 * @returns {HelperSession}
 */
function makeHelperSession(spec) {
  let closing = false;
  let notified = false;
  /** @param {string} status @param {Error | null} [socketError] */
  const disconnect = (status, socketError = null) => {
    if (closing || notified) {
      return;
    }
    notified = true;
    const stderr = readHelperStderr(spec.errPath);
    let detail = "";
    if (stderr !== "") {
      detail = `: ${stderr}`;
    } else if (socketError !== null) {
      detail = `: ${socketError.message}`;
    }
    spec.onDisconnect(new Error(`Native helper stopped (${status})${detail}.`), true);
  };
  spec.openChild.once("close", (code, sig) => disconnect(String(sig ?? code ?? "unknown")));
  spec.socket.once("error", (error) => disconnect("socket error", error));
  spec.socket.once("close", () => {
    if (spec.openChild.exitCode !== null || spec.openChild.signalCode !== null) {
      disconnect(String(spec.openChild.signalCode ?? spec.openChild.exitCode ?? "unknown"));
    }
  });
  const close = async () => {
    closing = true;
    const waitClose =
      spec.openChild.exitCode === null && spec.openChild.signalCode === null
        ? once(spec.openChild, "close", { signal: AbortSignal.timeout(spec.stopGraceMs) })
        : null;
    spec.socket.end();
    spec.socket.destroy();
    if (waitClose !== null) {
      try {
        await waitClose;
      } catch {
        await killWedgedHelper(spec.pidPath, spec.openChild);
      }
    }
    await rm(spec.dir, { recursive: true, force: true });
  };
  return { socket: spec.socket, close };
}
