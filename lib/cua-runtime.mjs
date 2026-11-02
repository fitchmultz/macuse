import { randomUUID } from "node:crypto";
import { validateEnvelope } from "./cua-guard-service.mjs";
import { connectNative } from "./cua-connect.mjs";
import { CUA_REQUEST_GRACE_MS, MAX_CUA_TIMEOUT_MS } from "./cua-timeout.mjs";
import { imageMetadata } from "./cua-image-metadata.mjs";

/**
 * @param {boolean} unknown
 * @param {boolean} isError
 * @returns {string}
 */
const runStatus = (unknown, isError) => {
  if (unknown) {
    return "unknown";
  }
  return isError ? "failed" : "completed";
};

const inspectAdvice =
  "Execution stopped. A dispatched GUI effect may still have occurred. Inspect fresh app state before continuing; do not automatically replay this code.";

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

export { resolveLaunch, appApproval } from "./cua-connect.mjs";

/**
 * @param {import("./cua-guard-service.mjs").MacuseEnvelope} input
 * @param {ActiveRun} active
 * @param {{ result: CallToolResult | undefined, failure: string | undefined }} outcome
 */
function assessRun(input, active, { result, failure }) {
  const runId = active.runId;
  const reported = runMeta(result);
  const meta = reported !== undefined && reported.runId === runId ? reported : undefined;
  const actions = meta?.actions ?? [];
  const unknown = hasUnknownOutcome(input, active, failure, meta);
  const isError =
    hasFailure(failure) ||
    result?.isError === true ||
    unknown ||
    actions.some((action) => hasFailure(action.error));
  return { meta, actions, unknown, isError };
}

/** @param {string | undefined} message */
function hasFailure(message) {
  return message !== undefined && message !== "";
}

/**
 * @param {import("./cua-guard-service.mjs").MacuseEnvelope} input
 * @param {ActiveRun} active
 * @param {string | undefined} failure
 * @param {GuardRunMeta | undefined} meta
 */
function hasUnknownOutcome(input, active, failure, meta) {
  const lost = Boolean(active.call && (hasFailure(failure) || active.interrupted !== undefined));
  return (
    lost ||
    (meta?.actions ?? []).some((action) => action.outcome === "unknown") ||
    Boolean(active.call && input.allowMutating === true && !meta)
  );
}

/**
 * @param {{ result: CallToolResult | undefined, failure: string | undefined }} outcome
 * @param {boolean} unknown
 * @param {GuardAction[]} actions
 */
function resultContent({ result, failure }, unknown, actions) {
  const { content, images } = normalizeContentBlocks(result);
  appendFailure(content, failure);
  if (
    unknown &&
    !content.some(
      (block) =>
        block.type === "text" &&
        typeof block.text === "string" &&
        block.text.includes(inspectAdvice),
    )
  ) {
    content.push({ type: "text", text: inspectAdvice });
  }
  for (const action of actions) {
    if (action.error !== undefined && hasFailure(action.error)) {
      content.push({
        type: "text",
        text: `${action.method}: ${action.error} (dispatched=${action.dispatched}; outcome=${action.outcome})`,
      });
    }
  }
  return { content, images };
}

/** @param {CallToolResult | undefined} result */
function normalizeContentBlocks(result) {
  /** @type {Record<string, unknown>[]} */
  const images = [];
  const failed = result?.isError === true;
  const content = (result?.content ?? []).filter((block) => ["text", "image"].includes(block.type));
  for (const [index, current] of content.entries()) {
    if (current.type === "text") {
      current.text = failed
        ? current.text.replace(/\b(?:please\s+)?rerun your request[^\n.]*(?:\.|$)/gi, inspectAdvice)
        : current.text;
    } else if (current.type === "image") {
      const metadata = imageMetadata(current.data);
      images.push({
        index,
        ...metadata,
        coordinateSpace: "native-screenshot",
        scale: "No OS-point or Retina scale inferred.",
      });
      if (metadata.mimeType !== undefined) {
        current.mimeType = metadata.mimeType;
      }
    }
  }
  return { content, images };
}

/**
 * @param {import("@modelcontextprotocol/sdk/types.js").ContentBlock[]} content
 * @param {string | undefined} failure
 */
function appendFailure(content, failure) {
  if (failure !== undefined && hasFailure(failure)) {
    content.push({ type: "text", text: failure });
  }
}

/** @param {CallToolResult} result @param {string} text */
function isNativeTimeout(result, text) {
  return (
    result.isError === true &&
    result._meta?.["codex/nodeReplExecutionDurationMs"] === undefined &&
    /timed?\s*out|timeout|kernel.{0,30}reset|reset.{0,30}kernel/i.test(text)
  );
}

/**
 * Identify native results requiring a kernel reset before further calls.
 * @param {CallToolResult} result
 * @param {import("./cua-guard-service.mjs").MacuseEnvelope} input
 * @param {string} runId
 * @returns {string | undefined}
 */
function interruptionForResult(result, input, runId) {
  const text = result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  // Completed guest errors include an execution duration, even when their text says "timeout".
  if (isNativeTimeout(result, text)) {
    return "timeout";
  }
  const meta = runMeta(result);
  if (
    ((meta === undefined || meta.runId !== runId) && input.allowMutating === true) ||
    (meta?.actions ?? []).some(unsettledAction)
  ) {
    return "unsettled-action";
  }
  return;
}

/** @param {unknown} error @returns {string} */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/** @param {GuardAction} action */
function unsettledAction(action) {
  return action.dispatched && action.outcome === "unknown" && !hasFailure(action.error);
}

