import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { resolveVendorCodex, vendorResources } from "./vendor-installation.mjs";

const resources = vendorResources();
const pkg = /** @type {unknown} */ (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
);
const version =
  typeof pkg === "object" && pkg !== null && "version" in pkg && typeof pkg.version === "string"
    ? pkg.version
    : "";
/** @type {Record<string, { plugin: string, tools: string[] }>} */
const servers = {
  "event-stream": {
    plugin: "record-and-replay",
    tools: ["event_stream_start", "event_stream_status", "event_stream_stop"],
  },
  "computer-history": {
    plugin: "computer-history",
    tools: [
      "computer_history_pause",
      "computer_history_resume",
      "computer_history_status",
      "computer_history_get_settings",
      "computer_history_update_settings",
    ],
  },
};
const nonempty = { type: "string", pattern: "\\S" };
const domainPattern = "^[^\\s/:?#@\\\\]+$";
const observationEntry = {
  type: "object",
  additionalProperties: false,
  properties: {
    scope: { enum: ["app", "url"] },
    bundleID: { type: "string" },
    urlDomain: { type: "string", description: "A bare domain without a scheme or path." },
  },
  required: ["scope"],
  anyOf: [
    { properties: { scope: { const: "app" }, bundleID: nonempty }, required: ["bundleID"] },
    {
      properties: {
        scope: { const: "url" },
        urlDomain: { type: "string", pattern: domainPattern },
      },
      required: ["urlDomain"],
    },
  ],
};
const observationSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    defaultApplicationBehavior: { enum: ["observe", "do_not_observe"] },
    defaultURLBehavior: { enum: ["observe", "do_not_observe"] },
    allowlist: { type: "array", items: observationEntry },
    blocklist: { type: "array", items: observationEntry },
  },
  required: ["defaultApplicationBehavior", "defaultURLBehavior", "allowlist", "blocklist"],
};
const recording = { allowRecording: { const: true, type: "boolean" }, safetyNote: nonempty };
/**
 * @param {string} name
 * @param {string} description
 * @param {boolean} readOnly
 * @param {Record<string, import("@modelcontextprotocol/sdk/validation").JsonSchemaType>} [properties]
 * @param {boolean} [idempotent]
 */
const descriptor = (name, description, readOnly, properties = {}, idempotent = readOnly) => ({
  name,
  description,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties,
    required: Object.keys(properties),
  },
  annotations: {
    readOnlyHint: readOnly,
    destructiveHint: false,
    idempotentHint: idempotent,
    openWorldHint: false,
  },
});
export const auxiliaryTools = [
  descriptor(
    "event_stream_start",
    "Start Record & Replay recording (up to 30 minutes). Requires exact user intent, allowRecording:true, and a non-empty safetyNote.",
    false,
    recording,
  ),
  descriptor(
    "event_stream_status",
    "Read Record & Replay status and artifact paths. Exposes activity metadata.",
    true,
  ),
  descriptor(
    "event_stream_stop",
    "Stop Record & Replay. No recording approval flags required.",
    false,
    {},
    true,
  ),
  descriptor(
    "computer_history_pause",
    "Pause Computer History. No recording approval flags required.",
    false,
    {},
    true,
  ),
  descriptor(
    "computer_history_resume",
    "Resume Computer History recording. Requires exact user intent, allowRecording:true, and a non-empty safetyNote.",
    false,
    recording,
    true,
  ),
  descriptor(
    "computer_history_status",
    "Read Computer History status and activity paths. Exposes activity metadata.",
    true,
  ),
  descriptor(
    "computer_history_get_settings",
    "Read all Computer History observation settings. Exposes privacy metadata.",
    true,
  ),
  descriptor(
    "computer_history_update_settings",
    "Replace all Computer History observation settings. The caller must read fresh settings immediately first and preserve every unchanged field. Requires exact approval, allowPrivacyChange:true, and a non-empty safetyNote.",
    false,
    {
      observation: observationSchema,
      allowPrivacyChange: { const: true, type: "boolean" },
      safetyNote: nonempty,
    },
    true,
  ),
];
/** @type {Map<string, ReturnType<typeof descriptor>>} */
const tools = new Map(auxiliaryTools.map((tool) => [tool.name, tool]));
/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
/**
 * @param {unknown} value
 * @returns {value is unknown[]}
 */
