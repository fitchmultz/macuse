import { formatDimensionNote, resizeImage } from "@earendil-works/pi-coding-agent";

/** Structural model view: a full Pi model with the fields this hook reads. */
/** @typedef {{ id: string, api: string }} ModelLike */
/** @typedef {Parameters<typeof resizeImage>[2]} ImageResizeOptions */
/** @typedef {import("@earendil-works/pi-coding-agent").SessionManager} SessionManager */

/**
 * Structural view of the Pi content parts this hook reads. Pi owns the full
 * message shapes; only the fields used here are declared.
 * @typedef {{ type: string, text?: string, data?: string, mimeType?: string }} ContentPart
 */

/**
 * The macuse retained-originals protocol stored on toolResult details.
 * Written and read only by this module.
 * @typedef {{ originalContent?: unknown, originalImages?: unknown, originalText?: string | undefined, originalResizeOptions?: ImageResizeOptions | undefined }} MacuseRetained
 */

/**
 * Structural view of the Pi messages and provider wire items this hook sees.
 * Pi's AgentMessage is an open union (custom message types), so only the
 * fields this hook reads are declared; role checks guard the toolResult reads.
 * @typedef {{ role: string, toolName?: string, toolCallId?: string, timestamp?: unknown, content?: unknown, details?: unknown }} HookMessage
 * @typedef {{ type: string, call_id: string, output?: unknown }} WireItem
 */

/**
 * @param {unknown} value
 * @returns {value is MacuseRetained}
 */
const isMacuseRetained = (value) =>
  isRecord(value) &&
  (value.originalResizeOptions === undefined ||
    (isRecord(value.originalResizeOptions) &&
      (value.originalResizeOptions.maxWidth === undefined ||
        typeof value.originalResizeOptions.maxWidth === "number") &&
      (value.originalResizeOptions.maxHeight === undefined ||
        typeof value.originalResizeOptions.maxHeight === "number") &&
      (value.originalResizeOptions.maxBytes === undefined ||
        typeof value.originalResizeOptions.maxBytes === "number") &&
      (value.originalResizeOptions.jpegQuality === undefined ||
        typeof value.originalResizeOptions.jpegQuality === "number")));

/**
 * @param {unknown} value
 * @returns {value is ContentPart[]}
 */
const isContentPartArray = (value) => Array.isArray(value) && value.every(isContentPart);

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isRecord = (value) => typeof value === "object" && value !== null;

/**
 * @param {unknown} value
 * @returns {value is ContentPart}
 */
const isContentPart = (value) => isRecord(value) && typeof value.type === "string";

/**
 * @param {unknown} value
 * @returns {value is Array<Record<string, unknown>>}
 */
const isRecordArray = (value) => Array.isArray(value) && value.every((item) => isRecord(item));

/**
 * @param {ModelLike | null | undefined} model
 * @returns {boolean}
 */
export const canRestoreMacuseImages = (model) =>
  model?.id === "gpt-6-astra" && ["openai-responses", "openai-codex-responses"].includes(model.api);

/**
 * @param {ContentPart[]} content
 * @returns {ContentPart[]}
 */
const images = (content) => content.filter((part) => part.type === "image");
/**
 * @param {ContentPart[]} content
 * @returns {string}
 */
const text = (content) =>
  content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .toWellFormed();
/**
 * @param {ContentPart[]} content
 * @returns {{ type: string, [key: string]: unknown }[]}
 */
const wireContent = (content) => [
  ...(text(content) !== "" ? [{ type: "input_text", text: text(content) }] : []),
  ...images(content).map((part) => ({
    type: "input_image",
    detail: "auto",
    image_url: `data:${part.mimeType ?? ""};base64,${part.data ?? ""}`,
  })),
];
/**
 * @param {ContentPart | undefined} a
 * @param {ContentPart | undefined} b
 * @returns {boolean}
 */
const sameImage = (a, b) =>
  a?.type === b?.type && a?.mimeType === b?.mimeType && a?.data === b?.data;
/**
 * @param {unknown} actual
 * @param {unknown} expected
 * @returns {boolean}
 */
