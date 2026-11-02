import { randomUUID } from "node:crypto";
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
import { GUI_METHODS, validateEnvelope } from "./cua-guard-service.mjs";
import { CUA_REQUEST_GRACE_MS, MAX_CUA_TIMEOUT_MS } from "./cua-timeout.mjs";
import { VERSION } from "../tools/macuse-utils.mjs";
import { resolveVendorCodex, vendorResources } from "./vendor-installation.mjs";

/**
 * @param {boolean} unknown
 * @param {boolean} isError
 * @returns {string}
 */
const runStatus = (unknown, isError) => {
  if (unknown) return "unknown";
  return isError ? "failed" : "completed";
};

const inspectAdvice =
  "Execution stopped. A dispatched GUI effect may still have occurred. Inspect fresh app state before continuing; do not automatically replay this code.";
const libPath = dirname(fileURLToPath(import.meta.url));

/**
 * @typedef {import("@modelcontextprotocol/sdk/client/index.js").Client} McpClient
 * The completed form of a client callTool response. The SDK validates the
 * wire result against its schemas before this code sees it.
 * @typedef {{ [key: string]: unknown, content: import("@modelcontextprotocol/sdk/types.js").ContentBlock[], isError?: boolean | undefined, _meta?: Record<string, unknown> | undefined }} CallToolResult
 * The full union a client callTool can resolve to.
 * @typedef {Awaited<ReturnType<McpClient["callTool"]>>} CallToolResponse
 * @typedef {import("./cua-guard-service.mjs").GuardAction} GuardAction
 * @typedef {import("./app-state.mjs").AppObservation} AppObservation
 * @typedef {import("./app-state.mjs").AppElement} AppElement
 * The in-flight guest run bookkeeping.
 * @typedef {{ runId: string, onUpdate: ((result: unknown) => void) | undefined, provisionalActions: unknown[], call?: Promise<CallToolResponse> | undefined, interrupted?: string | undefined }} ActiveRun
 * Trusted guard-service run metadata after its JSON-RPC round trip.
 * @typedef {{ runId: string, actions: GuardAction[], observations: AppObservation[], resolvedApps?: Record<string, string> | undefined, [key: string]: unknown }} GuardRunMeta
 * One macuse tool result content block.
 * @typedef {{ type: string, text?: string | undefined, data?: string | undefined, mimeType?: string | undefined, [key: string]: unknown }} ResultBlock
 * The macuse tool result returned to the host.
 * @typedef {{ content: ResultBlock[], isError: boolean, details: { macuse: { runId: string, status: string, actions: GuardAction[], observations: AppObservation[], kernelReset: boolean, images: Record<string, unknown>[], [key: string]: unknown } } }} MacuseToolResult
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
/**
 * Deliberately swallowed rejections for best-effort cleanup paths.
 * @returns {null}
 */
const ignoreRejection = () => null;
/**
 * @param {unknown} value
 * @returns {value is unknown[]}
 */
const isUnknownArray = (value) => Array.isArray(value);

/**
 * Structural re-validation of trusted guard metadata after its JSON-RPC round
 * trip. The producer is our own guard service; inner action/observation fields
 * keep their producer types.
 * @param {unknown} value
 * @returns {value is GuardRunMeta}
 */
const isGuardRunMeta = (value) =>
  isRecord(value) &&
  typeof value.runId === "string" &&
  isUnknownArray(value.actions) &&
  isUnknownArray(value.observations) &&
  value.observations.every(
    (observation) => isRecord(observation) && typeof observation.app === "string",
  ) &&
  (value.resolvedApps === undefined || isRecord(value.resolvedApps));

/**
 * @param {unknown} value
 * @returns {value is CallToolResult}
 */
const isCallToolResult = (value) =>
  isRecord(value) &&
  isUnknownArray(value.content) &&
  value.content.every((block) => isRecord(block) && typeof block.type === "string");

/**
 * @param {CallToolResult | undefined} result
 * @returns {GuardRunMeta | undefined}
 */
