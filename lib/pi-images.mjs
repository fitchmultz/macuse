import { formatDimensionNote } from "@earendil-works/pi-coding-agent";
import { resizeOriginal, settleAll } from "./pi-image-resize.mjs";

/** Structural model view: a full Pi model with the fields this hook reads. */
/** @typedef {{ id: string, api: string }} ModelLike */
/** @typedef {Parameters<typeof import("@earendil-works/pi-coding-agent").resizeImage>[2]} ImageResizeOptions */
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
 * @typedef {{index: number, source: ContentPart, data: string, mimeType: string, part: ContentPart, note: ContentPart | undefined}} PendingImage
 */

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
 * @returns {value is ContentPart[]}
 */
const isContentPartArray = (value) => Array.isArray(value) && value.every(isContentPart);

/**
 * @param {unknown} value
 * @returns {value is Array<Record<string, unknown>>}
 */
const isRecordArray = (value) => Array.isArray(value) && value.every((item) => isRecord(item));

/**
 * A retained resize-options field is absent or a number.
 * @param {unknown} value
 * @returns {boolean}
 */
const optionalNumber = (value) => value === undefined || typeof value === "number";

/**
 * @param {unknown} value
 * @returns {boolean}
 */
const isRetainedResizeOptions = (value) =>
  isRecord(value) &&
  optionalNumber(value.maxWidth) &&
  optionalNumber(value.maxHeight) &&
  optionalNumber(value.maxBytes) &&
  optionalNumber(value.jpegQuality);

/**
 * @param {unknown} value
 * @returns {value is MacuseRetained}
 */
const isMacuseRetained = (value) =>
  isRecord(value) &&
  (value.originalResizeOptions === undefined ||
    isRetainedResizeOptions(value.originalResizeOptions));

/**
 * @param {HookMessage | null | undefined} message
 * @returns {message is HookMessage}
 */
const macuseToolResult = (message) =>
  message !== null &&
  message !== undefined &&
  message.role === "toolResult" &&
  message.toolName === "macuse";

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
    if (!isRecord(part) || !isRecord(wanted)) {
      return false;
    }
    return (
      Object.keys(part).length === Object.keys(wanted).length &&
      Object.keys(wanted).every((key) => part[key] === wanted[key])
    );
  });

/**
 * The macuse retained-originals record on a saved message, if present.
 * @param {HookMessage} saved
 * @returns {unknown}
 */
const retainedDetails = (saved) => {
  const savedDetails = saved.details;
  return isRecord(savedDetails) && "macuse" in savedDetails ? savedDetails.macuse : undefined;
};

/**
 * @param {ContentPart[]} content
 * @param {MacuseRetained} details
 * @returns {ContentPart[] | undefined}
 */
const originalContent = (content, details) => {
  if (isContentPartArray(details.originalContent)) {
    return details.originalContent;
  }
  if (!isRecordArray(details.originalImages) || typeof details.originalText !== "string") {
    return;
  }
  const restored = images(content).slice();
  /** @type {Set<number>} */
  const indices = new Set();
  for (const { index, ...part } of details.originalImages) {
    if (
      typeof index !== "number" ||
      !isContentPart(part) ||
      !restorableImageEntry(index, part, restored.length, indices)
    ) {
      return;
    }
    indices.add(index);
    restored[index] = part;
  }
  return [{ type: "text", text: details.originalText }, ...restored];
};

/**
 * A retained image entry targets one untouched image slot.
 * @param {number} index
 * @param {ContentPart} part
 * @param {number} count
 * @param {Set<number>} indices
 * @returns {boolean}
 */
const restorableImageEntry = (index, part, count, indices) =>
  Number.isInteger(index) &&
  index >= 0 &&
  index < count &&
  !indices.has(index) &&
  part.type === "image" &&
  typeof part.data === "string" &&
  typeof part.mimeType === "string";

/**
 * Native screenshot bytes eligible for re-deriving Pi's resize.
 * @param {ContentPart | undefined} source
 * @returns {{ data: string, mimeType: string } | undefined}
 */
const retainableSource = (source) => {
  if (source === undefined || source.data === undefined || source.mimeType === undefined) {
    return;
  }
  return ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(source.mimeType)
    ? { data: source.data, mimeType: source.mimeType }
    : undefined;
};

/**
 * A re-derived resize reproduces Pi's stored image part exactly.
 * @param {import("@earendil-works/pi-coding-agent").ResizedImage | null} resized
 * @param {ContentPart} part
 * @returns {resized is import("@earendil-works/pi-coding-agent").ResizedImage}
 */
const resizedMatches = (resized, part) =>
  resized !== null &&
  resized.wasResized &&
  resized.data === part.data &&
  resized.mimeType === part.mimeType;

/**
 * The note following a resized image matches Pi's dimension note.
 * @param {ContentPart | undefined} note
 * @param {import("@earendil-works/pi-coding-agent").ResizedImage} resized
 * @returns {boolean}
 */
const dimensionNoteMatches = (note, resized) =>
  note !== undefined && note.type === "text" && note.text === formatDimensionNote(resized);