/**
 * @param {AbortSignal | undefined} signal
 * @param {number} generation
 * @param {number} current
 */
function requireDispatchAllowed(signal, generation, current) {
  if (signal?.aborted === true || generation !== current) {
    throw new Error("Execution aborted before dispatch.");
  }
}

export { imageMetadata } from "./cua-image-metadata.mjs";

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
      if (!active || !isRecord(event) || event.runId !== active.runId) {
        return;
      }
      // stderr can contain guest text: retain it only as explicitly provisional evidence.
      active.provisionalActions.push(event);
      if (active.provisionalActions.length > 100) {
        active.provisionalActions.shift();
      }
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
    if (typeof input.code !== "string" || input.code.trim() === "") {
      throw new TypeError("code must be a nonempty string.");
    }
    const timeoutMs = input.timeoutMs;
    if (
      timeoutMs !== undefined &&
      (typeof timeoutMs !== "number" ||
        !Number.isSafeInteger(timeoutMs) ||
        timeoutMs < 1 ||
        timeoutMs > MAX_CUA_TIMEOUT_MS)
    ) {
      throw new TypeError(`timeoutMs must be an integer from 1 to ${MAX_CUA_TIMEOUT_MS}.`);
    }
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
    const outcome = await this.#dispatchRun(input, active, signal, generation);
    return this.#finalizeRun(input, active, outcome);
  }

  /**
   * @param {import("./cua-guard-service.mjs").MacuseEnvelope} input
   * @param {ActiveRun} active
   * @param {{ result: CallToolResult | undefined, failure: string | undefined }} outcome
   * @returns {MacuseToolResult}
   */
  #finalizeRun(input, active, { result, failure }) {
    const runId = active.runId;
    const { meta, actions, unknown, isError } = assessRun(input, active, { result, failure });
    const { content, images } = resultContent({ result, failure }, unknown, actions);
    this.#applyObservations(input, meta, unknown);
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
   * @param {import("./cua-guard-service.mjs").MacuseEnvelope} input
   * @param {GuardRunMeta | undefined} meta
   * @param {boolean} unknown
   * @returns {void}
   */
  #applyObservations(input, meta, unknown) {
    if (unknown) {
      for (const app of [...this.observations.keys(), ...(input.apps ?? [])]) {
        this.invalidated.add(app);
      }
      this.observations.clear();
    } else if (meta) {
      this.resolvedApps = new Map(
        meta.resolvedApps === undefined ? [] : Object.entries(meta.resolvedApps),
      );
      this.invalidated.clear();
      for (const observation of meta.observations) {
        this.observations.set(observation.app, observation);
      }
    }
  }

  /**
   * Dispatch and settle the native request before interpreting its evidence.
   * @param {import("./cua-guard-service.mjs").MacuseEnvelope} input
   * @param {ActiveRun} active
   * @param {AbortSignal | undefined} signal
   * @param {number} generation
   * @returns {Promise<{ result: CallToolResult | undefined, failure: string | undefined }>}
   */
  async #dispatchRun(input, active, signal, generation) {
    /** @type {CallToolResult | undefined} */
    let result;
    /** @type {string | undefined} */
    let failure;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    const abort = () => {
      this.interrupt("aborted").catch(ignoreRejection);
    };
    try {
      requireDispatchAllowed(signal, generation, this.generation);
      const client = await this.connection();
      await this.resetting;
      requireDispatchAllowed(signal, generation, this.generation);
      this.active = active;
      const { code, timeoutMs, ...gates } = input;
      const timeout = typeof timeoutMs === "number" ? timeoutMs : 90_000;
      this.active.call = client.callTool(
        {
          name: "js",
          arguments: { code, timeout_ms: timeout },
          _meta: {
            macuse: { ...gates, runId: active.runId, invalidatedApps: [...this.invalidated] },
          },
        },
        undefined,
        { timeout: timeout + CUA_REQUEST_GRACE_MS },
      );
      signal?.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => {
        this.interrupt("timeout").catch(ignoreRejection);
      }, timeout + 100);
      const response = await active.call;
      if (!isCallToolResult(response)) {
        throw new Error("Native service returned no tool result.");
      }
      result = response;
      const reason = interruptionForResult(result, input, active.runId);
      if (reason !== undefined) {
        await this.interrupt(reason);
      }
    } catch (error) {
      failure = errorMessage(error);
      if (active.call) {
        await this.interrupt("connection-failure").catch(ignoreRejection);
        await this.closeConnection();
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      await this.resetting?.catch((/** @type {unknown} */ error) => {
        if (failure === undefined && error instanceof Error) {
          failure = error.message;
        }
      });
      if (this.active === active) {
        this.active = undefined;
      }
    }
    return { result, failure };
  }

  /**
   * @param {string} reason
   * @returns {Promise<void>}
   */
  interrupt(reason) {
    if (this.resetting !== undefined) {
      return this.resetting;
    }
    const active = this.active;
    if (active) {
      active.interrupted = reason;
    }
    this.observations.clear();
    this.resolvedApps.clear();
    this.invalidated.clear();
    this.kernelResets++;
    this.generation++;
    this.resetting = (async () => {
      const client = this.client ?? (await this.connecting);
      if (!client) {
        return;
      }
      try {
        const result = await client.callTool({ name: "js_reset", arguments: {} }, undefined, {
          timeout: 10_000,
        });
        if (result.isError === true) {
          throw new Error("Native js_reset failed.");
        }
      } catch (error) {
        await this.closeConnection();
        throw error;
      } finally {
        if (active?.call) {
          await Promise.allSettled([active.call]);
        }
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
    if (client) {
      await client.close().catch(ignoreRejection);
    }
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
