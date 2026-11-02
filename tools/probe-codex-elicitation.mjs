import { createInterface } from "node:readline/promises";
import { TimeoutError, isRecord, sanitizeForLog } from "./probe-codex-core.mjs";

/** @typedef {import("./probe-codex-core.mjs").ElicitationDecision} ElicitationDecision */
/** @typedef {import("./probe-codex-core.mjs").ElicitationHandler} ElicitationHandler */
/** @typedef {import("./probe-codex-core.mjs").ProbeStats} ProbeStats */
/**
 * @param {{ mode: string, elicitationTimeoutMs: number, logger: import("./probe-codex-core.mjs").EventLogger }} options
 * @returns {ElicitationHandler}
 */
export function createElicitationHandler({ mode, elicitationTimeoutMs, logger }) {
  let acceptedOnce = false;
  return async (params, context) => {
    const message = isRecord(params) ? params.message : undefined;
    if (mode === "deny") {
      logger.event("elicitation.auto_decision", {
        count: context.count,
        action: "decline",
        message,
      });
      return { action: "decline" };
    }

    if (mode === "accept-once") {
      if (!acceptedOnce) {
        acceptedOnce = true;
        logger.event("elicitation.auto_decision", {
          count: context.count,
          action: "accept",
          message,
        });
        return { action: "accept", content: {} };
      }
      logger.event("elicitation.accept_once_exhausted", {
        count: context.count,
        action: "decline",
        message,
      });
      return { action: "decline" };
    }

    if (mode === "interactive") {
      return promptForElicitation(params, { elicitationTimeoutMs, logger });
    }

    throw new Error(`unsupported elicitation mode: ${mode}`);
  };
}

/**
 * @param {unknown} params
 * @param {{ elicitationTimeoutMs: number, logger: import("./probe-codex-core.mjs").EventLogger }} context
 * @returns {Promise<ElicitationDecision>}
 */
export async function promptForElicitation(params, { elicitationTimeoutMs, logger }) {
  printElicitationPrompt(params);
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    /** @type {Promise<never>} */
    const timeout = new Promise((_, reject) => {
      setTimeout(() => {
        reject(new TimeoutError(`elicitation prompt timed out after ${elicitationTimeoutMs}ms`));
      }, elicitationTimeoutMs);
    });
    const answer = await Promise.race([rl.question("Elicitation response [decline]: "), timeout]);
    return decisionFor(answer.trim(), logger);
  } finally {
    rl.close();
  }
}

/**
 * Print the elicitation request details for the operator.
 * @param {unknown} params
 */
function printElicitationPrompt(params) {
  const record = isRecord(params) ? params : undefined;
  process.stderr.write("\nMCP elicitation/create request\n");
  const message = typeof record?.message === "string" ? record.message : "(none)";
  process.stderr.write(`Message: ${message}\n`);
  process.stderr.write(
    `Requested schema: ${JSON.stringify(sanitizeForLog(record?.requestedSchema ?? {}))}\n`,
  );
  process.stderr.write(
    'Actions: accept, decline, cancel. Use `accept {"field":"value"}` to provide JSON content if needed.\n',
  );
}

/**
 * Map a trimmed operator answer to an elicitation decision.
 * @param {string} trimmed
 * @param {import("./probe-codex-core.mjs").EventLogger} logger
 * @returns {ElicitationDecision}
 */
function decisionFor(trimmed, logger) {
  if (trimmed === "" || /^d(?:ecline)?$/i.test(trimmed)) {
    logger.event("elicitation.operator_decision", { action: "decline" });
    return { action: "decline" };
  }
  if (/^c(?:ancel)?$/i.test(trimmed)) {
    logger.event("elicitation.operator_decision", { action: "cancel" });
    return { action: "cancel" };
  }
  if (/^a(?:ccept)?(?:\s|$)/i.test(trimmed)) {
    return acceptDecision(trimmed, logger);
  }
  throw new Error(`unknown elicitation response: ${trimmed}`);
}

/**
 * Build the accept decision, parsing any JSON content after the keyword.
 * @param {string} trimmed
 * @param {import("./probe-codex-core.mjs").EventLogger} logger
 * @returns {ElicitationDecision}
 */
function acceptDecision(trimmed, logger) {
  const jsonPart = trimmed.replace(/^a(?:ccept)?/i, "").trim();
  /** @type {Record<string, unknown>} */
  let content = {};
  if (jsonPart !== "") {
    try {
      const parsed = /** @type {unknown} */ (JSON.parse(jsonPart));
      if (isRecord(parsed)) {
        content = parsed;
      }
    } catch (error) {
      throw new Error(
        `invalid accept JSON content: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
  logger.event("elicitation.operator_decision", {
    action: "accept",
    contentKeys: Object.keys(content),
  });
  return { action: "accept", content };
}