const runMeta = (result) => {
  const meta = isRecord(result?._meta) ? result._meta.macuse : undefined;
  return isGuardRunMeta(meta) ? meta : undefined;
};

export async function resolveLaunch({
  cwd = process.cwd(),
  resourcesPath = vendorResources(),
} = {}) {
  const resources = resolve(resourcesPath);
  const root = join(resources, "cua_node");
  const manifest = /** @type {unknown} */ (
    JSON.parse(await readFile(join(root, "manifest.json"), "utf8"))
  );
  if (!isRecord(manifest)) throw new Error("cua_node manifest.json is malformed.");
  const modules = resolve(root, String(manifest.node_modules));
  const node = resolve(root, String(manifest.node_path));
  const repl = resolve(root, String(manifest.node_repl_path));
  const packageRoot = join(modules, "@oai", "cua-repl");
  const pkg = /** @type {unknown} */ (
    JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"))
  );
  if (!isRecord(pkg)) throw new Error("@oai/cua-repl package.json is malformed.");
  const bin = isRecord(pkg.bin) ? pkg.bin["cua-repl"] : undefined;
  if (typeof bin !== "string")
    throw new Error("@oai/cua-repl package.json is missing the cua-repl bin entry.");
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
    toolParams !== undefined &&
    typeof toolParams.app === "string" &&
    toolParams.app.length > 0 &&
    Object.keys(toolParams).length === 1;
  return { action: allowed ? "accept" : "decline", ...(allowed ? { content: {} } : {}) };
}

/**
 * @param {{ cwd?: string | undefined, resourcesPath?: string | undefined }} options
 * @param {(event: unknown) => void} onDiagnostic
 * @returns {Promise<McpClient>}
 */
