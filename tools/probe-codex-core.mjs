import {
  DEFAULT_BUNDLED_COMPUTER_USE_CLIENT,
  DEFAULT_COMPUTER_USE_CLIENT_CWD,
} from "./macuse-utils.mjs";

export const DEFAULT_CLIENT = DEFAULT_BUNDLED_COMPUTER_USE_CLIENT;
export const DEFAULT_CWD = DEFAULT_COMPUTER_USE_CLIENT_CWD;
export const DEFAULT_PROTOCOL_VERSION = "2025-06-18";

export const EXIT = Object.freeze({
  OK: 0,
  FAILURE: 1,
  USAGE: 2,
  MISSING_INSTALL: 3,
  TIMEOUT: 4,
  CHILD_EXIT: 5,
  TOOL_ERROR: 7,
});

export const JSON_RPC_ERROR = Object.freeze({
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
});

/**
 * @typedef {{ command: string, help?: boolean, client: string, cwd: string, protocolVersion: string, startupTimeoutMs: number, listTimeoutMs: number, toolTimeoutMs: number, elicitationTimeoutMs: number | undefined, shutdownTimeoutMs: number, logTimeoutMs: number, maxLogLines: number, app: string | undefined, approval: string | undefined, since: string | undefined, withTurnMetadata: boolean }} ProbeOptions
 * @typedef {{ method: string, resolve: (result: unknown) => void, reject: (error: ProbeError) => void, timer: ReturnType<typeof setTimeout> }} PendingRpc
 * @typedef {{ action: "accept" | "decline" | "cancel", content?: unknown }} ElicitationDecision
 * @typedef {(params: unknown, context: { count: number }) => Promise<ElicitationDecision>} ElicitationHandler
 * @typedef {{ serverRequests: number, notifications: number, elicitations: number, accepted: number, declined: number, canceled: number, unknownServerRequests: number, timeouts: number }} ProbeStats
 * @typedef {{ code: number | null, signal: NodeJS.Signals | null }} ExitInfo
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export const isRecord = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const SECRET_KEY_RE =
  /(?:secret|token|password|passwd|authorization|api[-_]?key|cookie|session)/i;
export const HEAVY_VALUE_RE =
  /(?:image|screenshot|bitmap|base64|data|blob|bytes|screen|framebuffer)/i;

export class ProbeError extends Error {
  /**
   * @param {string} message
   * @param {number} [exitCode]
   * @param {unknown} [details]
   */
  constructor(message, exitCode = EXIT.FAILURE, details) {
    super(message);
    this.name = this.constructor.name;
    this.exitCode = exitCode;
    this.details = details;
  }
}

export class UsageError extends ProbeError {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message, EXIT.USAGE);
  }
}

export class TimeoutError extends ProbeError {
  /**
   * @param {string} message
   * @param {unknown} [details]
   */
  constructor(message, details) {
    super(message, EXIT.TIMEOUT, details);
  }
}

export class MissingInstallError extends ProbeError {
  /**
   * @param {string} message
   * @param {unknown} [details]
   */
  constructor(message, details) {
    super(message, EXIT.MISSING_INSTALL, details);
  }
}

export class ChildExitError extends ProbeError {
  /**
   * @param {string} message
   * @param {unknown} [details]
   */
  constructor(message, details) {
    super(message, EXIT.CHILD_EXIT, details);
  }
}

export class ToolResultError extends ProbeError {
  /**
   * @param {string} message
   * @param {unknown} [details]
   */
  constructor(message, details) {
    super(message, EXIT.TOOL_ERROR, details);
  }
}

export class JsonRpcResponseError extends ProbeError {
  /**
   * @param {string} method
   * @param {unknown} error
   */
  constructor(method, error) {
    const record = isRecord(error) ? error : undefined;
    const code = record?.code;
    const detail = record?.message;
    const codeText =
      typeof code === "number" || typeof code === "string" ? String(code) : "unknown";
    const detailText = typeof detail === "string" ? detail : "unknown error";
    super(`${method} failed with JSON-RPC error ${codeText}: ${detailText}`, EXIT.FAILURE, error);
    this.method = method;
    this.rpcError = error;
  }
}

/**
 * @param {unknown} value
 * @param {string} key
 * @returns {boolean}
 */
export function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/**
 * @param {unknown} value
 * @param {number} [max]
 * @returns {unknown}
 */
