import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { GUI_METHODS, validateEnvelope } from "./cua-guard-service.mjs";
import { VERSION } from '../tools/macuse-utils.mjs';

const inspectAdvice = "Execution stopped. A dispatched GUI effect may still have occurred. Inspect fresh app state before continuing; do not automatically replay this code.";
const libPath = dirname(fileURLToPath(import.meta.url));

export async function resolveLaunch({ cwd = process.cwd(), resourcesPath = process.env.MACUSE_CHATGPT_RESOURCES ?? "/Applications/ChatGPT.app/Contents/Resources" } = {}) {
  const resources = resolve(resourcesPath);
  const root = join(resources, "cua_node");
  const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
  const modules = resolve(root, manifest.node_modules);
  const node = resolve(root, manifest.node_path);
  const repl = resolve(root, manifest.node_repl_path);
  const packageRoot = join(modules, "@oai", "cua-repl");
  const pkg = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  const require = createRequire(join(modules, "@oai", "sky", "package.json"));
  return {
    command: node, args: [resolve(packageRoot, pkg.bin["cua-repl"])], cwd,
    env: {
      ...getDefaultEnvironment(),
      CODEX_HOME: process.env.CODEX_HOME ?? join(homedir(), ".codex"),
      CODEX_CLI_PATH: join(resources, "codex"),
      CUA_REPL_NODE_REPL_PATH: repl,
      CUA_REPL_ENABLED_SURFACES: "computer",
      NODE_REPL_NODE_PATH: node,
      NODE_REPL_NODE_MODULE_DIRS: modules,
      NODE_REPL_TRUSTED_CODE_PATHS: `${libPath}:${modules}`,
      NODE_REPL_TRUSTED_SERVICES: JSON.stringify({ sky: pathToFileURL(join(libPath, "cua-guard-service.mjs")).href }),
      MACUSE_SKY_SERVICE_URL: pathToFileURL(require.resolve("@oai/sky/service")).href,
    },
  };
}

export function appApproval(request) {
  const { message, _meta: meta } = request.params;
  const allowed = meta?.connector_id === "computer-use" && meta.codex_approval_kind === "mcp_tool_call"
    && ["get_app_state", ...GUI_METHODS].includes(meta.tool_name)
    && typeof meta.tool_params?.app === "string" && meta.tool_params.app.length > 0
    && Object.keys(meta.tool_params).length === 1
    && /^Allow Computer Use to use ".+"\?$/.test(message);
  return { action: allowed ? "accept" : "decline", ...(allowed ? { content: {} } : {}) };
}