/**
 * Collect changed images and the surrounding text before dispatching resizes.
 * @param {ContentPart[]} content
 * @param {ContentPart[]} before
 * @returns {{ pending: PendingImage[], remaining: ContentPart[] } | undefined}
 */
const retainedImageChanges = (content, before) => {
  /** @type {PendingImage[]} */
  const pending = [];
  /** @type {ContentPart[]} */
  const remaining = [];
  let index = 0;
  for (let position = 0; position < content.length; position++) {
    const part = content[position];
    if (part === undefined) {
      continue;
    }
    if (part.type !== "image") {
      remaining.push(part);
      continue;
    }
    const source = before[index];
    if (sameImage(source, part)) {
      index++;
      continue;
    }
    const sourceBytes = retainableSource(source);
    if (sourceBytes === undefined || source === undefined) {
      // Native screenshots are PNG. Unsupported conversion provenance fails
      // closed rather than reproducing Pi's private image-processing pipeline.
      return;
    }
    pending.push({ index, source, ...sourceBytes, part, note: content[++position] });
    index++;
  }
  return { pending, remaining };
};

/**
 * Reproduce every resize before accepting retained original images.
 * @param {PendingImage[]} pending
 * @param {ImageResizeOptions | undefined} profile
 * @returns {Promise<Array<{index: number} & ContentPart> | undefined>}
 */
const verifiedImageChanges = async (pending, profile) => {
  const resized = await settleAll(
    pending.map(({ data, mimeType }) => resizeOriginal(data, mimeType, profile)),
  );
  if (
    !pending.every((image, i) => {
      const candidate = resized[i];
      return (
        candidate !== undefined &&
        resizedMatches(candidate, image.part) &&
        dimensionNoteMatches(image.note, candidate)
      );
    })
  ) {
    return;
  }
  return pending.map((image) => Object.assign({ index: image.index }, image.source));
};

/**
 * The retained original's images pair one-to-one with the current output.
 * @param {ContentPart[] | undefined} original
 * @param {ContentPart[]} content
 * @returns {{ before: ContentPart[], original: ContentPart[] } | undefined}
 */
const retainedPair = (original, content) => {
  if (!Array.isArray(original)) {
    return;
  }
  const before = images(original);
  return before.length === images(content).length ? { before, original } : undefined;
};

/**
 * Keep verified originals only when Pi resized at least one image.
 * @param {Array<{index: number} & ContentPart> | undefined} changed
 * @param {ContentPart[]} original
 * @param {ImageResizeOptions | undefined} profile
 * @returns {MacuseRetained}
 */
const verifiedImageDetails = (changed, original, profile) => {
  if (changed === undefined || changed.length === 0) {
    return {};
  }
  return {
    originalImages: changed,
    originalText: text(original),
    originalResizeOptions: profile ?? {},
  };
};

// Public native resize bytes and notes, not arbitrary output differences, prove
// attribution. A later tool_result hook may redact either images or text.
/**
 * @param {HookMessage | null | undefined} message
 * @param {ImageResizeOptions | undefined} resizeOptions
 * @returns {Promise<void>}
 */
export async function retainMacuseOriginals(message, resizeOptions) {
  if (!macuseToolResult(message)) {
    return;
  }
  const macuseRecord = retainedDetails(message);
  if (!isMacuseRetained(macuseRecord)) {
    return;
  }
  const content = message.content;
  if (!isContentPartArray(content)) {
    return;
  }
  const retained = macuseRecord;
  const original = originalContent(content, retained);
  const profile = retained.originalResizeOptions ?? resizeOptions;
  delete retained.originalContent;
  delete retained.originalImages;
  delete retained.originalText;
  delete retained.originalResizeOptions;
  const pair = retainedPair(original, content);
  if (pair === undefined) {
    return;
  }
  const outcome = retainedImageChanges(content, pair.before);
  if (outcome === undefined || text(outcome.remaining) !== text(pair.original)) {
    return;
  }
  const changed = await verifiedImageChanges(outcome.pending, profile);
  Object.assign(retained, verifiedImageDetails(changed, pair.original, profile));
}

/**
 * A wire output item this hook may need to restore.
 * @param {WireItem} item
 * @returns {boolean}
 */
const restorableWireItem = (item) =>
  ["function_call_output", "custom_tool_call_output"].includes(item.type) &&
  Array.isArray(item.output) &&
  item.output.some((part) => isRecord(part) && part.type === "input_image");

/**
 * A saved message with intact retained-originals evidence.
 * @param {HookMessage | null | undefined} saved
 * @returns {{ details: MacuseRetained, content: ContentPart[] } | undefined}
 */
const savedSnapshot = (saved) => {
  if (saved === null || saved === undefined) {
    return;
  }
  const details = retainedDetails(saved);
  if (!isMacuseRetained(details) || !isContentPartArray(saved.content)) {
    return;
  }
  return { details, content: saved.content };
};

// Restore only raw, intact retained outputs selected through this request's
// actual messages. A redaction/context edit must never become the baseline.
/**
 * @param {{ input?: WireItem[] } | null | undefined} payload
 * @param {Map<string, HookMessage | null>} retained
 * @param {ModelLike | null | undefined} model
 * @returns {{ input?: WireItem[] } | undefined}
 */
