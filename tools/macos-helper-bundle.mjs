import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export const HELPER_BUNDLE_ID = "com.fitchmultz.macuse.helper";
export const HELPER_NAME = "Macuse Helper";
export const HELPER_EXECUTABLE = "MacuseHelper";
const LOCK_STALE_MS = 120_000;
const STARTUP_TIMEOUT_MS = 15_000;

/** @typedef {{ socket: import("node:net").Socket, helperPid: number, bundleId: string | null, accessibilityTrusted: boolean, close: () => Promise<void> }} HelperSession */

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
    timeout: 5000,
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
 * @param {string} lockDir
 * @returns {Promise<() => Promise<void>>}
 */
async function acquireBuildLock(lockDir) {
  const deadline = Date.now() + LOCK_STALE_MS;
  for (;;) {
    try {
      await mkdir(lockDir, { mode: 0o700 });
      return async () => {
        await rm(lockDir, { recursive: true, force: true });
      };
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
      if (code !== "EEXIST") {
        throw error;
      }
      const stats = await stat(lockDir).catch(() => null);
      if (stats !== null && Date.now() - stats.mtimeMs > LOCK_STALE_MS) {
        await rm(lockDir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for helper build lock: ${lockDir}`, { cause: error });
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 100);
      });
    }
  }
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
 * @param {string} command
 * @param {string[]} args
 * @param {string} label
 * @returns {Promise<void>}
 */
function execTool(command, args, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (/** @type {Buffer} */ chunk) => {
      stderr = (stderr + chunk.toString()).slice(-8000);
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${label} failed (exit ${String(code)}): ${stderr.trim()}`));
      }
    });
  });
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
  const release = await acquireBuildLock(join(supportDir, ".helper-build.lock"));
  try {
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
  } finally {
    await release();
  }
}

/**
 * @param {{ sourcePath: string, version: string, supportDir: string, appPath: string, stampPath: string, signing: { identity: string, mode: string }, buildHash: string }} spec
 * @returns {Promise<void>}
 */
async function buildStagedBundle(spec) {
  const staged = join(spec.supportDir, `MacuseHelper.${process.pid}.tmp.app`);
  await rm(staged, { recursive: true, force: true });
  try {
    await mkdir(join(staged, "Contents", "MacOS"), { recursive: true, mode: 0o755 });
    await writeFile(join(staged, "Contents", "Info.plist"), infoPlist(spec.version), {
      mode: 0o644,
    });
    await execTool(
      "/usr/bin/xcrun",
      ["swiftc", spec.sourcePath, "-o", join(staged, "Contents", "MacOS", HELPER_EXECUTABLE)],
      "Native helper compilation",
    );
    const signArgs = [
      "--force",
      "--sign",
      spec.signing.identity,
      ...(spec.signing.identity === "-" ? [] : ["--options", "runtime"]),
      "--identifier",
      HELPER_BUNDLE_ID,
      staged,
    ];
    await execTool("/usr/bin/codesign", signArgs, "Native helper code signing");
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
    await rm(staged, { recursive: true, force: true });
  }
}

/**
 * Create a short `0700` socket directory so macOS `sun_path` (104 bytes) never overflows.
 * @returns {Promise<{ dir: string, sockPath: string, token: string }>}
 */
async function createSocketDir() {
  const systemTmp = tmpdir();
  const base = Buffer.byteLength(systemTmp) <= 70 ? systemTmp : "/tmp";
  const dir = await mkdtemp(join(base, "mu-"));
  await chmod(dir, 0o700);
  const token = randomBytes(16).toString("hex");
  await writeFile(join(dir, "t"), token, { mode: 0o600 });
  return { dir, sockPath: join(dir, "s.sock"), token };
}

/**
 * @param {string} sockPath
 * @returns {Promise<{ server: import("node:net").Server, waitForSocket: () => Promise<import("node:net").Socket> }>}
 */
async function startSocketServer(sockPath) {
  const server = createServer();
  /** @type {(socket: import("node:net").Socket) => void} */
  let onConnection = () => {
    /* replaced immediately by promise executor */
  };
  /** @type {Promise<import("node:net").Socket>} */
  const nextSocket = new Promise((resolve) => {
    onConnection = resolve;
  });
  server.once("connection", (socket) => {
    server.close();
    onConnection(socket);
  });
  /** @type {Promise<void>} */
  const listening = new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(sockPath, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  await listening;
  await chmod(sockPath, 0o600);
  return { server, waitForSocket: () => nextSocket };
}

/**
 * @param {string} line
 * @param {string} expectedToken
 * @returns {{ pid: number, bundleId: string | null, accessibilityTrusted: boolean }}
 */
function parseHandshakeLine(line, expectedToken) {
  const parsed = /** @type {unknown} */ (JSON.parse(line));
  const hello = isRecord(parsed) && isRecord(parsed.hello) ? parsed.hello : undefined;
  if (hello === undefined || hello.token !== expectedToken || typeof hello.pid !== "number") {
    throw new Error("Native helper handshake failed authentication.");
  }
  return {
    pid: hello.pid,
    bundleId: typeof hello.bundleId === "string" ? hello.bundleId : null,
    accessibilityTrusted: hello.accessibilityTrusted === true,
  };
}

/**
 * Read the first newline-delimited handshake JSON from the connecting helper.
 * @param {import("node:net").Socket} socket
 * @param {string} expectedToken
 * @returns {Promise<{ pid: number, bundleId: string | null, accessibilityTrusted: boolean }>}
 */
function readHandshake(socket, expectedToken) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const fail = (/** @type {Error} */ error) => {
      cleanup();
      reject(error);
    };
    const onError = (/** @type {Error} */ error) => fail(error);
    const onClose = () => fail(new Error("Native helper closed before handshake."));
    const onData = (/** @type {Buffer} */ chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline === -1) {
        if (buffer.length > 16_384) {
          fail(new Error("Native helper handshake exceeded size limit."));
        }
        return;
      }
      cleanup();
      const firstLine = buffer.slice(0, newline);
      const rest = buffer.slice(newline + 1);
      if (rest.length > 0) {
        socket.unshift(Buffer.from(rest, "utf8"));
      }
      try {
        resolve(parseHandshakeLine(firstLine, expectedToken));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error), { cause: error }));
      }
    };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