async function connectNative(options, onDiagnostic) {
  const transport = new StdioClientTransport({ ...await resolveLaunch(options), stderr: "pipe" });
  let pending = "";
  transport.stderr.on("data", chunk => {
    pending += chunk.toString();
    let end;
    while ((end = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      if (!line.startsWith("MACUSE_CUA_EVENT ")) continue;
      try { onDiagnostic(JSON.parse(line.slice("MACUSE_CUA_EVENT ".length))); } catch { /* Diagnostic text is never authority. */ }
    }
    if (pending.length > 64_000) pending = "";
  });
  const client = new Client({ name: "macuse", version: VERSION }, { capabilities: { elicitation: { form: {} } } });
  client.setRequestHandler(ElicitRequestSchema, appApproval);
  try { await client.connect(transport, { timeout: 30_000 }); }
  catch (error) { await client.close().catch(() => {}); throw error; }
  return client;
}

// Read actual file signatures. Native macOS captures can be JPEG labelled image/png.
export function imageMetadata(data) {
  const bytes = Buffer.from(data, "base64");
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.toString("ascii", 12, 16) === "IHDR") {
    return { mimeType: "image/png", width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    for (let i = 2; i + 3 < bytes.length;) {
      if (bytes[i++] !== 0xff) break;
      while (bytes[i] === 0xff) i++;
      const marker = bytes[i++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
      if (i + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(i);
      if (length < 2 || i + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 8) {
        return { mimeType: "image/jpeg", width: bytes.readUInt16BE(i + 5), height: bytes.readUInt16BE(i + 3) };
      }
      i += length;
    }
    return { mimeType: "image/jpeg" };
  }
  if (bytes.length >= 10 && /^GIF8[79]a$/.test(bytes.toString("ascii", 0, 6))) return { mimeType: "image/gif", width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  if (bytes.length >= 20 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
    const kind = bytes.toString("ascii", 12, 16);
    if (kind === "VP8X" && bytes.length >= 30) return { mimeType: "image/webp", width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 };
    if (kind === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) return { mimeType: "image/webp", width: 1 + (((bytes[22] & 0x3f) << 8) | bytes[21]), height: 1 + (((bytes[24] & 0x0f) << 10) | (bytes[23] << 2) | (bytes[22] >> 6)) };
    if (kind === "VP8 " && bytes.length >= 30 && bytes.subarray(23, 26).equals(Buffer.from([0x9d, 1, 0x2a]))) return { mimeType: "image/webp", width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
    return { mimeType: "image/webp" };
  }
  return {};
}

export class CuaRuntime {
  constructor({ cwd, resourcesPath, connect = connectNative } = {}) {
    this.options = { cwd, resourcesPath };
    this.connect = connect;
    this.observations = new Map();
    this.resolvedApps = new Map();
    this.invalidated = new Set();
    this.tail = Promise.resolve();
    this.kernelResets = 0;
    this.generation = 0;
  }

  status() { return { connected: Boolean(this.client), running: Boolean(this.active), resetting: Boolean(this.resetting), runId: this.active?.runId, kernelResets: this.kernelResets }; }
  getObservation(app) { return this.observations.get(this.resolvedApps.get(app) ?? app); }
  invalidateObservation(app) { app = this.resolvedApps.get(app) ?? app; this.observations.delete(app); this.invalidated.add(app); }

  async connection() {
    this.connecting ??= this.connect(this.options, event => {
      const active = this.active;
      if (!active || event.runId !== active.runId) return;
      // stderr can contain guest text: retain it only as explicitly provisional evidence.
      active.provisionalActions.push(event);
      if (active.provisionalActions.length > 100) active.provisionalActions.shift();
      try { active.onUpdate?.({ content: [], isError: false, details: { macuse: { runId: active.runId, status: "running", provisionalActions: [...active.provisionalActions] } } }); } catch { /* UI callbacks must not interrupt dispatch tracking. */ }
    }).then(client => this.client = client).catch(error => { this.connecting = undefined; throw error; });
    return this.connecting;
  }

  execute(input, { signal, onUpdate } = {}) {
    validateEnvelope(input);
    if (typeof input.code !== "string" || !input.code.trim()) throw new TypeError("code must be a nonempty string.");
    if (input.timeoutMs !== undefined && (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1000 || input.timeoutMs > 300_000)) throw new TypeError("timeoutMs must be an integer from 1000 to 300000.");
    // Copy the envelope before queuing; caller changes cannot widen an admitted run.
    const saved = structuredClone(input);
    const generation = this.generation;
    const task = this.tail.then(() => this.run(saved, signal, onUpdate, generation));
    this.tail = task.then(() => {}, () => {});
    return task;
  }

  async run(input, signal, onUpdate, generation) {
    await this.resetting?.catch(() => {});
    const runId = randomUUID();
    const active = { runId, onUpdate, provisionalActions: [] };
    let result;
    let failure;
    let timer;
    const abort = () => { void this.interrupt("aborted").catch(() => {}); };
    try {
      if (signal?.aborted || generation !== this.generation) throw new Error("Execution aborted before dispatch.");
      const client = await this.connection();
      await this.resetting;
      if (signal?.aborted || generation !== this.generation) throw new Error("Execution aborted before dispatch.");
      this.active = active;
      const { code, timeoutMs = 90_000, ...gates } = input;
      active.call = client.callTool({ name: "js", arguments: { code, timeout_ms: timeoutMs }, _meta: { macuse: { ...gates, runId, invalidatedApps: [...this.invalidated] } } }, undefined, { timeout: timeoutMs + 15_000 });
      signal?.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => { void this.interrupt("timeout").catch(() => {}); }, timeoutMs + 100);
      result = await active.call;
      const text = result.content?.filter(block => block.type === "text").map(block => block.text).join("\n") ?? "";
      if (result.isError && /timed?\s*out|timeout|kernel.{0,30}reset|reset.{0,30}kernel/i.test(text)) await this.interrupt("timeout");
      else {
        const meta = result._meta?.macuse;
        if (meta?.runId !== runId && input.allowMutating || meta?.actions?.some(action => action.dispatched && action.outcome === "unknown" && !action.error)) {
          await this.interrupt("unsettled-action");
        }
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      if (active.call) {
        await this.interrupt("connection-failure").catch(() => {});
        await this.closeConnection();
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      await this.resetting?.catch(error => { failure ??= error.message; });
      if (this.active === active) this.active = undefined;
    }
    const meta = result?._meta?.macuse?.runId === runId ? result._meta.macuse : undefined;
    const actions = meta?.actions ?? [];
    const lostExecution = Boolean(active.call && (failure || active.interrupted));
    const unknown = lostExecution || actions.some(action => action.outcome === "unknown") || Boolean(active.call && input.allowMutating && !meta);
    const isError = Boolean(failure || result?.isError || unknown || actions.some(action => action.error));
    const images = [];
    const content = (result?.content ?? []).filter(block => ["text", "image"].includes(block.type)).map((block, index) => {
      if (block.type === "text") return { ...block, text: result.isError ? block.text.replace(/\b(?:please\s+)?rerun your request[^\n.]*(?:\.|$)/gi, inspectAdvice) : block.text };
      const metadata = imageMetadata(block.data);
      images.push({ index, ...metadata, coordinateSpace: "native-screenshot", scale: "No OS-point or Retina scale inferred." });
      return { ...block, ...(metadata.mimeType ? { mimeType: metadata.mimeType } : {}) };
    });
    if (failure) content.push({ type: "text", text: failure });
    if (unknown && !content.some(block => block.type === "text" && block.text.includes(inspectAdvice))) content.push({ type: "text", text: inspectAdvice });
    for (const action of actions) if (action.error) content.push({ type: "text", text: `${action.method}: ${action.error} (dispatched=${action.dispatched}; outcome=${action.outcome})` });
    if (unknown) {
      for (const app of [...this.observations.keys(), ...(input.apps ?? [])]) this.invalidated.add(app);
      this.observations.clear();
    }
    else if (meta) {
      this.resolvedApps = new Map(Object.entries(meta.resolvedApps ?? {}));
      this.invalidated.clear();
      for (const observation of meta.observations ?? []) this.observations.set(observation.app, observation);
    }
    return { content, isError, details: { macuse: {
      runId, status: unknown ? "unknown" : isError ? "failed" : "completed", actions,
      observations: meta?.observations ?? [], kernelReset: Boolean(active.interrupted),
      ...(active.interrupted ? { interruption: active.interrupted } : {}),
      ...(active.provisionalActions.length ? { provisionalActions: active.provisionalActions } : {}), images,
    } } };
  }

  interrupt(reason) {
    if (this.resetting) return this.resetting;
    const active = this.active;
    if (active) active.interrupted = reason;
    this.observations.clear();
    this.resolvedApps.clear();
    this.invalidated.clear();
    this.kernelResets++;
    this.generation++;
    this.resetting = (async () => {
      const client = this.client ?? await this.connecting;
      if (!client) return;
      try {
        const result = await client.callTool({ name: "js_reset", arguments: {} }, undefined, { timeout: 10_000 });
        if (result.isError) throw new Error("Native js_reset failed.");
      } catch (error) { await this.closeConnection(); throw error; }
      finally { if (active?.call) await Promise.allSettled([active.call]); }
    })().finally(() => { this.resetting = undefined; });
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
    if (client) await client.close().catch(() => {});
  }
  async stop() {
    try { await this.interrupt("stopped"); } finally { await this.tail; await this.closeConnection(); }
  }
}