const sameWire = (actual, expected) =>
  Array.isArray(actual) &&
  Array.isArray(expected) &&
  actual.length === expected.length &&
  actual.every((part, i) => {
    const wanted = /** @type {unknown} */ (expected[i]);
    if (!isRecord(part) || !isRecord(wanted)) return false;
    return (
      Object.keys(part).length === Object.keys(wanted).length &&
      Object.keys(wanted).every((key) => part[key] === wanted[key])
    );
  });

/**
 * @param {ContentPart[]} content
 * @param {MacuseRetained} details
 * @returns {ContentPart[] | undefined}
 */
const originalContent = (content, details) => {
  if (isContentPartArray(details.originalContent)) return details.originalContent;
  if (!isRecordArray(details.originalImages) || typeof details.originalText !== "string") return;
  const restored = images(content).slice(),
    indices = new Set();
  for (const { index, ...part } of details.originalImages) {
    if (
      typeof index !== "number" ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= restored.length ||
      indices.has(index) ||
      !isContentPart(part) ||
      part.type !== "image" ||
      typeof part.data !== "string" ||
      typeof part.mimeType !== "string"
    )
      return;
    indices.add(index);
    restored[index] = part;
  }
  return [{ type: "text", text: details.originalText }, ...restored];
};

// Public native resize bytes and notes, not arbitrary output differences, prove
// attribution. A later tool_result hook may redact either images or text.
/**
 * @param {HookMessage | null | undefined} message
 * @param {ImageResizeOptions | undefined} resizeOptions
 * @returns {Promise<void>}
 */
export async function retainMacuseOriginals(message, resizeOptions) {
  if (
    message === null ||
    message === undefined ||
    message.role !== "toolResult" ||
    message.toolName !== "macuse"
  )
    return;
  const detailsRecord = message.details;
  const macuseRecord =
    isRecord(detailsRecord) && "macuse" in detailsRecord ? detailsRecord.macuse : undefined;
  if (!isMacuseRetained(macuseRecord)) return;
  const details = macuseRecord;
  const content = message.content;
  if (!isContentPartArray(content)) return;
  const original = originalContent(content, details);
  const profile = details.originalResizeOptions ?? resizeOptions;
  delete details.originalContent;
  delete details.originalImages;
  delete details.originalText;
  delete details.originalResizeOptions;
  if (!Array.isArray(original)) return;
  const before = images(original),
    after = images(content);
  if (before.length !== after.length) return;
  const changed = [],
    remaining = [];
  let index = 0;
  for (let position = 0; position < content.length; position++) {
    const part = content[position];
    if (part === undefined) continue;
    if (part.type !== "image") {
      remaining.push(part);
      continue;
    }
    const source = before[index];
    if (!sameImage(source, part)) {
      // Native screenshots are PNG. Unsupported conversion provenance fails
      // closed rather than reproducing Pi's private image-processing pipeline.
      if (
        source === undefined ||
        source.data === undefined ||
        source.mimeType === undefined ||
        !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(source.mimeType)
      )
        return;
      const resized = await resizeImage(
        Buffer.from(source.data, "base64"),
        source.mimeType,
        profile,
      );
      if (
        resized === null ||
        !resized.wasResized ||
        resized.data !== part.data ||
        resized.mimeType !== part.mimeType
      )
        return;
      const note = content[++position];
      if (note === undefined || note.type !== "text" || note.text !== formatDimensionNote(resized))
        return;
      changed.push({ index, ...source });
    }
    index++;
  }
  if (text(remaining) !== text(original)) return;
  if (changed.length > 0) {
    details.originalImages = changed;
    details.originalText = text(original);
    details.originalResizeOptions = profile ?? {};
  }
}

// Restore only raw, intact retained outputs selected through this request's
// actual messages. A redaction/context edit must never become the baseline.
/**
 * @param {{ input?: WireItem[] } | null | undefined} payload
 * @param {Map<string, HookMessage | null>} retained
 * @param {ModelLike | null | undefined} model
 * @returns {{ input?: WireItem[] } | undefined}
 */
