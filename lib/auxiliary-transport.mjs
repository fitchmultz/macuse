import { join } from "node:path";
import { vendorResources } from "./vendor-installation.mjs";
import {
  closedTransport,
  failure,
  isObject,
  isUnknownArray,
  sanitizeStopped,
  servers,
  stoppedSession,
  textBlocks,
  textOf,
  tools,
  validateAuxiliaryArguments,
} from "./auxiliary-schema.mjs";

export const resources = vendorResources();

/**
 * @typedef {{ content: Array<{ type: "text", text: string }>, isError?: unknown, [key: string]: unknown }} AuxiliaryResult
 * @typedef {{ resolve: (result: unknown) => void, reject: (error: Error) => void, method: string }} PendingRequest
 * @typedef {{ tool: string, started: number, controller: AbortController, dispatched: boolean, attempts: number, missingTools: string[] }} CallContext
 */

/**
 * @param {unknown} error
 * @returns {void}
 */
export const logStopFailure = (error) => {
  process.stderr.write(`macuse auxiliary: failed to stop app-server: ${String(error)}\n`);
};

/**
 * Build a call context and validated arguments, or a validation error.
 * @param {string} tool
 * @param {Record<string, unknown>} input
 * @param {number} timeoutMs
 * @returns {{ context: CallContext, args?: Record<string, unknown>, error?: unknown }}
 */
export function newCallContext(tool, input, timeoutMs) {
  const context = {
    tool,
    started: Date.now(),
    controller: new AbortController(),
    dispatched: false,
    attempts: 0,
    missingTools: [],
  };
  try {
    const args = validateAuxiliaryArguments(tool, input);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
      throw new Error("timeoutMs must be a positive finite duration no greater than 2147483647.");
    }
    return { context, args };
  } catch (error) {
    return { context, error };
  }
}

/**
 * Server that owns the given tool.
 * @param {string} tool
 * @returns {string}
 */
export function serverForTool(tool) {
  return Object.keys(servers).find((name) => servers[name]?.tools.includes(tool) ?? false) ?? "";
}

/**
 * @param {unknown[]} entries
 * @param {string} server
 * @param {string} tool
 * @returns {boolean}
 */
export function serverExposesTool(entries, server, tool) {
  return entries.some((entry) => {
    if (!isObject(entry) || entry.name !== server) {
      return false;
    }
    const serverTools = entry.tools;
    return isObject(serverTools) ? Object.hasOwn(serverTools, tool) : false;
  });
}

/**
 * Whether a stopped-session report should restart the transport once.
 * @param {string} tool
 * @param {CallContext} context
 * @param {string} text
 * @param {boolean} isError
 * @returns {boolean}
 */
function restartOnReport(tool, context, text, isError) {
  return (
    isError &&
    (stoppedSession(text) || closedTransport(text)) &&
    (tools.get(tool)?.annotations.readOnlyHint ?? false) &&
    context.attempts === 1
  );
}

/**
 * @param {unknown} error
 * @returns {{ reason: string | undefined, message: string | undefined }}
 */
function failureFields(error) {
  return {
    reason: isObject(error) && typeof error.reason === "string" ? error.reason : undefined,
    message: isObject(error) && typeof error.message === "string" ? error.message : undefined,
  };
}

/**
 * Whether a caught failure should restart the transport once.
 * @param {string} tool
 * @param {CallContext} context
 * @param {unknown} error
 * @returns {boolean}
 */
export function retryableFailure(tool, context, error) {
  const { reason, message } = failureFields(error);
  return (
    !context.controller.signal.aborted &&
    (tools.get(tool)?.annotations.readOnlyHint ?? false) &&
    context.attempts === 1 &&
    (reason === "transport-closed" || stoppedSession(message) || closedTransport(message))
  );
}

/**
 * Disable every configured server or plugin entry.
 * @param {unknown} value
 * @returns {Record<string, { enabled: boolean }>}
 */
function disabledServers(value) {
  return Object.fromEntries(
    Object.keys(isObject(value) ? value : {}).map((name) => [name, { enabled: false }]),
  );
}

/**
 * The bundled auxiliary MCP servers pinned to vendored launchers.
 * @returns {Record<string, Record<string, unknown>>}
 */
