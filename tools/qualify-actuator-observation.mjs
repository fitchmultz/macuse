#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { firstText } from "./macuse-utils.mjs";

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export const isRecord = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);
/**
 * @param {unknown} value
 * @returns {value is string[]}
 */
export const isStringArray = (value) =>
  Array.isArray(value) && value.every((item) => typeof item === "string");
/** @typedef {{ bundleId?: string, pid: number, path?: string }} ObservedApp */
/** @typedef {{ x: number, y: number, width: number, height: number }} FrameRect */
/** @typedef {{ token: string, title?: string, document?: unknown, frame?: FrameRect }} ObservedWindow */
/** @typedef {{ token: string, role?: string, value?: unknown, description?: string, title?: string, identifier?: string, windowToken?: string, actions?: string[], valueSettable?: boolean }} ObservedElement */
/** @typedef {{ observationId: string, fullSnapshot?: boolean, app: ObservedApp, windows: ObservedWindow[], elements: ObservedElement[] }} ProofObservation */
/** @typedef {{ coordinateSpace: string, windowToken: string, image: { mimeType: string, data: string, width: number, height: number }, windowFrame: FrameRect, captureRect: FrameRect & Record<string, number>, pointPixelScale: number }} ScreenshotResult */
/** @typedef {{ name: string | undefined, pid?: number, window: ObservedWindow, element?: ObservedElement, field?: ObservedElement, contextField?: ObservedElement }} ObservedTabState */
/** @typedef {{ observe: (input: Record<string, unknown>) => Promise<unknown>, act: (input: Record<string, unknown>) => Promise<unknown>, screenshot: (input: Record<string, unknown>) => Promise<unknown>, stop: () => Promise<void> }} ActuatorLike */
/** @typedef {{ app: string, pid: number, path: string, title: string, stop: () => Promise<void> }} FixtureHandle */
/** @typedef {{ name: string, status: string, [key: string]: unknown }} CheckRecord */
/** @typedef {{ ok: boolean, scope: string, fullNativeQualification: boolean, chatgptIndependenceQualified: boolean, checks: CheckRecord[], unattempted: string[] }} QualifyReport */
/** @typedef {{ app: string, safetyNote: string, scope: string, expectedPid?: number, expectedPath?: string, expectedTitle?: string }} QualifyTabsOptions */
/**
 * @param {unknown} value
 * @returns {value is ProofObservation}
 */
export const isProofObservation = (value) =>
  isRecord(value) &&
  typeof value.observationId === "string" &&
  isRecord(value.app) &&
  typeof value.app.pid === "number" &&
  Array.isArray(value.windows) &&
  value.windows.every((window) => isRecord(window) && typeof window.token === "string") &&
  Array.isArray(value.elements) &&
  value.elements.every((element) => isRecord(element) && typeof element.token === "string");
/**
 * @param {unknown} value
 * @returns {value is ScreenshotResult}
 */
export const isScreenshotResult = (value) =>
  isRecord(value) &&
  typeof value.coordinateSpace === "string" &&
  typeof value.windowToken === "string" &&
  isRecord(value.image) &&
  typeof value.image.data === "string" &&
  isRecord(value.windowFrame) &&
  isRecord(value.captureRect) &&
  typeof value.pointPixelScale === "number";
/**
 * @param {unknown} value
 * @returns {value is FixtureHandle}
 */
export const isFixtureHandle = (value) =>
  isRecord(value) &&
  typeof value.app === "string" &&
  typeof value.pid === "number" &&
  typeof value.path === "string" &&
  typeof value.title === "string" &&
  typeof value.stop === "function";
/**
 * Narrow an actuator rejection to its dispatch-evidence shape.
 *
 * @param {unknown} value
 * @returns {value is Error & { dispatched?: unknown, mutationAttempted?: unknown, outcome?: string }}
 */
export const isActuatorRejection = (value) => value instanceof Error;

export const tabs = new Set(["CPU", "Memory", "Energy", "Disk", "Network"]);
/**
 * @param {ProofObservation} observation
 * @param {ObservedTabState | undefined} original
 * @param {string} app
 * @returns {{ name: string | undefined, element: ObservedElement, window: ObservedWindow }}
 */
