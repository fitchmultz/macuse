import { createHash } from "node:crypto";
import { basename, isAbsolute } from "node:path";

/** @typedef {{ bundleId: string, pid: number, path: string, windowTitle: string }} ResolvedTarget */
/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
/** @param {unknown} value @returns {value is string} */
const nonempty = (value) =>
  typeof value === "string" && value.trim() !== "" && value.isWellFormed();
export const maxImageBytes = 12_000_000;
export const maxRunImageBytes = 24_000_000;

/** @param {unknown} value @returns {value is {bundleId: string, pid: number, path: string, windowTitle?: unknown}} */
function validTarget(value) {
  return (
    isRecord(value) &&
    Object.keys(value).every((key) => ["bundleId", "pid", "path", "windowTitle"].includes(key)) &&
    validBundle(value.bundleId) &&
    validProcess(value.pid) &&
    validPath(value.path) &&
    (value.windowTitle === undefined || value.windowTitle === "macuse disposable actuator fixture")
  );
}
/** @param {unknown} value @returns {value is string} */
function validBundle(value) {
  return (
    nonempty(value) &&
    /^com\.macuse\.actuator-fixture\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}
/** @param {unknown} value @returns {value is number} */
function validProcess(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
/** @param {unknown} value @returns {value is string} */
function validPath(value) {
  return nonempty(value) && isAbsolute(value) && basename(value) === "ActuatorFixture.app";
}
/** @param {Buffer} bytes @param {string} data */
function validPngBytes(bytes, data) {
  return (
    bytes.length <= maxImageBytes &&
    bytes.toString("base64") === data &&
    bytes.length >= 33 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    bytes.readUInt32BE(8) === 13 &&
    bytes.toString("ascii", 12, 16) === "IHDR"
  );
}
/** @param {number} width @param {number} height @param {Record<string, unknown>} image */
function validPngDimensions(width, height, image) {
  return (
    width !== 0 &&
    height !== 0 &&
    width <= 8192 &&
    height <= 8192 &&
    width * height <= 16_000_000 &&
    width === image.width &&
    height === image.height
  );
}

/**
 * @param {unknown} supplied
 * @returns {ResolvedTarget | undefined}
 */
export function targetConfiguration(supplied) {
  const configured = process.env.MACUSE_INDEPENDENT_PROOF_TARGET;
  const value =
    supplied ??
    (configured !== undefined && configured !== ""
      ? /** @type {unknown} */ (JSON.parse(configured))
      : undefined);
  if (value === undefined) {
    return;
  }
  if (!validTarget(value)) {
    throw new TypeError(
      "Invalid trusted proof target: fixture UUID bundleId, positive pid, absolute canonical path, and optional windowTitle required.",
    );
  }
  return Object.freeze({
    bundleId: value.bundleId,
    pid: value.pid,
    path: value.path,
    windowTitle: "macuse disposable actuator fixture",
  });
}

/**
 * @param {unknown} image
 * @returns {{ width: number, height: number, bytes: number, mimeType: "image/png", sha256: string, data: string }}
 */
export function png(image) {
  if (
    !isRecord(image) ||
    image.mimeType !== "image/png" ||
    typeof image.data !== "string" ||
    image.data.length > Math.ceil(maxImageBytes / 3) * 4
  ) {
    throw new Error("Native screenshot exceeds the PNG transport budget.");
  }
  const bytes = Buffer.from(image.data, "base64");
  if (!validPngBytes(bytes, image.data)) {
    throw new Error("Native screenshot is not a bounded PNG.");
  }
  const width = bytes.readUInt32BE(16),
    height = bytes.readUInt32BE(20);
  if (!validPngDimensions(width, height, image)) {
    throw new Error("Native screenshot dimensions fail the proof budget or metadata check.");
  }
  return {
    width,
    height,
    bytes: bytes.length,
    mimeType: "image/png",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    data: image.data,
  };
}

/** @typedef {{ x: number, y: number, width: number, height: number }} FrameRect */
/** @param {unknown} value @param {ResolvedTarget} target @param {string | undefined} start */
function matchesIdentity(value, target, start) {
  return (
    isRecord(value) &&
    value.bundleId === target.bundleId &&
    value.pid === target.pid &&
    value.path === target.path &&
    typeof value.processStartToken === "string" &&
    /^[1-9]\d*:\d+$/.test(value.processStartToken) &&
    (start === undefined || value.processStartToken === start)
  );
}
/** @param {unknown} value @returns {value is Record<string, unknown> & {processStartToken: string}} */
function processIdentity(value) {
  return isRecord(value) && typeof value.processStartToken === "string";
}
/** @param {Record<string, unknown>} result @param {ResolvedTarget} target */
function matchesSnapshot(result, target) {
  return (
    nonempty(result.observationId) &&
    result.fullSnapshot === true &&
    Array.isArray(result.windows) &&
    Array.isArray(result.elements) &&
    result.windows.length === 1 &&
    isRecord(result.windows[0]) &&
    result.windows[0].title === target.windowTitle
  );
}
/**
 * @param {unknown} result
 * @param {ResolvedTarget} target
 * @param {string | undefined} start
 * @returns {{app: Record<string, unknown> & {processStartToken: string}, observationId: unknown, windows: unknown[], elements: unknown[]}}
 */
export function validateNativeObservation(result, target, start) {
  if (
    !isRecord(result) ||
    !processIdentity(result.app) ||
    !matchesIdentity(result.app, target, start) ||
    !matchesSnapshot(result, target) ||
    !Array.isArray(result.windows) ||
    !Array.isArray(result.elements)
  ) {
    throw Object.assign(
      new Error("Native observation did not match the operator-owned target identity/window."),
      { dispatched: false },
    );
  }
  return {
    app: result.app,
    observationId: result.observationId,
    windows: result.windows,
    elements: result.elements,
  };
}
/** @param {unknown} frame @returns {frame is FrameRect} */
function rectangle(frame) {
  if (!isRecord(frame)) {
    return false;
  }
  const { x, y, width, height } = frame;
  return (
    finiteNumber(x) &&
    finiteNumber(y) &&
    finiteNumber(width) &&
    finiteNumber(height) &&
    width > 0 &&
    height > 0
  );
}
/** @param {unknown} value @returns {value is number} */
function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}
/** @param {unknown} value @returns {value is number} */
function validScale(value) {
  return finiteNumber(value) && value > 0 && value <= 8;
}
/** @param {unknown} value */
function validWindowId(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
/**
 * @param {Record<string, unknown>} result
 * @param {Record<string, unknown> | undefined} window
 * @param {{width: number, height: number}} metadata
 */
export function validateScreenshotMapping(result, window, metadata) {
  const windowFrame = result.windowFrame,
    captureRect = result.captureRect,
    observedFrame = window?.frame;
  /** @type {("x" | "y" | "width" | "height")[]} */
  const axes = ["x", "y", "width", "height"];
  if (
    !rectangle(windowFrame) ||
    !rectangle(captureRect) ||
    !rectangle(observedFrame) ||
    axes.some((key) => windowFrame[key] !== observedFrame[key]) ||
    !validScale(result.pointPixelScale) ||
    !validWindowId(result.windowId) ||
    Math.round(captureRect.width * result.pointPixelScale) !== metadata.width ||
    Math.round(captureRect.height * result.pointPixelScale) !== metadata.height
  ) {
    throw new Error("Native screenshot window/pixel mapping does not match the observed target.");
  }
}
