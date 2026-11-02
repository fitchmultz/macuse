import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { GUI_METHODS } from "./cua-guard-service.mjs";
import { VERSION } from "../tools/macuse-utils.mjs";
import { resolveVendorCodex, vendorResources } from "./vendor-installation.mjs";

/** @typedef {import("@modelcontextprotocol/sdk/client/index.js").Client} McpClient */
/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
/** @returns {null} */
const ignoreRejection = () => null;
const libPath = dirname(fileURLToPath(import.meta.url));

export async function resolveLaunch({
  cwd = process.cwd(),
  resourcesPath = vendorResources(),
} = {}) {
  const resources = resolve(resourcesPath);
  const root = join(resources, "cua_node");
  const manifest = /** @type {unknown} */ (
    JSON.parse(await readFile(join(root, "manifest.json"), "utf8"))
  );
  if (!isRecord(manifest)) {
    throw new Error("cua_node manifest.json is malformed.");
  }
  const modules = resolve(root, String(manifest.node_modules));
  const node = resolve(root, String(manifest.node_path));
  const repl = resolve(root, String(manifest.node_repl_path));
  const packageRoot = join(modules, "@oai", "cua-repl");
  const pkg = /** @type {unknown} */ (
    JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"))
  );
  if (!isRecord(pkg)) {
    throw new Error("@oai/cua-repl package.json is malformed.");
  }
  const bin = isRecord(pkg.bin) ? pkg.bin["cua-repl"] : undefined;
  if (typeof bin !== "string") {
    throw new Error("@oai/cua-repl package.json is missing the cua-repl bin entry.");
  }
  const require = createRequire(join(modules, "@oai", "sky", "package.json"));
  return {
    command: node,
    args: [resolve(packageRoot, bin)],
    cwd,
    env: {
      ...getDefaultEnvironment(),
      CODEX_HOME: process.env.CODEX_HOME ?? join(homedir(), ".codex"),
      CODEX_CLI_PATH: resolveVendorCodex(resources).path,
      CUA_REPL_NODE_REPL_PATH: repl,
      CUA_REPL_ENABLED_SURFACES: "computer",
      NODE_REPL_NODE_PATH: node,
      NODE_REPL_NODE_MODULE_DIRS: modules,
      NODE_REPL_TRUSTED_CODE_PATHS: `${libPath}:${modules}`,
      NODE_REPL_TRUSTED_SERVICES: JSON.stringify({
        sky: pathToFileURL(join(libPath, "cua-guard-service.mjs")).href,
      }),
      MACUSE_SKY_SERVICE_URL: pathToFileURL(require.resolve("@oai/sky/service")).href,
    },
  };
}

/**
 * @param {unknown} params
 * @returns {boolean}
 */
function isExactAppScope(params) {
  return (
    isRecord(params) &&
    typeof params.app === "string" &&
    params.app.length > 0 &&
    Object.keys(params).length === 1
  );
}

/**
 * @param {{ params: { _meta?: Record<string, unknown> | undefined } }} request
 * @returns {{ action: "accept" | "decline" } & Record<string, unknown>}
 */
export function appApproval(request) {
  const meta = request.params._meta;
  const toolParams =
    meta !== undefined && isRecord(meta.tool_params) ? meta.tool_params : undefined;
  const allowed =
    meta?.connector_id === "computer-use" &&
    meta.codex_approval_kind === "mcp_tool_call" &&
    typeof meta.tool_name === "string" &&
    ["get_app_state", ...GUI_METHODS].includes(meta.tool_name) &&
    isExactAppScope(toolParams);
  return { action: allowed ? "accept" : "decline", ...(allowed ? { content: {} } : {}) };
}

/**
 * @param {{ cwd?: string | undefined, resourcesPath?: string | undefined }} options
 * @param {(event: unknown) => void} onDiagnostic
 * @returns {Promise<McpClient>}
 */
export async function connectNative(options, onDiagnostic) {
  const transport = new StdioClientTransport({ ...(await resolveLaunch(options)), stderr: "pipe" });
  let pending = "";
  const stderr = transport.stderr;
  if (stderr === null) {
    throw new Error("Stdio transport did not expose a stderr stream.");
  }
  stderr.on("data", (/** @type {Buffer} */ chunk) => {
    pending += chunk.toString();
    let end;
    while ((end = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      if (!line.startsWith("MACUSE_CUA_EVENT ")) {
        continue;
      }
      try {
        onDiagnostic(/** @type {unknown} */ (JSON.parse(line.slice("MACUSE_CUA_EVENT ".length))));
      } catch {
        /* Diagnostic text is never authority. */
      }
    }
    if (pending.length > 64_000) {
      pending = "";
    }
  });
  const client = new Client(
    { name: "macuse", version: VERSION },
    { capabilities: { elicitation: { form: {} } } },
  );
  client.setRequestHandler(ElicitRequestSchema, appApproval);
  try {
    await client.connect(transport, { timeout: 30_000 });
  } catch (error) {
    await client.close().catch(ignoreRejection);
    throw error;
  }
  return client;
}
