/** @typedef {import("./qualify-proof-transport.mjs").ImageReceipt} ImageReceipt */
/** @typedef {import("./qualify-proof-transport.mjs").IndependentEvidence} IndependentEvidence */
/** @typedef {import("./qualify-proof-transport.mjs").NativeActionRecord} NativeActionRecord */
/** @typedef {import("./qualify-proof-transport.mjs").ObservedElement} ObservedElement */
/** @typedef {import("./qualify-proof-transport.mjs").ObservedState} ObservedState */
/** @typedef {import("./qualify-proof-transport.mjs").ProofObservation} ProofObservation */
/** @typedef {import("./qualify-proof-transport.mjs").FixtureHandle} FixtureHandle */
/** @typedef {import("./qualify-proof-transport.mjs").TransportResult} TransportResult */
/** @typedef {import("./qualify-proof-transport.mjs").ExecutionRecord} ExecutionRecord */
/** @typedef {import("./qualify-proof-transport.mjs").VisibleReport} VisibleReport */
/** @typedef {import("./qualify-proof-transport.mjs").NativeEvidenceEntry} NativeEvidenceEntry */
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { contextField, isRecord, ordinaryField } from "./qualify-proof-transport.mjs";

/**
 * @param {TransportResult} result
 * @returns {IndependentEvidence}
 */
export function evidence(result) {
  const independent = result.details?.independent;
  if (independent === undefined) {
    assert.fail("Missing authoritative proof metadata");
  }
  assert.equal(result.isError, independent.isError);
  return independent;
}
/**
 * @param {TransportResult} result
 * @returns {unknown}
 */
export function executionValue(result) {
  return evidence(result).execution?.value;
}
/**
 * @param {TransportResult} result
 * @returns {VisibleReport}
 */
export function visible(result) {
  const block = result.content.find((item) => item.type === "text");
  if (block?.text === undefined) {
    assert.fail("Missing text block in proof result");
  }
  /** @type {unknown} */
  const parsed = JSON.parse(block.text);
  if (!isRecord(parsed)) {
    assert.fail("Malformed visible report");
  }
  const nativeEvidence = parsed.nativeEvidence;
  if (!Array.isArray(nativeEvidence)) {
    assert.fail("Missing native evidence");
  }
  /** @type {NativeEvidenceEntry[]} */
  const entries = [];
  for (const entry of nativeEvidence) {
    if (isRecord(entry)) {
      entries.push(entry);
    }
  }
  return { nativeEvidence: entries };
}
/**
 * @param {TransportResult} result
 * @returns {void}
 */
export function noMutation(result) {
  assert.equal(result.isError, true);
  const meta = evidence(result);
  const actions = meta.nativeActions;
  if (actions === undefined) {
    assert.fail("Missing native action records");
  }
  assert.ok(
    actions.every((action) => action.mutationAttempted !== true),
    "Refused operation attempted native mutation",
  );
}
/**
 * @param {TransportResult} result
 * @returns {ImageReceipt[]}
 */
export function imageReceipts(result) {
  const meta = evidence(result);
  const receipts = meta.images;
  if (receipts === undefined) {
    assert.fail("Missing image receipts");
  }
  assert.equal(receipts.length, 2);
  assert.equal(result.content.filter((block) => block.type === "image").length, 2);
  for (const receipt of receipts) {
    const block = result.content[receipt.contentIndex];
    if (block === undefined) {
      assert.fail("Missing image block for receipt");
    }
    assert.equal(block.type, "image");
    assert.equal(block.mimeType, receipt.mimeType);
    if (block.data === undefined) {
      assert.fail("Missing image data for receipt");
    }
    const bytes = Buffer.from(block.data, "base64");
    assert.equal(createHash("sha256").update(bytes).digest("hex"), receipt.sha256);
    assert.equal(bytes.length, receipt.bytes);
    assert.equal(bytes.readUInt32BE(16), receipt.width);
    assert.equal(bytes.readUInt32BE(20), receipt.height);
    assert.equal(Math.round(receipt.captureRect.width * receipt.pointPixelScale), receipt.width);
    assert.equal(Math.round(receipt.captureRect.height * receipt.pointPixelScale), receipt.height);
  }
  return receipts;
}
/**
 * @param {ProofObservation} observation
 * @param {FixtureHandle} fixture
 * @param {ObservedState} [original]
 * @returns {ObservedState}
 */
export function state(observation, fixture, original) {
  assert.equal(observation.fullSnapshot, true);
  assert.equal(observation.app.bundleId, fixture.app);
  assert.equal(observation.app.pid, fixture.pid);
  assert.equal(observation.app.path, fixture.path);
  assert.match(observation.app.processStartToken, /^[1-9]\d*:\d+$/);
  assert.equal(observation.windows.length, 1);
  const window = observation.windows[0];
  if (window === undefined) {
    assert.fail("Missing observed window");
  }
  assert.equal(window.title, fixture.title);
  const selected = observation.elements.filter(
    (element) =>
      element.role === "AXRadioButton" &&
      (element.value === true || element.value === 1 || element.value === "1"),
  );
  assert.equal(selected.length, 1);
  const radio = selected[0];
  if (radio === undefined) {
    assert.fail("Missing selected radio");
  }
  const description = radio.description;
  const name = description !== undefined && description !== "" ? description : radio.title;
  assert.ok(["CPU", "Memory", "Energy"].includes(name ?? ""));
  /** @type {Record<string, ObservedElement>} */
  const fields = {};
  for (const identifier of [ordinaryField, contextField]) {
    /** @type {ObservedElement[]} */
    const matches = observation.elements.filter(
      (element) => element.identifier === identifier && element.windowToken === window.token,
    );
    assert.equal(matches.length, 1);
    const field = matches[0];
    if (field === undefined) {
      assert.fail(`Missing fixture field ${identifier}`);
    }
    assert.equal(field.role, "AXTextField");
    assert.equal(typeof field.value, "string");
    fields[identifier] = field;
  }
  if (original !== undefined) {
    assert.equal(observation.app.processStartToken, original.birth);
    assert.equal(window.token, original.window.token);
    assert.equal(window.document, original.window.document);
  }
  return { name, fields, window, birth: observation.app.processStartToken };
}
/**
 * @param {ProofObservation} observation
 * @param {string} name
 * @returns {ObservedElement}
 */
export function tab(observation, name) {
  const matches = observation.elements.filter(
    (element) =>
      element.role === "AXRadioButton" &&
      (element.description !== undefined && element.description !== ""
        ? element.description
        : element.title) === name,
  );
  assert.equal(matches.length, 1);
  const match = matches[0];
  if (match === undefined) {
    assert.fail(`Missing tab ${name}`);
  }
  return match;
}
/**
 * @param {string} method
 * @param {Record<string, unknown>} params
 * @returns {string}
 */
export const callCode = (method, params) =>
  `macuse.call(${JSON.stringify(method)},${JSON.stringify(params)})`;
