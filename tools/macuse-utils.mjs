import { spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const TOOLS_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(TOOLS_DIR, "..");

/** Canonical package version. Single source of truth; read from package.json once. */
export const VERSION = (() => {
  try {
    const pkg = /** @type {unknown} */ (
      JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf8"))
    );
    if (typeof pkg === "object" && pkg !== null && "version" in pkg) {
      const version = pkg.version;
      if (typeof version === "string") return version;
    }
  } catch {
    // Fall through; readFileSync failure is unrecoverable for a tool run from the repo.
  }
  throw new Error(`macuse: could not read version from ${resolve(REPO_ROOT, "package.json")}`);
})();
export const DEFAULT_CHATGPT_RESOURCES = "/Applications/ChatGPT.app/Contents/Resources";
const DEFAULT_BUNDLED_PLUGIN_ROOT = resolve(
  DEFAULT_CHATGPT_RESOURCES,
  "plugins/openai-bundled/plugins",
);
export const DEFAULT_BUNDLED_COMPUTER_USE_PLUGIN_DIR = resolve(
  DEFAULT_BUNDLED_PLUGIN_ROOT,
  "computer-use",
);
const DEFAULT_BUNDLED_RECORD_AND_REPLAY_PLUGIN_DIR = resolve(
  DEFAULT_BUNDLED_PLUGIN_ROOT,
  "record-and-replay",
);
const DEFAULT_BUNDLED_COMPUTER_HISTORY_PLUGIN_DIR = resolve(
  DEFAULT_BUNDLED_PLUGIN_ROOT,
  "computer-history",
);
const envCodexHome = process.env.CODEX_HOME;
export const DEFAULT_CODEX_HOME =
  envCodexHome !== undefined && envCodexHome !== "" ? envCodexHome : resolve(homedir(), ".codex");
// Plugin no longer embeds the app; use the installed client under $CODEX_HOME/computer-use.
export const DEFAULT_COMPUTER_USE_PLUGIN_ROOT = resolve(
  DEFAULT_CODEX_HOME,
  "plugins/cache/openai-bundled/computer-use",
);
export const DEFAULT_COMPUTER_USE_APP = resolve(
  DEFAULT_CODEX_HOME,
  "computer-use/Codex Computer Use.app",
);
export const DEFAULT_BUNDLED_COMPUTER_USE_CLIENT = resolve(
  DEFAULT_COMPUTER_USE_APP,
  "Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient",
);
export const DEFAULT_COMPUTER_USE_CLIENT_CWD = dirname(DEFAULT_BUNDLED_COMPUTER_USE_CLIENT);
export const DEFAULT_COMPUTER_USE_PLUGIN_DIR = discoverComputerUsePluginDir();
export const MCP_SERVERS = Object.freeze({
  "computer-use": {
    pluginDir: DEFAULT_BUNDLED_COMPUTER_USE_PLUGIN_DIR,
    args: ["mcp"],
    tools: [
      "click",
      "drag",
      "get_app_state",
      "list_apps",
      "perform_secondary_action",
      "press_key",
      "scroll",
      "select_text",
      "set_value",
      "type_text",
    ],
  },
  "event-stream": {
    pluginDir: DEFAULT_BUNDLED_RECORD_AND_REPLAY_PLUGIN_DIR,
    args: ["event-stream", "mcp"],
    tools: ["event_stream_start", "event_stream_status", "event_stream_stop"],
  },
  "computer-history": {
    pluginDir: DEFAULT_BUNDLED_COMPUTER_HISTORY_PLUGIN_DIR,
    args: ["computer-history", "mcp"],
    tools: [
      "computer_history_get_settings",
      "computer_history_pause",
      "computer_history_resume",
      "computer_history_status",
      "computer_history_update_settings",
    ],
  },
});
export const COMPUTER_USE_TOOL_NAMES = MCP_SERVERS["computer-use"].tools;

/**
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compareVersionLike(a, b) {
  const aa = a
    .split(/[^0-9]+/)
    .filter(Boolean)
    .map(Number);
  const bb = b
    .split(/[^0-9]+/)
    .filter(Boolean)
    .map(Number);
  for (let i = 0; i < Math.max(aa.length, bb.length); i += 1) {
    const delta = (aa[i] ?? 0) - (bb[i] ?? 0);
    if (delta !== 0) return delta;
  }
  return a.localeCompare(b);
}

/** @type {("computer-use" | "event-stream" | "computer-history")[]} */
const serverNames = ["computer-use", "event-stream", "computer-history"];

/**
 * @param {string} tool
 * @returns {"computer-use" | "event-stream" | "computer-history"}
 */
export function mcpServerForTool(tool) {
  for (const name of serverNames) if (MCP_SERVERS[name].tools.includes(tool)) return name;
  throw new Error(`Unsupported upstream Computer Use tool: ${tool}`);
}

export function mcpServerConfigs() {
  return Object.fromEntries(
    Object.entries(MCP_SERVERS).map(([name, server]) => [
      name,
      {
        command: resolve(server.pluginDir, "bin/computer-use-client-launcher"),
        args: server.args,
        cwd: server.pluginDir,
        env_vars: ["CODEX_HOME"],
        enabled: true,
      },
    ]),
  );
}

/**
 * @param {string} [root]
 * @param {{ fallback?: boolean }} [opts]
 * @returns {string | null}
 */
export function discoverComputerUsePluginDir(root = DEFAULT_COMPUTER_USE_PLUGIN_ROOT, opts = {}) {
  try {
    const entries = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort(compareVersionLike)
      .reverse();
    const found = entries.find((entry) => existsSync(resolve(root, entry, ".mcp.json")));
    if (found !== undefined) return resolve(root, found);
  } catch {
    // Fall back to latest path observed when this helper was updated.
  }
  return opts.fallback === false ? null : DEFAULT_BUNDLED_COMPUTER_USE_PLUGIN_DIR;
}

/**
 * @param {Date} [date]
 * @returns {string}
 */
export function nowIsoForPath(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

/**
 * @param {string} path
 * @returns {void}
 */
export function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

/**
 * @param {string} path
 * @param {unknown} value
 * @returns {void}
 */
export function writeJsonFile(path, value) {
  ensureDir(dirname(path));
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Parsed JSON is untrusted until the caller validates it.
 * @param {string} path
 * @returns {unknown}
 */
export function readJsonFile(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * @param {string} path
 * @returns {boolean}
 */
export function isExecutable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} path
 * @returns {boolean}
 */
export function fileExists(path) {
  return existsSync(path);
}

/**
 * First nonempty text value, or null. Preserves the explicit `||` fallback order
 * for null and empty-string values.
 * @param {(string | null | undefined)[]} values
 * @returns {string | null}
 */
export const firstText = (values) =>
  values.find((value) => typeof value === "string" && value.length > 0) ?? null;

/**
 * Normalize spawn output. Node types declare stdout/stderr as strings, but a
 * failed spawn returns undefined at runtime.
 * @param {string | undefined} value
 * @returns {string}
 */
const spawnText = (value) => value ?? "";

/**
 * @param {string} name
 * @param {string} command
 * @param {string[]} [args]
 * @param {import("./macuse-utils.mjs").RunCommandOptions} [opts]
 * @returns {import("./macuse-utils.mjs").RunCommandResult}
 */
export function runCommand(name, command, args = [], opts = {}) {
  const started = Date.now();
  const cwd = opts.cwd ?? REPO_ROOT;
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...opts.env },
    encoding: "utf8",
    input: opts.input,
    timeout: opts.timeoutMs ?? 120_000,
    maxBuffer: opts.maxBuffer ?? 20 * 1024 * 1024,
  });
  return {
    name,
    command,
    args,
    cwd,
    durationMs: Date.now() - started,
    status: result.status,
    signal: result.signal,
    error: result.error ? result.error.message : null,
    stdout: spawnText(result.stdout),
    stderr: spawnText(result.stderr),
    ok: !result.error && result.status === 0,
  };
}