const isUnknownArray = (value) => Array.isArray(value);
/**
 * @param {unknown} value
 * @returns {boolean}
 */
const hasText = (value) => typeof value === "string" && /\S/.test(value);

/**
 * @param {unknown} value
 * @param {string[]} allowed
 * @param {string} label
 * @returns {void}
 */
function checkKeys(value, allowed, label) {
  if (!isObject(value)) throw new Error(`${label} must be an object.`);
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`Unsupported ${label} fields: ${unknown.join(", ")}.`);
}

/**
 * Validate before launch and copy only pinned upstream arguments; never
 * forward local approvals.
 * @param {string} tool
 * @param {Record<string, unknown>} [input]
 * @returns {Record<string, unknown>}
 */
export function validateAuxiliaryArguments(tool, input = {}) {
  const schema = tools.get(tool)?.inputSchema;
  if (!schema) throw new Error(`Unsupported auxiliary tool: ${tool}`);
  checkKeys(input, Object.keys(schema.properties), `${tool} arguments`);
  const flag =
    tool === "computer_history_update_settings" ? "allowPrivacyChange" : "allowRecording";
  if (
    Object.hasOwn(schema.properties, flag) &&
    (!Object.hasOwn(input, flag) ||
      input[flag] !== true ||
      !Object.hasOwn(input, "safetyNote") ||
      !hasText(input.safetyNote))
  ) {
    throw new Error(`${tool} requires ${flag}:true and a non-empty safetyNote.`);
  }
  if (tool !== "computer_history_update_settings") return {};
  const settings = input.observation;
  if (!isObject(settings)) throw new Error("observation must be an object.");
  checkKeys(settings, observationSchema.required, "observation");
  for (const key of observationSchema.required) {
    if (!Object.hasOwn(settings, key))
      throw new Error(`observation.${key} is required; send all observation fields.`);
  }
  for (const key of ["defaultApplicationBehavior", "defaultURLBehavior"]) {
    if (settings[key] !== "observe" && settings[key] !== "do_not_observe")
      throw new Error(`observation.${key} must be observe or do_not_observe.`);
  }
  /** @type {Record<string, unknown>} */
  const observation = {
    defaultApplicationBehavior: settings.defaultApplicationBehavior,
    defaultURLBehavior: settings.defaultURLBehavior,
  };
  for (const key of ["allowlist", "blocklist"]) {
    if (!Array.isArray(settings[key]))
      throw new Error(`observation.${key} must be an array; send all observation fields.`);
    observation[key] = Array.from(/** @type {unknown[]} */ (settings[key]), (entry) => {
      checkKeys(entry, ["scope", "bundleID", "urlDomain"], `observation.${key} entry`);
      if (!isObject(entry)) throw new Error(`observation.${key} entry must be an object.`);
      const copy = { ...entry };
      for (const field of ["bundleID", "urlDomain"]) {
        if (Object.hasOwn(copy, field) && typeof copy[field] !== "string")
          throw new Error(`${field} must be a string.`);
      }
      if (copy.scope === "app" && hasText(copy.bundleID)) return copy;
      if (
        copy.scope === "url" &&
        typeof copy.urlDomain === "string" &&
        new RegExp(domainPattern).test(copy.urlDomain)
      )
        return copy;
      throw new Error(
        "Observation entries require scope:app with a non-empty bundleID, or scope:url with a bare-domain urlDomain.",
      );
    });
  }
  return { observation };
}

/**
 * @typedef {{ content: Array<{ type: "text", text: string }>, isError?: unknown, [key: string]: unknown }} AuxiliaryResult
 * @typedef {{ resolve: (result: unknown) => void, reject: (error: Error) => void, method: string }} PendingRequest
 * @typedef {{ tool: string, started: number, controller: AbortController, dispatched: boolean, attempts: number, missingTools: string[] }} CallContext
 */

/**
 * @param {string} reason
 * @param {string} message
 * @returns {Error & { reason: string }}
 */
const failure = (reason, message) => Object.assign(new Error(message), { reason });
const stoppedSentinel =
  "This application session has been explicitly stopped by the user for this turn.";
/**
 * @param {unknown} text
 * @returns {boolean}
 */