function configuredServers() {
  return Object.fromEntries(
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
}

/**
 * @param {Record<string, unknown>} config
 * @param {string} cwd
 * @returns {Record<string, unknown>}
 */
export function threadConfig(config, cwd) {
  return {
    cwd,
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
      mcp_servers: { ...disabledServers(config.mcp_servers), ...configuredServers() },
      plugins: disabledServers(config.plugins),
    },
  };
}

/**
 * Settle a pending request from a response message.
 * @param {Map<number, PendingRequest>} pending
 * @param {Record<string, unknown>} message
 * @returns {boolean}
 */
export function resolvePending(pending, message) {
  const id = message.id;
  if (
    typeof id === "number" &&
    (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))
  ) {
    const request = pending.get(id);
    if (request !== undefined) {
      pending.delete(id);
      settlePending(request, message);
      return true;
    }
  }
  return false;
}

/**
 * @param {PendingRequest} pending
 * @param {Record<string, unknown>} message
 * @returns {void}
 */
function settlePending(pending, message) {
  const errorBody = message.error;
  const hasError = Boolean(errorBody);
  if (hasError) {
    const text =
      isObject(errorBody) && typeof errorBody.message === "string" && errorBody.message !== ""
        ? errorBody.message
        : "Auxiliary app-server JSON-RPC error.";
    pending.reject(new Error(text));
    return;
  }
  pending.resolve(message.result);
}

/**
 * Elicitation response for an app-server permission request.
 * @param {unknown} id
 * @param {boolean} approved
 * @returns {Record<string, unknown>}
 */
function elicitationResponse(id, approved) {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      action: approved ? "accept" : "decline",
      content: approved ? {} : null,
      _meta: null,
    },
  };
}

/**
 * Map a tool result, or request one transport restart.
 * @param {unknown} result
 * @param {string} tool
 * @param {CallContext} context
 * @returns {AuxiliaryResult | undefined}
 */
export function toolReport(result, tool, context) {
  if (!isObject(result) || !isUnknownArray(result.content)) {
    throw failure("protocol-error", "Auxiliary tool returned no content array.");
  }
  const text = textOf(result);
  const isError = Boolean(result.isError) || Boolean(result.is_error) || stoppedSession(text);
  if (restartOnReport(tool, context, text, isError)) {
    return;
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
  return resultOf(context, { ...result, content, isError }, "reported");
}

/**
 * Attach macuse run evidence to a tool result.
 * @param {CallContext} context
 * @param {AuxiliaryResult} result
 * @param {string} outcome
 * @param {string} [reason]
 * @returns {AuxiliaryResult}
 */
export function resultOf(context, result, outcome, reason) {
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
export function errorResultOf(context, error) {
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
  return resultOf(
    context,
    { content: [{ type: "text", text: message }], isError: true },
    context.dispatched ? "unknown" : "not_dispatched",
    reason,
  );
}

/**
 * Elicitations are approved only for an active dispatched tool call.
 * @param {CallContext | null} active
 * @param {Map<number, PendingRequest>} pending
 * @returns {boolean}
 */
export function elicitationApproved(active, pending) {
  return Boolean(
    active &&
    !active.controller.signal.aborted &&
    [...pending.values()].some((request) => request.method === "mcpServer/tool/call"),
  );
}

/**
 * Respond to an app-server request message.
 * @param {Record<string, unknown>} message
 * @param {import("node:child_process").ChildProcess} proc
 * @param {(message: unknown) => void} write
 * @param {boolean} approved
 * @returns {void}
 */
export function respondToServer(message, proc, write, approved) {
  if (
    !Object.hasOwn(message, "id") ||
    typeof message.method !== "string" ||
    proc.stdin === null ||
    !proc.stdin.writable
  ) {
    return;
  }
  write(
    message.method === "mcpServer/elicitation/request"
      ? elicitationResponse(message.id, approved)
      : {
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: `Unsupported app-server request: ${message.method}` },
        },
  );
}

/**
 * Write one JSON-RPC message to the app-server transport.
 * @param {import("node:child_process").ChildProcess | null} proc
 * @param {unknown} message
 * @returns {void}
 */
export function writeMessage(proc, message) {
  if (proc === null || proc.stdin === null || !proc.stdin.writable) {
    throw failure("transport-closed", "Auxiliary app-server transport closed before write.");
  }
  proc.stdin.write(`${JSON.stringify(message)}\n`);
}
