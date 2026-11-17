import { execFile, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
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

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
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
 * @param {string} stampPath
 * @param {string} appPath
 * @param {string} expectedHash
 * @returns {Promise<boolean>}
 */
async function buildCurrent(stampPath, appPath, expectedHash) {
  try {
    const stamp = /** @type {unknown} */ (JSON.parse(await readFile(stampPath, "utf8")));
    if (!isRecord(stamp) || stamp.hash !== expectedHash) {
      return false;
    }
    await stat(join(appPath, "Contents", "Info.plist"));
    await stat(join(appPath, "Contents", "MacOS", HELPER_EXECUTABLE));
    return true;
  } catch {
    return false;
  }
}

/**
 * Compile and code-sign `MacuseHelper.app` when missing or stale.
 * @param {string} sourcePath
 * @param {string} version
 * @returns {Promise<{ appPath: string, bundleId: string, signingMode: string }>}
 */
export async function ensureHelperBundle(sourcePath, version) {
  if (process.platform !== "darwin") {
    throw new Error("Native Accessibility requires macOS");
  }
  const supportDir = helperSupportDir();
  await mkdir(supportDir, { recursive: true, mode: 0o700 });
  const appPath = join(supportDir, "MacuseHelper.app");
  const stampPath = join(supportDir, "helper-build.json");
  const signing = discoverSigningIdentity();
  const buildHash = createHash("sha256")
    .update(await readFile(sourcePath))
    .update(process.arch)
    .update(signing.identity)
    .update(HELPER_BUNDLE_ID)
    .update(version)
    .digest("hex")
    .slice(0, 24);
  if (await buildCurrent(stampPath, appPath, buildHash)) {
    return { appPath, bundleId: HELPER_BUNDLE_ID, signingMode: signing.mode };
  }
  await buildStagedBundle({
    sourcePath,
    version,
    supportDir,
    appPath,
    stampPath,
    signing,
    buildHash,
  });
  return { appPath, bundleId: HELPER_BUNDLE_ID, signingMode: signing.mode };
}

/**
 * @param {{ sourcePath: string, version: string, supportDir: string, appPath: string, stampPath: string, signing: { identity: string, mode: string }, buildHash: string }} spec
 * @returns {Promise<void>}
 */
async function buildStagedBundle(spec) {
  const stagedDir = await mkdtemp(join(spec.supportDir, "MacuseHelper.build-"));
  const staged = join(stagedDir, "MacuseHelper.app");
  try {
    await mkdir(join(staged, "Contents", "MacOS"), { recursive: true, mode: 0o755 });
    await writeFile(join(staged, "Contents", "Info.plist"), infoPlist(spec.version), {
      mode: 0o644,
    });
    await execFileAsync("/usr/bin/xcrun", [
      "swiftc",
      spec.sourcePath,
      "-o",
      join(staged, "Contents", "MacOS", HELPER_EXECUTABLE),
    ]);
    const signArgs = [
      "--force",
      "--sign",
      spec.signing.identity,
      ...(spec.signing.identity === "-" ? [] : ["--options", "runtime"]),
      "--identifier",
      HELPER_BUNDLE_ID,
      staged,
    ];
    await execFileAsync("/usr/bin/codesign", signArgs);
    await rm(spec.appPath, { recursive: true, force: true });
    await rename(staged, spec.appPath);
    await writeFile(
      spec.stampPath,
      JSON.stringify({
        hash: spec.buildHash,
        identity: spec.signing.identity,
        bundleId: HELPER_BUNDLE_ID,
      }),
      { mode: 0o600 },
    );
  } finally {
    await rm(stagedDir, { recursive: true, force: true });
  }
}

/**
 * Create a `0700` socket directory keeping `sun_path` within macOS's 104-byte `sockaddr_un` limit.
 * @returns {Promise<{ dir: string, sockPath: string }>}
 */
async function createSocketDir() {
  const systemTmp = tmpdir();
  const base = Buffer.byteLength(systemTmp) <= 70 ? systemTmp : "/tmp";
  const dir = await mkdtemp(join(base, "mu-"));
  await chmod(dir, 0o700);
  return { dir, sockPath: join(dir, "s.sock") };
}

/**
 * Launch `MacuseHelper.app` via LaunchServices (`open -g -n -W`) so macOS TCC
 * attributes Accessibility to `com.fitchmultz.macuse.helper` rather than each host app.
 * @param {string} appPath
 * @param {(error: Error, closed?: boolean) => void} onDisconnect
 * @param {{ signal?: AbortSignal | undefined }} [options]
 * @returns {Promise<HelperSession>}
 */
export async function launchHelperSession(appPath, onDisconnect, options = {}) {
  const { dir, sockPath } = await createSocketDir();
  const server = createServer();
  /** @type {import("node:net").Socket | undefined} */
  let socket;
  const listening = once(server, "listening");
  server.listen(sockPath);
  await listening;
  await chmod(sockPath, 0o600);

  const startupAbort = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, startupAbort.signal])
    : startupAbort.signal;
  const openChild = spawn(
    "/usr/bin/open",
    ["-g", "-n", "-W", appPath, "--args", "--connect", sockPath],
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
    const detail = openStderr.trim();
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
    return makeHelperSession({ socket, openChild, dir, getStderr: () => openStderr, onDisconnect });
  } catch (error) {
    server.close();
    socket?.destroy();
    openChild.kill("SIGKILL");
    await rm(dir, { recursive: true, force: true });
    const abortReason = /** @type {unknown} */ (
      startupAbort.signal.aborted ? startupAbort.signal.reason : undefined
    );
    if (abortReason instanceof Error) {
      throw abortReason;
    }
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(String(error), { cause: error });
  }
}

/**
 * @param {{ socket: import("node:net").Socket, openChild: import("node:child_process").ChildProcess, dir: string, getStderr: () => string, onDisconnect: (error: Error, closed?: boolean) => void }} spec
 * @returns {HelperSession}
 */
function makeHelperSession(spec) {
  let closing = false;
  spec.socket.once("error", (error) => {
    if (!closing) {
      spec.onDisconnect(error);
    }
  });
  spec.socket.once("close", () => {
    if (!closing) {
      const detail = spec.getStderr().trim();
      spec.onDisconnect(
        new Error(`Native helper stopped${detail !== "" ? `: ${detail}` : ""}.`),
        true,
      );
    }
  });
  const close = async () => {
    closing = true;
    const exited = once(spec.openChild, "close").catch(() => null);
    spec.socket.end();
    spec.socket.destroy();
    if (spec.openChild.exitCode === null && spec.openChild.signalCode === null) {
      await exited;
    }
    await rm(spec.dir, { recursive: true, force: true });
  };
  return { socket: spec.socket, close };
}