const stoppedSession = (text) => String(text).includes(stoppedSentinel);
/**
 * @param {unknown} text
 * @returns {string}
 */
const sanitizeStopped = (text) =>
  String(text).replaceAll(
    stoppedSentinel,
    "The auxiliary application session is stopped. No tool result was returned. Refresh the session before retrying.",
  );
/**
 * @param {unknown} text
 * @returns {boolean}
 */
const closedTransport = (text) => /\b(?:transport|connection|channel) closed\b/i.test(String(text));
/**
 * @param {{ content?: unknown } | null | undefined} result
 * @returns {string}
 */
const textOf = (result) => {
  const content = result?.content;
  if (!isUnknownArray(content)) return "";
  /** @type {string[]} */
  const texts = [];
  for (const block of content) {
    if (isObject(block) && block.type === "text" && typeof block.text === "string")
      texts.push(block.text);
  }
  return texts.join("\n");
};
/**
 * Validate JSON-RPC content blocks into the text-only result form the
 * auxiliary tools emit.
 * @param {unknown} block
 * @returns {Array<{ type: "text", text: string }>}
 */
const textBlocks = (block) =>
  isObject(block) && block.type === "text" && typeof block.text === "string"
    ? [{ type: "text", text: block.text }]
    : [];

/**
 * @param {unknown} error
 * @returns {void}
 */
const logStopFailure = (error) => {
  process.stderr.write(`macuse auxiliary: failed to stop app-server: ${String(error)}\n`);
};

export class AuxiliaryRuntime {
  /** @type {import("node:child_process").ChildProcess | null} */
  #proc = null;
  /** @type {Promise<void> | null} */
  #exited = null;
  /** @type {Promise<void> | null} */
  #stopping = null;
  /** @type {string | null} */
  #threadId = null;
  /** @type {Map<number, PendingRequest>} */
  // oxlint-disable-next-line typescript/prefer-readonly -- .mjs private fields cannot express readonly (TS8009)
  #pending = new Map();
  #nextId = 1;
  /** @type {Promise<void>} */
  #queue = Promise.resolve();
  /** @type {CallContext | null} */
  #active = null;
  #stderr = "";

  /**
   * @param {{ cwd?: string, codexBin?: string | null }} [options]
   */
  constructor({
    cwd = process.cwd(),
    codexBin = process.env.CODEX_BIN !== undefined && process.env.CODEX_BIN !== ""
      ? process.env.CODEX_BIN
      : null,
  } = {}) {
    this.cwd = cwd;
    this.codexBin = codexBin;
  }

  status() {
    return {
      running: Boolean(
        this.#proc && this.#proc.exitCode === null && this.#proc.signalCode === null,
      ),
      processPid: this.#proc?.pid ?? null,
      threadId: this.#threadId,
      pendingRequests: this.#pending.size,
      cwd: this.cwd,
      codexBin: this.codexBin,
      stderrTail: this.#stderr,
    };
  }