/**
 * @param {number} pid
 * @returns {boolean}
 */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Launch `MacuseHelper.app` via LaunchServices (`open -g -n -W`) so macOS TCC
 * attributes Accessibility to `com.fitchmultz.macuse.helper` rather than each host app.
 * @param {string} appPath
 * @param {(error: Error, closed?: boolean) => void} onDisconnect
 * @returns {Promise<HelperSession>}
 */
export async function launchHelperSession(appPath, onDisconnect) {
  const { dir, sockPath, token } = await createSocketDir();
  const { server, waitForSocket } = await startSocketServer(sockPath);
  const openChild = spawn(
    "/usr/bin/open",
    ["-g", "-n", "-W", appPath, "--args", "--connect", sockPath],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let openStderr = "";
  openChild.stderr.on("data", (/** @type {Buffer} */ chunk) => {
    openStderr = (openStderr + chunk.toString()).slice(-4000);
  });
  try {
    const { socket, hello } = await awaitLaunchHandshake({
      openChild,
      waitForSocket,
      token,
      getStderr: () => openStderr,
    });
    return makeHelperSession({ socket, openChild, dir, hello, onDisconnect });
  } catch (error) {
    server.close();
    openChild.kill("SIGKILL");
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

/**
 * @param {{ openChild: import("node:child_process").ChildProcess, waitForSocket: () => Promise<import("node:net").Socket>, token: string, getStderr: () => string }} spec
 * @returns {Promise<{ socket: import("node:net").Socket, hello: { pid: number, bundleId: string | null, accessibilityTrusted: boolean } }>}
 */
async function awaitLaunchHandshake(spec) {
  /** @type {import("node:net").Socket | undefined} */
  let socket;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  try {
    /** @type {Promise<never>} */
    const abortOpen = new Promise((_resolve, reject) => {
      spec.openChild.once("error", reject);
      spec.openChild.once("exit", (code, signal) => {
        const detail = spec.getStderr().trim();
        reject(
          new Error(
            `LaunchServices failed to open MacuseHelper.app (${signal ?? code ?? "unknown"})${detail !== "" ? `: ${detail}` : ""}.`,
          ),
        );
      });
    });
    /** @type {Promise<never>} */
    const timeout = new Promise((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error("Timed out waiting for MacuseHelper.app to connect.")),
        STARTUP_TIMEOUT_MS,
      );
    });
    socket = await Promise.race([spec.waitForSocket(), abortOpen, timeout]);
    const hello = await Promise.race([readHandshake(socket, spec.token), abortOpen, timeout]);
    return { socket, hello };
  } catch (error) {
    socket?.destroy();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {{ socket: import("node:net").Socket, openChild: import("node:child_process").ChildProcess, dir: string, hello: { pid: number, bundleId: string | null, accessibilityTrusted: boolean }, onDisconnect: (error: Error, closed?: boolean) => void }} spec
 * @returns {HelperSession}
 */
function makeHelperSession(spec) {
  let openStderr = "";
  spec.openChild.stderr?.on("data", (/** @type {Buffer} */ chunk) => {
    openStderr = (openStderr + chunk.toString()).slice(-4000);
  });
  let closing = false;
  spec.socket.once("error", (error) => {
    if (!closing) {
      spec.onDisconnect(error);
    }
  });
  spec.socket.once("close", () => {
    if (!closing) {
      spec.onDisconnect(
        new Error(
          `Native helper stopped${openStderr.trim() !== "" ? `: ${openStderr.trim()}` : ""}.`,
        ),
        true,
      );
    }
  });
  const close = async () => {
    closing = true;
    /** @type {Promise<void>} */
    const exited = new Promise((resolve) => {
      if (spec.openChild.exitCode !== null || spec.openChild.signalCode !== null) {
        resolve();
        return;
      }
      const killTimer = setTimeout(() => {
        if (pidAlive(spec.hello.pid)) {
          try {
            process.kill(spec.hello.pid, "SIGKILL");
          } catch {
            /* Already gone. */
          }
        }
        spec.openChild.kill("SIGKILL");
        resolve();
      }, 1000);
      spec.openChild.once("close", () => {
        clearTimeout(killTimer);
        resolve();
      });
    });
    spec.socket.end();
    spec.socket.destroy();
    await exited;
    await rm(spec.dir, { recursive: true, force: true });
  };
  return {
    socket: spec.socket,
    helperPid: spec.hello.pid,
    bundleId: spec.hello.bundleId,
    accessibilityTrusted: spec.hello.accessibilityTrusted,
    close,
  };
}