export function truncate(value, max = 220) {
  if (typeof value !== "string") {
    return value;
  }
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max)}…[${value.length} chars]`;
}

/**
 * @param {unknown} value
 * @param {string} [key]
 * @param {number} [depth]
 * @returns {unknown}
 */
export function sanitizeForLog(value, key = "", depth = 0) {
  if (SECRET_KEY_RE.test(key)) {
    return "[redacted]";
  }
  if (HEAVY_VALUE_RE.test(key)) {
    return `[redacted:${typeof value}]`;
  }
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "object" && depth >= 5) {
    return `[${Array.isArray(value) ? "array" : "object"}]`;
  }
  return sanitizeValue(value, key, depth);
}

/**
 * @param {unknown} value
 * @param {string} key
 * @param {number} depth
 * @returns {unknown}
 */
function sanitizeValue(value, key, depth) {
  if (typeof value !== "object") {
    return sanitizeLeaf(value);
  }
  if (Array.isArray(value)) {
    return sanitizeArray(value, key, depth);
  }
  if (key === "content" && isRecord(value) && Array.isArray(value.content)) {
    return summarizeContentBlocks(value.content);
  }
  if (!isRecord(value)) {
    return sanitizeForLog(value);
  }
  return sanitizeRecordEntries(value, depth);
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function sanitizeLeaf(value) {
  if (typeof value === "string") {
    return truncate(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  return `[${typeof value}]`;
}

/**
 * @param {unknown[]} value
 * @param {string} key
 * @param {number} depth
 * @returns {unknown[]}
 */
function sanitizeArray(value, key, depth) {
  const items = value.slice(0, 8).map((item) => sanitizeForLog(item, key, depth + 1));
  if (value.length > items.length) {
    items.push(`… ${value.length - items.length} more`);
  }
  return items;
}

/**
 * @param {Record<string, unknown>} value
 * @param {number} depth
 * @returns {Record<string, unknown>}
 */
function sanitizeRecordEntries(value, depth) {
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    out[childKey] = sanitizeEntry(childKey, childValue, depth);
  }
  return out;
}

/**
 * @param {string} childKey
 * @param {unknown} childValue
 * @param {number} depth
 * @returns {unknown}
 */
function sanitizeEntry(childKey, childValue, depth) {
  if (childKey === "content" && Array.isArray(childValue)) {
    return summarizeContentBlocks(childValue);
  }
  if (
    childKey === "structuredContent" &&
    childValue !== null &&
    childValue !== undefined &&
    typeof childValue === "object"
  ) {
    return { keys: Object.keys(childValue).slice(0, 20), redacted: true };
  }
  return sanitizeForLog(childValue, childKey, depth + 1);
}

/**
 * @param {unknown} blocks
 * @returns {unknown}
 */
export function summarizeContentBlocks(blocks) {
  if (!Array.isArray(blocks)) {
    return sanitizeForLog(blocks);
  }
  return blocks
    .slice(0, 8)
    .map((block) => summarizeContentBlock(block))
    .concat(blocks.length > 8 ? [`… ${blocks.length - 8} more`] : []);
}

/**
 * @param {unknown} block
 * @returns {unknown}
 */
function summarizeContentBlock(block) {
  if (block === null || block === undefined || typeof block !== "object") {
    return sanitizeForLog(block);
  }
  const record = isRecord(block) ? block : undefined;
  return { ...contentBlockSummary(record), ...redactedHeavyKeys(record) };
}

/**
 * @param {Record<string, unknown> | undefined} record
 * @returns {Record<string, unknown>}
 */
function contentBlockSummary(record) {
  /** @type {Record<string, unknown>} */
  const summary = { type: record?.type ?? "unknown" };
  if (typeof record?.text === "string") {
    summary.textLength = record.text.length;
  }
  if (typeof record?.mimeType === "string") {
    summary.mimeType = record.mimeType;
  }
  if (typeof record?.uri === "string") {
    summary.uri = truncate(record.uri, 120);
  }
  return summary;
}

/**
 * @param {Record<string, unknown> | undefined} record
 * @returns {Record<string, unknown>}
 */
function redactedHeavyKeys(record) {
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [key, value] of Object.entries(record ?? {})) {
    if (key === "type" || key === "text" || key === "mimeType" || key === "uri") {
      continue;
    }
    if (HEAVY_VALUE_RE.test(key)) {
      out[key] = `[redacted:${typeof value}]`;
    }
  }
  return out;
}

/**
 * @param {unknown} details
 * @returns {string}
 */
export function formatDetails(details) {
  if (details === undefined) {
    return "";
  }
  return ` ${JSON.stringify(sanitizeForLog(details))}`;
}

export class EventLogger {
  /**
   * @param {{ quiet?: boolean }} [options]
   */
  constructor({ quiet = false } = {}) {
    this.quiet = quiet;
  }

  /**
   * @param {string} event
   * @param {unknown} [details]
   * @returns {void}
   */
  event(event, details) {
    if (this.quiet) {
      return;
    }
    const timestamp = new Date().toISOString();
    process.stderr.write(`${timestamp} ${event}${formatDetails(details)}\n`);
  }
}