  /**
   * @param {string} tool
   * @param {Record<string, unknown>} [input]
   * @param {{ signal?: AbortSignal, timeoutMs?: number }} [options]
   * @returns {Promise<AuxiliaryResult>}
   */
  callTool(tool, input = {}, { signal, timeoutMs = 90_000 } = {}) {
    const context = {
      tool,
      started: Date.now(),
      controller: new AbortController(),
      dispatched: false,
      attempts: 0,
      missingTools: [],
    };
    let args;
    try {
      args = validateAuxiliaryArguments(tool, input);
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647)
        throw new Error("timeoutMs must be a positive finite duration no greater than 2147483647.");
    } catch (error) {
      return Promise.resolve(this.#errorResult(context, error));
    }
    return new Promise((resolve) => {
      let active = false;
      let finished = false;
      const finish = (/** @type {AuxiliaryResult} */ result) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        context.controller.signal.removeEventListener("abort", onCancel);
        resolve(result);
      };
      const onCancel = () => {
        if (active) this.#stopProcess().catch(logStopFailure);
        else finish(this.#errorResult(context, context.controller.signal.reason));
      };
      const onAbort = () =>
        context.controller.abort(failure("aborted", "Auxiliary call was aborted."));
      const timer = setTimeout(
        () =>
          context.controller.abort(
            failure("timeout", `Auxiliary call timed out after ${timeoutMs}ms.`),
          ),
        timeoutMs,
      );
      context.controller.signal.addEventListener("abort", onCancel, { once: true });
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted === true) onAbort();
      const run = async () => {
        if (finished) return;
        active = true;
        this.#active = context;
        try {
          finish(await this.#call(args, context));
        } catch (error) {
          await this.#stopProcess();
          finish(
            this.#errorResult(
              context,
              context.controller.signal.aborted ? context.controller.signal.reason : error,
            ),
          );
        } finally {
          this.#active = null;
        }
      };
      this.#queue = this.#queue.then(run);
    });
  }

  /**
   * @param {CallContext} context
   * @param {AuxiliaryResult} result
   * @param {string} outcome
   * @param {string} [reason]
   * @returns {AuxiliaryResult}
   */
  /**
   * The running call's mutable context. It is set for the whole duration of
   * #call, so mutations target the class-owned state instead of parameters.
   * @returns {CallContext}
   */
  #activeCall() {
    const active = this.#active;
    if (active === null) throw new Error("No active auxiliary call.");
    return active;
  }

  /**
   * @param {CallContext} context
   * @param {AuxiliaryResult} result
   * @param {string} outcome
   * @param {string} [reason]
   * @returns {AuxiliaryResult}
   */
  #result(context, result, outcome, reason) {
    const isError = Boolean(result.isError);
    return {
      ...result,
      isError,
      details: {
        macuse: {
          tool: context.tool,
          isError,
          dispatched: context.dispatched,
          outcome,
          ...(reason !== undefined ? { reason } : {}),
          ...(context.missingTools.length > 0 ? { missingTools: context.missingTools } : {}),
          attempts: context.attempts,
          durationMs: Date.now() - context.started,
        },
      },
    };
  }

  /**
   * @param {CallContext} context
   * @param {unknown} error
   * @returns {AuxiliaryResult}
   */
  #errorResult(context, error) {
    const missingTools = context.missingTools;
    const missing =
      missingTools.length > 0 ? ` Missing auxiliary tools: ${missingTools.join(", ")}.` : "";
    const detail =
      isObject(error) && typeof error.message === "string" && error.message !== ""
        ? error.message
        : String(error);
    const message = `${sanitizeStopped(detail)}${missing} ${context.dispatched ? "A dispatched action may have taken effect; outcome unknown. Inspect status before retrying." : "No auxiliary action was sent."}`;
    const reason =
      isObject(error) && typeof error.reason === "string" && error.reason !== ""
        ? error.reason
        : "error";
    return this.#result(
      context,
      { content: [{ type: "text", text: message }], isError: true },
      context.dispatched ? "unknown" : "not_dispatched",
      reason,
    );
  }

  /**
   * @param {Record<string, unknown>} args
   * @param {CallContext} context
   * @returns {Promise<AuxiliaryResult>}
   */
  async #call(args, context) {
    const { tool, controller } = context;
    for (;;) {
      controller.signal.throwIfAborted();
      this.#activeCall().attempts++;
      try {
        await this.#ensureThread(context);
        const server =
          Object.keys(servers).find((name) => servers[name]?.tools.includes(tool) ?? false) ?? "";
        this.#activeCall().missingTools = [`${server}/${tool}`];
        for (;;) {
          let cursor;
          do {
            const status = await this.#request(
              "mcpServerStatus/list",
              {
                threadId: this.#threadId,
                detail: "toolsAndAuthOnly",
                limit: 100,
                ...(cursor !== undefined && cursor !== "" ? { cursor } : {}),
              },
              context,
            );
            const entries = isObject(status) && isUnknownArray(status.data) ? status.data : [];
            if (
              entries.some((entry) => {
                if (!isObject(entry) || entry.name !== server) return false;
                const serverTools = entry.tools;
                return isObject(serverTools) ? Object.hasOwn(serverTools, tool) : false;
              })
            ) {
              this.#activeCall().missingTools = [];
              break;
            }
            const next = isObject(status) ? status.nextCursor : undefined;
            cursor = typeof next === "string" ? next : undefined;
          } while (cursor !== undefined && cursor !== "");
          if (context.missingTools.length === 0) break;
          await delay(100, undefined, { signal: controller.signal });
        }
        const result = await this.#request(
          "mcpServer/tool/call",
          { threadId: this.#threadId, server, tool, arguments: args },
          context,
        );
        controller.signal.throwIfAborted();
        if (!isObject(result) || !isUnknownArray(result.content))
          throw failure("protocol-error", "Auxiliary tool returned no content array.");
        const text = textOf(result);
        const isError = Boolean(result.isError) || Boolean(result.is_error) || stoppedSession(text);
        if (
          isError &&
          (stoppedSession(text) || closedTransport(text)) &&
          (tools.get(tool)?.annotations.readOnlyHint ?? false) &&
          context.attempts === 1
        ) {
          await this.#stopProcess();
          continue;
        }
        const content = (
          stoppedSession(text)
            ? result.content.map((block) =>
                isObject(block) && block.type === "text"
                  ? { ...block, text: sanitizeStopped(block.text) }
                  : block,
              )
            : result.content
        ).flatMap(textBlocks);
        return this.#result(context, { ...result, content, isError }, "reported");
      } catch (error) {
        const reason =
          isObject(error) && typeof error.reason === "string" ? error.reason : undefined;
        const message =
          isObject(error) && typeof error.message === "string" ? error.message : undefined;
        if (
          controller.signal.aborted ||
          !(tools.get(tool)?.annotations.readOnlyHint ?? false) ||
          context.attempts !== 1 ||
          !(reason === "transport-closed" || stoppedSession(message) || closedTransport(message))
        )
          throw error;
        await this.#stopProcess();
      }
    }
  }

  /**
   * @param {CallContext} context
   * @returns {Promise<void>}
   */
  async #ensureThread(context) {
    if (this.#stopping) await this.#stopping;
    context.controller.signal.throwIfAborted();
    if (this.#threadId !== null) return;
    this.codexBin ??= resolveVendorCodex(resources).path;
    const proc = spawn(
      this.codexBin,
      [
        "app-server",
        "--disable",
        "apps",
        "--enable",
        "computer_use",
        "--enable",
        "plugins",
        "--enable",
        "tool_call_mcp_elicitation",
      ],
      { cwd: this.cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] },
    );
    this.#proc = proc;
    this.#stderr = "";
    /** @type {unknown} */
    let spawnError;
    this.#exited = new Promise((resolve) => {
      proc.on("error", (error) => {
        if (proc.pid === undefined) spawnError = error;
      });
      proc.once("close", (code, signal) => {
        const error =
          spawnError instanceof Error
            ? spawnError
            : failure(
                "transport-closed",
                `Auxiliary app-server transport closed (code=${String(code)}, signal=${String(signal)}).`,
              );
        for (const pending of this.#pending.values()) pending.reject(error);
        this.#pending.clear();
        if (this.#proc === proc) {
          this.#proc = null;
          this.#threadId = null;
        }
        resolve();
      });
    });
    proc.stdin.on("error", () => {
      this.#stopProcess().catch(logStopFailure);
    });
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (/** @type {string} */ chunk) => {
      this.#stderr = (this.#stderr + chunk).slice(-4000);
    });
    createInterface({ input: proc.stdout }).on("line", (line) => this.#onLine(line, proc));
    await this.#request(
      "initialize",
      {
        clientInfo: { name: "macuse-auxiliary", version },
        capabilities: { experimentalApi: true, requestAttestation: false },
      },
      context,
    );
    this.#write({ jsonrpc: "2.0", method: "initialized", params: {} });
    const configRead = await this.#request(
      "config/read",
      { cwd: this.cwd, includeLayers: false },
      context,
    );
    if (!isObject(configRead) || !isObject(configRead.config))
      throw new Error("config/read response did not include config.");
    /**
     * @param {unknown} value
     * @returns {Record<string, { enabled: boolean }>}
     */
    const disabled = (value) =>
      Object.fromEntries(
        Object.keys(isObject(value) ? value : {}).map((name) => [name, { enabled: false }]),
      );
    const configured = Object.fromEntries(
      Object.entries(servers).map(([name, server]) => {
        const root = join(resources, "plugins/openai-bundled/plugins", server.plugin);
        return [
          name,
          {
            command: join(root, "bin/computer-use-client-launcher"),
            args: [name, "mcp"],
            cwd: root,
            env_vars: ["CODEX_HOME"],
            enabled: true,
          },
        ];
      }),
    );
    const start = await this.#request(
      "thread/start",
      {
        cwd: this.cwd,
        ephemeral: true,
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
        config: {
          features: {
            apps: false,
            computer_use: true,
            plugins: true,
            tool_call_mcp_elicitation: true,
          },
          mcp_servers: { ...disabled(configRead.config.mcp_servers), ...configured },
          plugins: disabled(configRead.config.plugins),
        },
      },
      context,
    );
    const thread = isObject(start) ? start.thread : undefined;
    const threadId = isObject(thread) && typeof thread.id === "string" ? thread.id : undefined;
    if (threadId === undefined || threadId === "")
      throw new Error("thread/start response did not include thread.id.");
    context.controller.signal.throwIfAborted();
    this.#threadId = threadId;
  }

  /**
   * @param {unknown} message
   * @returns {void}
   */
  #write(message) {
    if (this.#proc === null || this.#proc.stdin === null || !this.#proc.stdin.writable)
      throw failure("transport-closed", "Auxiliary app-server transport closed before write.");
    this.#proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  /**
   * @param {string} method
   * @param {unknown} params
   * @param {CallContext} context
   * @returns {Promise<unknown>}
   */
  #request(method, params, context) {
    context.controller.signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const id = this.#nextId++;
      this.#pending.set(id, { resolve, reject, method });
      try {
        this.#write({ jsonrpc: "2.0", id, method, params });
        if (method === "mcpServer/tool/call") this.#activeCall().dispatched = true;
      } catch (error) {
        this.#pending.delete(id);
        reject(error);
      }
    });
  }

  /**
   * @param {string} line
   * @param {import("node:child_process").ChildProcess} proc
   * @returns {void}
   */
  #onLine(line, proc) {
    if (proc !== this.#proc) return;
    let parsed;
    try {
      parsed = /** @type {unknown} */ (JSON.parse(line));
    } catch {
      return;
    }
    if (!isObject(parsed)) return;
    const message = parsed;
    const id = message.id;
    if (
      typeof id === "number" &&
      (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))
    ) {
      const pending = this.#pending.get(id);
      if (pending !== undefined) {
        this.#pending.delete(id);
        const hasError = Boolean(message.error);
        if (hasError) {
          const errorBody = message.error;
          const text =
            isObject(errorBody) && typeof errorBody.message === "string" && errorBody.message !== ""
              ? errorBody.message
              : "Auxiliary app-server JSON-RPC error.";
          pending.reject(new Error(text));
        } else pending.resolve(message.result);
        return;
      }
    }
    if (
      Object.hasOwn(message, "id") &&
      typeof message.method === "string" &&
      proc.stdin !== null &&
      proc.stdin.writable
    ) {
      if (message.method === "mcpServer/elicitation/request") {
        const approved = Boolean(
          this.#active &&
          !this.#active.controller.signal.aborted &&
          [...this.#pending.values()].some((request) => request.method === "mcpServer/tool/call"),
        );
        this.#write({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            action: approved ? "accept" : "decline",
            content: approved ? {} : null,
            _meta: null,
          },
        });
      } else
        this.#write({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: `Unsupported app-server request: ${message.method}` },
        });
    }
  }

  async stop() {
    this.#active?.controller.abort(failure("stopped", "Auxiliary runtime was stopped."));
    await this.#stopProcess();
  }

  async #stopProcess() {
    if (this.#stopping) return this.#stopping;
    const proc = this.#proc;
    if (!proc) return;
    this.#threadId = null;
    const exited = this.#exited;
    const stopping = (async () => {
      // EOF lets app-server close its own clients. Escalate only this subprocess.
      const term = setTimeout(() => {
        if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGTERM");
      }, 1000);
      const force = setTimeout(() => {
        if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
      }, 3000);
      proc.stdin?.end();
      try {
        await exited;
      } finally {
        clearTimeout(term);
        clearTimeout(force);
      }
    })();
    this.#stopping = stopping;
    try {
      await stopping;
    } finally {
      if (this.#stopping === stopping) this.#stopping = null;
    }
  }
}