/**
 * @param {string} name
 * @param {string} command
 * @param {string[]} [args]
 * @param {import("./macuse-utils.mjs").RunCommandOptions} [opts]
 * @returns {import("./macuse-utils.mjs").RunCommandResult}
 */
export function mustRun(name, command, args = [], opts = {}) {
  const result = runCommand(name, command, args, opts);
  if (!result.ok) {
    const detail =
      firstText([result.error, result.stderr, result.stdout]) ?? `exit ${String(result.status)}`;
    throw new Error(`${name} failed: ${detail.trim().slice(0, 2000)}`);
  }
  return result;
}

/**
 * @param {string} label
 * @param {string} text
 * @returns {unknown}
 */
export function parseJsonOutput(label, text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} returned invalid JSON: ${reason}\n${text.slice(0, 1000)}`, {
      cause: error,
    });
  }
}

/**
 * @returns {{ asn: string, bundleId: string | null, name: string | null } | null}
 */
export function frontmostApp() {
  const front = runCommand("frontmost asn", "/usr/bin/lsappinfo", ["front"], { timeoutMs: 5000 });
  if (!front.ok || front.stdout.trim().length === 0) return null;
  const asn = front.stdout.trim();
  const bundle = runCommand(
    "frontmost bundle id",
    "/usr/bin/lsappinfo",
    ["info", "-only", "bundleid", asn],
    { timeoutMs: 5000 },
  );
  const name = runCommand("frontmost name", "/usr/bin/lsappinfo", ["info", "-only", "name", asn], {
    timeoutMs: 5000,
  });
  return {
    asn,
    bundleId: (bundle.stdout.match(/="([^"]+)"/) ?? [])[1] ?? null,
    name: (name.stdout.match(/="([^"]+)"/) ?? [])[1] ?? null,
  };
}

/**
 * @returns {{ x: number, y: number } | null}
 */
export function mousePosition() {
  const script =
    "import CoreGraphics; if let e = CGEvent(source: nil) { let p = e.location; print(Int(p.x), Int(p.y)) }";
  const result = runCommand("mouse position", "swift", ["-e", script], { timeoutMs: 10_000 });
  if (!result.ok) return null;
  const [x, y] = result.stdout
    .trim()
    .split(/\s+/)
    .map((value) => Number(value));
  if (typeof x !== "number" || !Number.isFinite(x) || typeof y !== "number" || !Number.isFinite(y))
    return null;
  return { x, y };
}

/**
 * @param {string} path
 * @returns {string}
 */
export function sha256File(path) {
  const hash = createHash("sha256");
  hash.update(readFileSync(path));
  return hash.digest("hex");
}

/**
 * @param {string} path
 * @returns {{ path: string, bytes: number, sha256: string, width: number | null, height: number | null } | null}
 */
export function imageInfo(path) {
  if (!existsSync(path)) return null;
  const result = runCommand("image info", "sips", ["-g", "pixelWidth", "-g", "pixelHeight", path], {
    timeoutMs: 10_000,
  });
  const width = Number((result.stdout.match(/pixelWidth:\s*(\d+)/) || [])[1]);
  const height = Number((result.stdout.match(/pixelHeight:\s*(\d+)/) || [])[1]);
  return {
    path: resolve(path),
    bytes: readFileSync(path).byteLength,
    sha256: sha256File(path),
    width: Number.isFinite(width) ? width : null,
    height: Number.isFinite(height) ? height : null,
  };
}

/** @typedef {{ content?: Array<{ type?: unknown, text?: unknown }> } | null | undefined} ToolTextSource */
/**
 * @param {ToolTextSource} result
 * @returns {string}
 */
export function toolText(result) {
  return (result?.content || [])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

/**
 * @param {{ result?: ToolTextSource } | null | undefined} step
 * @returns {string}
 */
export function stepText(step) {
  return toolText(step?.result);
}

/**
 * Render any report cell value as text. Primitives keep their String()
 * representation; composite values render as JSON instead of `[object Object]`.
 * @param {unknown} value
 * @returns {string}
 */
function cellText(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint")
    return String(value);
  try {
    const json = /** @type {unknown} */ (JSON.stringify(value));
    return typeof json === "string" ? json : "[object]";
  } catch {
    return "[object]";
  }
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function markdownEscape(value) {
  return cellText(value).replace(/\|/g, "\\|").replace(/\n/g, "<br>");
}

/**
 * @param {unknown[]} headers
 * @param {unknown[][]} rows
 * @returns {string}
 */
export function markdownTable(headers, rows) {
  const header = `| ${headers.map(markdownEscape).join(" | ")} |`;
  const sep = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) => `| ${row.map(markdownEscape).join(" | ")} |`);
  return [header, sep, ...body].join("\n");
}

/**
 * @param {string} command
 * @param {string[]} [args]
 * @returns {string}
 */
export function commandLine(command, args = []) {
  return [command, ...args]
    .map((part) => (/^[A-Za-z0-9_./:=@-]+$/.test(part) ? part : JSON.stringify(part)))
    .join(" ");
}
