import { MACUSE_API_DOC, SUPPRESS_STATE_END, SUPPRESS_STATE_START } from "./cua-banner.mjs";
import { imageMetadata } from "./cua-image-metadata.mjs";

/**
 * @typedef {import("@modelcontextprotocol/sdk/types.js").ContentBlock} ContentBlock
 * @typedef {import("./cua-guard-service.mjs").GuardAction} GuardAction
 * @typedef {import("./app-state.mjs").AppObservation} AppObservation
 * @typedef {{ runId: string, actions: GuardAction[], observations: AppObservation[], resolvedApps?: Record<string, string> | undefined, [key: string]: unknown }} GuardRunMeta
 */

export const inspectAdvice =
  "Execution stopped. A dispatched GUI effect may still have occurred. Inspect fresh app state before continuing; do not automatically replay this code.";

/**
 * @param {string | undefined} message
 * @returns {boolean}
 */
export function hasFailure(message) {
  return message !== undefined && message !== "";
}

/**
 * @param {string} text
 * @returns {boolean}
 */
function isVendorApiDoc(text) {
  return (
    text.startsWith("## Computer Use\n\nControl native apps and browsers") &&
    text.includes("cua_repl")
  );
}

/**
 * Strip state slices wrapped by `cua.getApp(..., { emit: false })`.
 * @param {string} text
 * @returns {string}
 */
function stripSuppressedState(text) {
  let out = "";
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf(SUPPRESS_STATE_START, cursor);
    if (start < 0) {
      out += text.slice(cursor);
      break;
    }
    out += text.slice(cursor, start);
    const end = text.indexOf(SUPPRESS_STATE_END, start + SUPPRESS_STATE_START.length);
    if (end < 0) {
      break;
    }
    cursor = end + SUPPRESS_STATE_END.length;
  }
  return out;
}

/**
 * @param {string} text
 * @returns {boolean}
 */
function isAppStateBlock(text) {
  return /^(?:<app_specific_instructions>[\s\S]*?<\/app_specific_instructions>\s*)?(?:<app_state>\s*)?(?:Window:\s*".*",\s*App:|0\s+(?:standard window|window|sheet|dialog|menu bar)\b|Apps:\s|Browsers:\s)/m.test(
    text,
  );
}

/**
 * @param {ContentBlock[]} content
 * @param {string} snippet
 * @returns {boolean}
 */
function contentIncludesText(content, snippet) {
  return content.some(
    (block) =>
      block.type === "text" && typeof block.text === "string" && block.text.includes(snippet),
  );
}

/**
 * @param {AppObservation} observation
 * @param {number | undefined} startedAt
 * @param {ContentBlock[]} content
 * @returns {boolean}
 */
function isFreshRunObservation(observation, startedAt, content) {
  if (startedAt !== undefined && observation.observedAt < startedAt) {
    return false;
  }
  return observation.text !== "" && !contentIncludesText(content, observation.text);
}

/**
 * @param {ContentBlock[]} content
 * @param {{ interrupted?: string | undefined, startedAt?: number | undefined, timeoutMs?: number | undefined }} active
 * @param {GuardRunMeta | undefined} meta
 * @param {{ isError: boolean, unknown: boolean }} summary
 */
function appendFailureObservations(content, active, meta, { isError, unknown }) {
  if (
    active.interrupted === "timeout" &&
    !content.some((block) => block.type === "text" && /timed?\s*out|timeout/i.test(block.text))
  ) {
    content.push({
      type: "text",
      text: `Execution timed out after ${active.timeoutMs ?? 90_000}ms; kernel reset.`,
    });
  }
  if (!isError || unknown || active.interrupted !== undefined || meta === undefined) {
    return;
  }
  for (const observation of meta.observations) {
    if (isFreshRunObservation(observation, active.startedAt, content)) {
      content.push({
        type: "text",
        text: `Latest observed ${observation.app} state from this failed run:\n${observation.text}`,
      });
    }
  }
}

/**
 * @param {string} raw
 * @param {{ failed: boolean, suppressDocs: boolean, content: ContentBlock[], lastStateText: string | undefined }} state
 * @returns {{ sawDocs: boolean, lastStateText: string | undefined }}
 */
function appendNormalizedText(raw, state) {
  const rewritten = state.failed
    ? raw.replace(/\b(?:please\s+)?rerun your request[^\n.]*(?:\.|$)/gi, inspectAdvice)
    : raw;
  if (rewritten === MACUSE_API_DOC || isVendorApiDoc(rewritten)) {
    if (!state.suppressDocs) {
      state.content.push({ type: "text", text: MACUSE_API_DOC });
    }
    return { sawDocs: true, lastStateText: state.lastStateText };
  }
  let lastStateText = state.lastStateText;
  const visible = stripSuppressedState(rewritten);
  if (visible === "" || (visible === "\n" && !rewritten.includes(SUPPRESS_STATE_START))) {
    return { sawDocs: false, lastStateText };
  }
  if (isAppStateBlock(visible)) {
    const stateText = visible.replace(/\n+$/, "");
    if (stateText === lastStateText) {
      return { sawDocs: false, lastStateText };
    }
    lastStateText = stateText;
    state.content.push({ type: "text", text: stateText });
    return { sawDocs: false, lastStateText };
  }
  state.content.push({ type: "text", text: visible });
  return { sawDocs: false, lastStateText };
}

/**
 * @param {{ content: ContentBlock[], isError?: boolean | undefined } | undefined} result
 * @param {boolean} suppressDocs
 */
export function normalizeContentBlocks(result, suppressDocs) {
  /** @type {Record<string, unknown>[]} */
  const images = [];
  /** @type {ContentBlock[]} */
  const content = [];
  const failed = result?.isError === true;
  let sawDocs = false;
  /** @type {string | undefined} */
  let lastStateText;
  for (const current of result?.content ?? []) {
    if (current.type === "text") {
      const next = appendNormalizedText(current.text, {
        failed,
        suppressDocs,
        content,
        lastStateText,
      });
      sawDocs ||= next.sawDocs;
      lastStateText = next.lastStateText;
    } else if (current.type === "image") {
      const metadata = imageMetadata(current.data);
      images.push({
        index: content.length,
        ...metadata,
        coordinateSpace: "native-screenshot",
        scale: "No OS-point or Retina scale inferred.",
      });
      content.push(
        metadata.mimeType !== undefined ? { ...current, mimeType: metadata.mimeType } : current,
      );
    }
  }
  return { content, images, sawDocs };
}

/**
 * @param {{ result: { content: ContentBlock[], isError?: boolean | undefined } | undefined, failure: string | undefined }} outcome
 * @param {{ unknown: boolean, isError: boolean, active: { interrupted?: string | undefined, startedAt?: number | undefined, timeoutMs?: number | undefined }, meta: GuardRunMeta | undefined, suppressDocs: boolean }} summary
 * @param {GuardAction[]} actions
 */
export function buildResultContent(
  { result, failure },
  { unknown, isError, active, meta, suppressDocs },
  actions,
) {
  const { content, images, sawDocs } = normalizeContentBlocks(result, suppressDocs);
  appendFailureObservations(content, active, meta, { isError, unknown });
  if (failure !== undefined && hasFailure(failure)) {
    content.push({ type: "text", text: failure });
  }
  if (unknown && !contentIncludesText(content, inspectAdvice)) {
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
  return { content, images, sawDocs };
}