export function restoreMacuseImages(payload, retained, model) {
  if (!canRestoreMacuseImages(model) || !Array.isArray(payload?.input)) {
    return;
  }
  const state = { changed: false };
  const input = payload.input.map((item) => {
    if (!restorableWireItem(item)) {
      return item;
    }
    const snapshot = savedSnapshot(retained.get(item.call_id));
    if (snapshot === undefined || !sameWire(item.output, wireContent(snapshot.content))) {
      return item;
    }
    const original = originalContent(snapshot.content, snapshot.details);
    if (
      !Array.isArray(original) ||
      images(original).length !== images(snapshot.content).length ||
      images(original).every((part, i) => sameImage(part, images(snapshot.content)[i]))
    ) {
      return item;
    }
    state.changed = true;
    return { ...item, output: wireContent(original) };
  });
  if (state.changed) {
    return { ...payload, input };
  }
  return;
}

/**
 * Whether a request message is the same retained snapshot as its saved copy.
 * @param {HookMessage} message
 * @param {HookMessage | null | undefined} saved
 * @returns {boolean}
 */
const sameMessageSnapshot = (message, saved) =>
  saved !== null &&
  saved !== undefined &&
  message.toolCallId !== undefined &&
  message.toolCallId === saved.toolCallId &&
  message.timestamp === saved.timestamp &&
  isContentPartArray(message.content) &&
  isContentPartArray(saved.content) &&
  sameWire(wireContent(message.content), wireContent(saved.content));

/**
 * Retained snapshots for the request's own macuse tool results.
 * @param {HookMessage[]} messages
 * @param {Map<string, HookMessage | null>} retained
 * @returns {Map<string, HookMessage>}
 */
const selectedMessages = (messages, retained) => {
  /** @type {Map<string, HookMessage>} */
  const selected = new Map();
  for (const message of messages) {
    if (
      message.role !== "toolResult" ||
      message.toolName !== "macuse" ||
      message.toolCallId === undefined ||
      !isContentPartArray(message.content)
    ) {
      continue;
    }
    const key = message.toolCallId.split("|")[0] ?? "";
    const saved = retained.get(key);
    if (saved === null || saved === undefined || !sameMessageSnapshot(message, saved)) {
      continue;
    }
    selected.set(key, saved);
  }
  return selected;
};

/**
 * Walk the appended suffix from a leaf toward a known entry.
 * @param {SessionManager} sm
 * @param {string | null} from
 * @param {string | null | undefined} stopAt
 * @returns {{ suffix: Array<NonNullable<ReturnType<SessionManager["getEntry"]>>>, stoppedAt: string | null }}
 */
const walkSuffix = (sm, from, stopAt) => {
  const suffix = [];
  const seen = new Set();
  let id = from;
  while (id !== null && id !== "" && id !== stopAt) {
    const entry = sm.getEntry(id);
    if (!entry || seen.has(id)) {
      break;
    }
    seen.add(id);
    suffix.push(entry);
    id = entry.parentId;
  }
  return { suffix, stoppedAt: id };
};

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
    if (!macuseToolResult(message) || message.toolCallId === undefined) {
      return;
    }
    await retainMacuseOriginals(message, resizeOptions);
    const key = message.toolCallId.split("|")[0] ?? "";
    // A reused wire ID cannot establish which original produced a resized
    // payload. The finalized event and its appended entry share one object.
    if (retained.has(key) && retained.get(key) !== message) {
      retained.set(key, null);
    } else {
      retained.set(key, message);
    }
  };
  /**
   * Re-index this manager's current context into the retained window.
   * @param {SessionManager} sm
   * @param {ImageResizeOptions | undefined} resizeOptions
   * @returns {Promise<void>}
   */
  const reconcile = async (sm, resizeOptions) => {
    const current = sm.getLeafId();
    const walk =
      manager === sm ? walkSuffix(sm, current, leaf) : { suffix: [], stoppedAt: current };
    const reseed =
      manager !== sm ||
      walk.stoppedAt !== leaf ||
      walk.suffix.some((entry) => entry.type === "compaction");
    if (reseed) {
      retained.clear();
    }
    /** @type {Promise<void>[]} */
    const adds = [];
    for (const entry of reseed ? sm.buildContextEntries() : walk.suffix) {
      if (entry.type === "message") {
        adds.push(add(entry.message, resizeOptions));
      }
    }
    await settleAll(adds);
    manager = sm;
    leaf = current;
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
      if (manager !== undefined) {
        await add(message, resizeOptions);
      } else {
        await retainMacuseOriginals(message, resizeOptions);
      }
    },
    /**
     * @param {SessionManager} sm
     * @param {HookMessage[]} messages
     * @param {ImageResizeOptions | undefined} resizeOptions
     * @returns {Promise<Map<string, HookMessage>>}
     */
    async select(sm, messages, resizeOptions) {
      await reconcile(sm, resizeOptions);
      return selectedMessages(messages, retained);
    },
  };
}
