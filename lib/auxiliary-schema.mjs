import { readFileSync } from "node:fs";

const pkg = /** @type {unknown} */ (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
);
export const version =
  typeof pkg === "object" && pkg !== null && "version" in pkg && typeof pkg.version === "string"
    ? pkg.version
    : "";

/** @type {Record<string, { plugin: string, tools: string[] }>} */
export const servers = {
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
 * @param {{ properties?: Record<string, import("@modelcontextprotocol/sdk/validation").JsonSchemaType>, idempotent?: boolean }} [fields]
 */
const descriptor = (
  name,
  description,
  readOnly,
  { properties = {}, idempotent = readOnly } = {},
) => ({
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
    { properties: recording },
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
    { idempotent: true },
  ),
  descriptor(
    "computer_history_pause",
    "Pause Computer History. No recording approval flags required.",
    false,
    { idempotent: true },
  ),
  descriptor(
    "computer_history_resume",
    "Resume Computer History recording. Requires exact user intent, allowRecording:true, and a non-empty safetyNote.",
    false,
    { properties: recording, idempotent: true },
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
      properties: {
        observation: observationSchema,
        allowPrivacyChange: { const: true, type: "boolean" },
        safetyNote: nonempty,
      },
      idempotent: true,
    },
  ),
];
/** @type {Map<string, ReturnType<typeof descriptor>>} */
export const tools = new Map(auxiliaryTools.map((tool) => [tool.name, tool]));

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export const isObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
/**
 * @param {unknown} value
 * @returns {value is unknown[]}
 */
export const isUnknownArray = (value) => Array.isArray(value);
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
  if (!isObject(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new Error(`Unsupported ${label} fields: ${unknown.join(", ")}.`);
  }
}

/**
 * @param {string} tool
 * @param {Record<string, unknown>} input
 * @param {{ properties: Record<string, unknown> }} schema
 * @returns {void}
 */
function requireApprovalFlag(tool, input, schema) {
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
}

/**
 * @param {string} key
 * @param {unknown} value
 * @returns {unknown[]}
 */
function observationEntries(key, value) {
  if (!Array.isArray(value)) {
    throw new Error(`observation.${key} must be an array; send all observation fields.`);
  }
  return Array.from(/** @type {unknown[]} */ (value), (entry) => observationEntryCopy(key, entry));
}

/**
 * @param {string} key
 * @param {unknown} entry
 * @returns {Record<string, unknown>}
 */
function observationEntryCopy(key, entry) {
  checkKeys(entry, ["scope", "bundleID", "urlDomain"], `observation.${key} entry`);
  if (!isObject(entry)) {
    throw new Error(`observation.${key} entry must be an object.`);
  }
  const copy = { ...entry };
  for (const field of ["bundleID", "urlDomain"]) {
    if (Object.hasOwn(copy, field) && typeof copy[field] !== "string") {
      throw new Error(`${field} must be a string.`);
    }
  }
  if (copy.scope === "app" && hasText(copy.bundleID)) {
    return copy;
  }
  if (
    copy.scope === "url" &&
    typeof copy.urlDomain === "string" &&
    new RegExp(domainPattern).test(copy.urlDomain)
  ) {
    return copy;
  }
  throw new Error(
    "Observation entries require scope:app with a non-empty bundleID, or scope:url with a bare-domain urlDomain.",
  );
}

/**
 * @param {unknown} settings
 * @returns {Record<string, unknown>}
 */
function validatedObservation(settings) {
  if (!isObject(settings)) {
    throw new Error("observation must be an object.");
  }
  checkKeys(settings, observationSchema.required, "observation");
  for (const key of observationSchema.required) {
    if (!Object.hasOwn(settings, key)) {
      throw new Error(`observation.${key} is required; send all observation fields.`);
    }
  }
  for (const key of ["defaultApplicationBehavior", "defaultURLBehavior"]) {
    if (settings[key] !== "observe" && settings[key] !== "do_not_observe") {
      throw new Error(`observation.${key} must be observe or do_not_observe.`);
    }
  }
  /** @type {Record<string, unknown>} */
  const observation = {
    defaultApplicationBehavior: settings.defaultApplicationBehavior,
    defaultURLBehavior: settings.defaultURLBehavior,
  };
  for (const key of ["allowlist", "blocklist"]) {
    observation[key] = observationEntries(key, settings[key]);
  }
  return observation;
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
  if (!schema) {
    throw new Error(`Unsupported auxiliary tool: ${tool}`);
  }
  checkKeys(input, Object.keys(schema.properties), `${tool} arguments`);
  requireApprovalFlag(tool, input, schema);
  if (tool !== "computer_history_update_settings") {
    return {};
  }
  return { observation: validatedObservation(input.observation) };
}

/** Shared runtime helpers for the auxiliary transport. */

/**
 * @param {string} reason
 * @param {string} message
 * @returns {Error & { reason: string }}
 */
export const failure = (reason, message) => Object.assign(new Error(message), { reason });

export const stoppedSentinel =
  "This application session has been explicitly stopped by the user for this turn.";

/**
 * @param {unknown} text
 * @returns {boolean}
 */
export const stoppedSession = (text) => String(text).includes(stoppedSentinel);

/**
 * @param {unknown} text
 * @returns {string}
 */
export const sanitizeStopped = (text) =>
  String(text).replaceAll(
    stoppedSentinel,
    "The auxiliary application session is stopped. No tool result was returned. Refresh the session before retrying.",
  );

/**
 * @param {unknown} text
 * @returns {boolean}
 */
export const closedTransport = (text) =>
  /\b(?:transport|connection|channel) closed\b/i.test(String(text));

/**
 * @param {{ content?: unknown } | null | undefined} result
 * @returns {string}
 */
export const textOf = (result) => {
  const content = result?.content;
  if (!isUnknownArray(content)) {
    return "";
  }
  /** @type {string[]} */
  const texts = [];
  for (const block of content) {
    if (isObject(block) && block.type === "text" && typeof block.text === "string") {
      texts.push(block.text);
    }
  }
  return texts.join("\n");
};

/**
 * Validate JSON-RPC content blocks into the text-only result form the
 * auxiliary tools emit.
 * @param {unknown} block
 * @returns {Array<{ type: "text", text: string }>}
 */
export const textBlocks = (block) =>
  isObject(block) && block.type === "text" && typeof block.text === "string"
    ? [{ type: "text", text: block.text }]
    : [];