export function observedTab(observation, original, app) {
  assert.equal(observation.fullSnapshot, true, "A complete native snapshot is required");
  assert.equal(observation.app.bundleId, app, "The observed app must match the exact proof target");
  const selected = observation.elements.filter(
    (element) =>
      element.role === "AXRadioButton" &&
      tabs.has(firstText([element.description, element.title]) ?? "") &&
      (element.value === 1 || element.value === "1" || element.value === true),
  );
  assert.equal(selected.length, 1, "The actual original/selected tab is unknown");
  const element = selected[0];
  if (element === undefined) {
    assert.fail("The actual original/selected tab is unknown");
  }
  const window = observation.windows.find((entry) => entry.token === element.windowToken);
  assert.ok(window !== undefined, "Selected tab is not bound to an observed window");
  if (original !== undefined) {
    assert.equal(observation.app.pid, original.pid, "Observed app process changed");
    assert.equal(window.token, original.window.token, "Observed window changed");
    assert.equal(window.title, original.window.title, "Observed window title changed");
    assert.equal(window.document, original.window.document, "Observed document changed");
  }
  return { name: firstText([element.description, element.title]) ?? "", element, window };
}

/**
 * @param {ProofObservation} observation
 * @param {string} name
 * @param {string} windowToken
 * @returns {ObservedElement}
 */
export function tabTarget(observation, name, windowToken) {
  const matches = observation.elements.filter(
    (element) =>
      element.role === "AXRadioButton" &&
      firstText([element.description, element.title]) === name &&
      element.windowToken === windowToken,
  );
  assert.equal(matches.length, 1, `Expected exactly one ${name} tab in the original window`);
  const target = matches[0];
  if (target === undefined) {
    assert.fail(`Expected exactly one ${name} tab in the original window`);
  }
  if (!isStringArray(target.actions)) {
    assert.fail(`The ${name} tab does not expose AXPress`);
  }
  assert.ok(target.actions.includes("AXPress"), `The ${name} tab does not expose AXPress`);
  return target;
}

/**
 * @param {ScreenshotResult} result
 * @param {ObservedWindow} window
 */
export function screenshotEvidence(result, window) {
  assert.equal(result.coordinateSpace, "screenshot-pixels");
  assert.equal(result.windowToken, window.token);
  assert.equal(result.image.mimeType, "image/png");
  const bytes = Buffer.from(result.image.data, "base64");
  assert.ok(bytes.length >= 24, "Screenshot is too short for a PNG header");
  assert.deepEqual(
    bytes.subarray(0, 8),
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    "Screenshot bytes are not PNG",
  );
  assert.equal(bytes.toString("ascii", 12, 16), "IHDR");
  const width = bytes.readUInt32BE(16),
    height = bytes.readUInt32BE(20);
  assert.ok(width > 0 && height > 0, "Screenshot dimensions are empty");
  assert.equal(result.image.width, width, "Reported width differs from PNG bytes");
  assert.equal(result.image.height, height, "Reported height differs from PNG bytes");
  assert.deepEqual(
    result.windowFrame,
    window.frame,
    "Screenshot belongs to a different window frame",
  );
  assert.ok(
    Number.isFinite(result.pointPixelScale) && result.pointPixelScale > 0,
    "Missing pixel-to-point scale",
  );
  const rect = result.captureRect;
  assert.ok(
    ["x", "y", "width", "height"].every((key) => Number.isFinite(rect[key])) &&
      rect.width > 0 &&
      rect.height > 0,
    "Missing screenshot capture rectangle",
  );
  assert.ok(
    Math.abs(width - result.captureRect.width * result.pointPixelScale) <= 0.5 &&
      Math.abs(height - result.captureRect.height * result.pointPixelScale) <= 0.5,
    "PNG dimensions disagree with the reported capture rectangle and pixel scale",
  );
  return {
    width,
    height,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    windowFrame: result.windowFrame,
    captureRect: result.captureRect,
    pointPixelScale: result.pointPixelScale,
    coordinateSpace: result.coordinateSpace,
    visualContentVerified: false,
  };
}