async function connectNative(options, onDiagnostic) {
  const transport = new StdioClientTransport({ ...(await resolveLaunch(options)), stderr: "pipe" });
  let pending = "";
  const stderr = transport.stderr;
  if (stderr === null) throw new Error("Stdio transport did not expose a stderr stream.");
  stderr.on("data", (/** @type {Buffer} */ chunk) => {
    pending += chunk.toString();
    let end;
    while ((end = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      if (!line.startsWith("MACUSE_CUA_EVENT ")) continue;
      try {
        onDiagnostic(/** @type {unknown} */ (JSON.parse(line.slice("MACUSE_CUA_EVENT ".length))));
      } catch {
        /* Diagnostic text is never authority. */
      }
    }
    if (pending.length > 64_000) pending = "";
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

// Read actual file signatures. Native macOS captures can be JPEG labelled image/png.
/**
 * @param {string} data
 * @returns {{ mimeType?: string | undefined, width?: number | undefined, height?: number | undefined }}
 */
export function imageMetadata(data) {
  const bytes = Buffer.from(data, "base64");
  if (
    bytes.length >= 24 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    bytes.toString("ascii", 12, 16) === "IHDR"
  ) {
    return { mimeType: "image/png", width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    for (let i = 2; i + 3 < bytes.length;) {
      if (bytes[i++] !== 0xff) break;
      while (bytes[i] === 0xff) i++;
      const marker = bytes[i++];
      if (marker === undefined) break;
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (i + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(i);
      if (length < 2 || i + length > bytes.length) break;
      if (
        [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
          marker,
        ) &&
        length >= 8
      ) {
        return {
          mimeType: "image/jpeg",
          width: bytes.readUInt16BE(i + 5),
          height: bytes.readUInt16BE(i + 3),
        };
      }
      i += length;
    }
    return { mimeType: "image/jpeg" };
  }
  if (bytes.length >= 10 && /^GIF8[79]a$/.test(bytes.toString("ascii", 0, 6)))
    return { mimeType: "image/gif", width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  if (
    bytes.length >= 20 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  ) {
    const kind = bytes.toString("ascii", 12, 16);
    if (kind === "VP8X" && bytes.length >= 30)
      return {
        mimeType: "image/webp",
        width: bytes.readUIntLE(24, 3) + 1,
        height: bytes.readUIntLE(27, 3) + 1,
      };
    if (kind === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f)
      return {
        mimeType: "image/webp",
        width: 1 + ((((bytes[22] ?? 0) & 0x3f) << 8) | (bytes[21] ?? 0)),
        height:
          1 +
          ((((bytes[24] ?? 0) & 0x0f) << 10) | ((bytes[23] ?? 0) << 2) | ((bytes[22] ?? 0) >> 6)),
      };
    if (
      kind === "VP8 " &&
      bytes.length >= 30 &&
      bytes.subarray(23, 26).equals(Buffer.from([0x9d, 1, 0x2a]))
    )
      return {
        mimeType: "image/webp",
        width: bytes.readUInt16LE(26) & 0x3fff,
        height: bytes.readUInt16LE(28) & 0x3fff,
      };
    return { mimeType: "image/webp" };
  }
  return {};
}

export class CuaRuntime {
  /** @type {McpClient | undefined} */
  client = undefined;
  /** @type {ActiveRun | undefined} */
  active = undefined;
  /** @type {Promise<void> | undefined} */
  resetting = undefined;
  /** @type {Promise<McpClient> | undefined} */
  connecting = undefined;

  /**
   * @param {{ cwd?: string | undefined, resourcesPath?: string | undefined, connect?: typeof connectNative }} [options]
   */
  constructor({ cwd, resourcesPath, connect = connectNative } = {}) {
    this.options = { cwd, resourcesPath };
    this.connect = connect;
    /** @type {Map<string, AppObservation>} */
    this.observations = new Map();
    /** @type {Map<string, string>} */
    this.resolvedApps = new Map();
    this.invalidated = new Set();
    /** @type {Promise<null | void>} */
    this.tail = Promise.resolve();
    this.kernelResets = 0;
    this.generation = 0;
  }

  status() {
    return {
      connected: Boolean(this.client),
      running: Boolean(this.active),
      resetting: Boolean(this.resetting),
      runId: this.active?.runId,
      kernelResets: this.kernelResets,
    };
  }
  /**
   * @param {string} app
   * @returns {AppObservation | undefined}
   */
  getObservation(app) {
    return this.observations.get(this.resolvedApps.get(app) ?? app);
  }
  /**
   * @param {string} app
   * @returns {void}
   */
  invalidateObservation(app) {
    const canonical = this.resolvedApps.get(app) ?? app;
    this.observations.delete(canonical);
    this.invalidated.add(canonical);
  }

  /**
   * @returns {Promise<McpClient>}
   */
  async connection() {
    this.connecting ??= this.connect(this.options, (/** @type {unknown} */ event) => {
      const active = this.active;
      if (!active || !isRecord(event) || event.runId !== active.runId) return;
      // stderr can contain guest text: retain it only as explicitly provisional evidence.
      active.provisionalActions.push(event);
      if (active.provisionalActions.length > 100) active.provisionalActions.shift();
      try {
        active.onUpdate?.({
          content: [],
          isError: false,
          details: {
            macuse: {
              runId: active.runId,
              status: "running",
              provisionalActions: [...active.provisionalActions],
            },
          },
        });
      } catch {
        /* UI callbacks must not interrupt dispatch tracking. */
      }
    })
      .then((/** @type {McpClient} */ client) => {
        this.client = client;
        return client;
      })
      .catch((/** @type {unknown} */ error) => {
        this.connecting = undefined;
        throw error;
      });
    return this.connecting;
  }

  /**
   * @param {unknown} input
   * @param {{ signal?: AbortSignal | undefined, onUpdate?: ((result: unknown) => void) | undefined }} [options]
   * @returns {Promise<MacuseToolResult>}
   */
  execute(input, { signal, onUpdate } = {}) {
    validateEnvelope(input);
    if (typeof input.code !== "string" || input.code.trim() === "")
      throw new TypeError("code must be a nonempty string.");
    const timeoutMs = input.timeoutMs;
    if (
      timeoutMs !== undefined &&
      (typeof timeoutMs !== "number" ||
        !Number.isSafeInteger(timeoutMs) ||
        timeoutMs < 1 ||
        timeoutMs > MAX_CUA_TIMEOUT_MS)
    )
      throw new TypeError(`timeoutMs must be an integer from 1 to ${MAX_CUA_TIMEOUT_MS}.`);
    // Copy the envelope before queuing; caller changes cannot widen an admitted run.
    const saved = structuredClone(input);
    const generation = this.generation;
    const task = this.tail.then(() => this.run(saved, signal, onUpdate, generation));
    this.tail = task.then(
      () => null,
      () => null,
    );
    return task;
  }

  /**
   * @param {import("./cua-guard-service.mjs").MacuseEnvelope} input
   * @param {AbortSignal | undefined} signal
   * @param {((result: unknown) => void) | undefined} onUpdate
   * @param {number} generation
   * @returns {Promise<MacuseToolResult>}
   */
  async run(input, signal, onUpdate, generation) {
    await this.resetting?.catch(ignoreRejection);
    const runId = randomUUID();
    /** @type {ActiveRun} */
    const active = { runId, onUpdate, provisionalActions: [] };
    /** @type {CallToolResult | undefined} */
    let result;
    /** @type {string | undefined} */
    let failure;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    const abort = () => {
      this.interrupt("aborted").catch(ignoreRejection);
    };
    /**
     * Abort state can flip during awaits, so re-read it through a helper on
     * every check instead of trusting stale narrowing.
     * @param {AbortSignal | undefined} signal
     * @returns {boolean}
     */
    const aborted = (signal) => signal?.aborted === true;
    try {
      if (aborted(signal) || generation !== this.generation)
        throw new Error("Execution aborted before dispatch.");
      const client = await this.connection();
      await this.resetting;
      if (aborted(signal) || generation !== this.generation)
        throw new Error("Execution aborted before dispatch.");
      this.active = active;
      const { code, timeoutMs, ...gates } = input;
      const timeout = typeof timeoutMs === "number" ? timeoutMs : 90_000;
      active.call = client.callTool(
        {
          name: "js",
          arguments: { code, timeout_ms: timeout },
          _meta: { macuse: { ...gates, runId, invalidatedApps: [...this.invalidated] } },
        },
        undefined,
        { timeout: timeout + CUA_REQUEST_GRACE_MS },
      );
      signal?.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => {
        this.interrupt("timeout").catch(ignoreRejection);
      }, timeout + 100);
      const response = await active.call;
      if (!isCallToolResult(response)) throw new Error("Native service returned no tool result.");
      result = response;
      const text = result.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      // Completed guest errors include an execution duration, even when their text says "timeout".
      if (
        result.isError === true &&
        result._meta?.["codex/nodeReplExecutionDurationMs"] === undefined &&
        /timed?\s*out|timeout|kernel.{0,30}reset|reset.{0,30}kernel/i.test(text)
      )
        await this.interrupt("timeout");
      else {
        const meta = runMeta(result);
        if (
          ((meta === undefined || meta.runId !== runId) && input.allowMutating === true) ||
          (meta?.actions ?? []).some(
            (action) =>
              action.dispatched &&
              action.outcome === "unknown" &&
              (action.error === undefined || action.error === ""),
          )
        ) {
          await this.interrupt("unsettled-action");
        }
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      if (active.call) {
        await this.interrupt("connection-failure").catch(ignoreRejection);
        await this.closeConnection();
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      await this.resetting?.catch((/** @type {unknown} */ error) => {
        if (failure === undefined && error instanceof Error) failure = error.message;
      });
      if (this.active === active) this.active = undefined;
    }
    const reported = runMeta(result);
    const meta = reported !== undefined && reported.runId === runId ? reported : undefined;
    const actions = meta?.actions ?? [];
    const lostExecution = Boolean(
      active.call &&
      ((failure !== undefined && failure !== "") || active.interrupted !== undefined),
    );
    const unknown =
      lostExecution ||
      actions.some((action) => action.outcome === "unknown") ||
      Boolean(active.call && input.allowMutating === true && !meta);
    const isError =
      (failure !== undefined && failure !== "") ||
      result?.isError === true ||
      unknown ||
      actions.some((action) => action.error !== undefined && action.error !== "");
    /** @type {Record<string, unknown>[]} */
    const images = [];
    const failed = result?.isError === true;
    const content = (result?.content ?? [])
      .filter((block) => ["text", "image"].includes(block.type))
      .map((block, index) => {
        const current = block;
        if (current.type === "text") {
          current.text = failed
            ? current.text.replace(
                /\b(?:please\s+)?rerun your request[^\n.]*(?:\.|$)/gi,
                inspectAdvice,
              )
            : current.text;
          return current;
        }
        if (current.type !== "image") return current;
        const metadata = imageMetadata(current.data);
        images.push({
          index,
          ...metadata,
          coordinateSpace: "native-screenshot",
          scale: "No OS-point or Retina scale inferred.",
        });
        if (metadata.mimeType !== undefined) current.mimeType = metadata.mimeType;
        return current;
      });
    if (failure !== undefined && failure !== "") content.push({ type: "text", text: failure });
    if (
      unknown &&
      !content.some(
        (block) =>
          block.type === "text" &&
          typeof block.text === "string" &&
          block.text.includes(inspectAdvice),
      )
    )
      content.push({ type: "text", text: inspectAdvice });
    for (const action of actions)
      if (action.error !== undefined && action.error !== "")
        content.push({
          type: "text",
          text: `${action.method}: ${action.error} (dispatched=${action.dispatched}; outcome=${action.outcome})`,
        });
    if (unknown) {
      for (const app of [...this.observations.keys(), ...(input.apps ?? [])])
        this.invalidated.add(app);
      this.observations.clear();
    } else if (meta) {
      this.resolvedApps = new Map(
        meta.resolvedApps === undefined ? [] : Object.entries(meta.resolvedApps),
      );
      this.invalidated.clear();
      for (const observation of meta.observations)
        this.observations.set(observation.app, observation);
    }
    return {
      content,
      isError,
      details: {
        macuse: {
          runId,
          status: runStatus(unknown, isError),
          actions,
          observations: meta?.observations ?? [],
          kernelReset: Boolean(active.interrupted),
          ...(active.interrupted !== undefined ? { interruption: active.interrupted } : {}),
          ...(active.provisionalActions.length > 0
            ? { provisionalActions: active.provisionalActions }
            : {}),
          images,
        },
      },
    };
  }

  /**
   * @param {string} reason
   * @returns {Promise<void>}
   */
  interrupt(reason) {
    if (this.resetting !== undefined) return this.resetting;
    const active = this.active;
    if (active) active.interrupted = reason;
    this.observations.clear();
    this.resolvedApps.clear();
    this.invalidated.clear();
    this.kernelResets++;
    this.generation++;
    this.resetting = (async () => {
      const client = this.client ?? (await this.connecting);
      if (!client) return;
      try {
        const result = await client.callTool({ name: "js_reset", arguments: {} }, undefined, {
          timeout: 10_000,
        });
        if (result.isError === true) throw new Error("Native js_reset failed.");
      } catch (error) {
        await this.closeConnection();
        throw error;
      } finally {
        if (active?.call) await Promise.allSettled([active.call]);
      }
    })().finally(() => {
      this.resetting = undefined;
    });
    return this.resetting;
  }

  async reset() {
    const settled = this.tail;
    await this.interrupt("reset");
    await settled;
    return this.status();
  }
  async closeConnection() {
    const client = this.client;
    this.client = undefined;
    this.connecting = undefined;
    if (client) await client.close().catch(ignoreRejection);
  }
  async stop() {
    try {
      await this.interrupt("stopped");
    } finally {
      await this.tail;
      await this.closeConnection();
    }
  }
}