export function restoreMacuseImages(payload, retained, model) {
  if (!canRestoreMacuseImages(model) || !Array.isArray(payload?.input)) return;
  const state = { changed: false };
  const input = payload.input.map((item) => {
    if (
      !["function_call_output", "custom_tool_call_output"].includes(item.type) ||
      !Array.isArray(item.output) ||
      !item.output.some((part) => isRecord(part) && part.type === "input_image")
    )
      return item;
    const saved = retained.get(item.call_id);
    if (saved === null || saved === undefined) return item;
    const savedDetails = saved.details;
    const details =
      isRecord(savedDetails) && "macuse" in savedDetails ? savedDetails.macuse : undefined;
    const savedContent = saved.content;
    if (
      !isMacuseRetained(details) ||
      !isContentPartArray(savedContent) ||
      !sameWire(item.output, wireContent(savedContent))
    )
      return item;
    const original = originalContent(savedContent, details);
    if (
      !Array.isArray(original) ||
      images(original).length !== images(savedContent).length ||
      images(original).every((part, i) => sameImage(part, images(savedContent)[i]))
    )
      return item;
    state.changed = true;
    return { ...item, output: wireContent(original) };
  });
  if (state.changed) return { ...payload, input };
  return;
}

// One retained-window index, not another journal. Reconcile only the appended
// suffix; drafts commit after turn_end, so the next request reads the new leaf.
export function macuseImageIndex() {
  /** @type {string | null | undefined} */
  let leaf;
  /** @type {SessionManager | undefined} */
  let manager;
  /** @type {Map<string, HookMessage | null>} */
  const retained = new Map();
  /**
   * @param {HookMessage | null | undefined} message
   * @param {ImageResizeOptions | undefined} resizeOptions
   * @returns {Promise<void>}
   */
  const add = async (message, resizeOptions) => {
    if (message === null || message === undefined) return;
    if (message.role !== "toolResult" || message.toolName !== "macuse") return;
    if (message.toolCallId === undefined) return;
    await retainMacuseOriginals(message, resizeOptions);
    const key = message.toolCallId.split("|")[0] ?? "";
    // A reused wire ID cannot establish which original produced a resized
    // payload. The finalized event and its appended entry share one object.
    if (retained.has(key) && retained.get(key) !== message) retained.set(key, null);
    else retained.set(key, message);
  };
  return {
    reset() {
      manager = undefined;
      leaf = undefined;
      retained.clear();
    },
    /**
     * @param {HookMessage | null | undefined} message
     * @param {ImageResizeOptions | undefined} resizeOptions
     * @returns {Promise<void>}
     */
    async messageEnd(message, resizeOptions) {
      if (manager !== undefined) await add(message, resizeOptions);
      else await retainMacuseOriginals(message, resizeOptions);
    },
    /**
     * @param {SessionManager} sm
     * @param {HookMessage[]} messages
     * @param {ImageResizeOptions | undefined} resizeOptions
     * @returns {Promise<Map<string, HookMessage>>}
     */
    async select(sm, messages, resizeOptions) {
      const current = sm.getLeafId();
      const suffix = [];
      const seen = new Set();
      let id = current;
      if (manager === sm) {
        while (id !== null && id !== "" && id !== leaf) {
          const entry = sm.getEntry(id);
          if (!entry || seen.has(id)) break;
          seen.add(id);
          suffix.push(entry);
          id = entry.parentId;
        }
      }
      if (manager !== sm || id !== leaf || suffix.some((entry) => entry.type === "compaction")) {
        retained.clear();
        for (const entry of sm.buildContextEntries())
          if (entry.type === "message") await add(entry.message, resizeOptions);
      } else {
        for (const entry of suffix.reverse())
          if (entry.type === "message") await add(entry.message, resizeOptions);
      }
      manager = sm;
      leaf = current;
      /** @type {Map<string, HookMessage>} */
      const selected = new Map();
      for (const message of messages)
        if (
          message.role === "toolResult" &&
          message.toolName === "macuse" &&
          message.toolCallId !== undefined &&
          isContentPartArray(message.content)
        ) {
          const key = message.toolCallId.split("|")[0] ?? "",
            saved = retained.get(key);
          if (
            saved !== null &&
            saved !== undefined &&
            message.toolCallId === saved.toolCallId &&
            message.timestamp === saved.timestamp &&
            isContentPartArray(saved.content) &&
            sameWire(wireContent(message.content), wireContent(saved.content))
          )
            selected.set(key, saved);
        }
      return selected;
    },
  };
}
