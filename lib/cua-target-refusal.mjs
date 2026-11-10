// Words the refusals that `resolveTarget` in cua-guard-steps.mjs decides on. It decides nothing.
import { findSameElement, sameElementMismatch } from "./app-state.mjs";

/** @typedef {import("./app-state.mjs").AppObservation} AppObservation */
/** @typedef {import("./app-state.mjs").AppElement} AppElement */

// Shows 111 of 113 target names and 46 of 51 target values whole in 142 replayed real refusals.
const EXCERPT_LENGTH = 80;
const OBSERVE_AGAIN =
  "Observe again and use an index from the new state; if the app keeps changing, observe and act in the same script.";

/**
 * @param {string} text
 * @param {number} [from]
 * @returns {string}
 */
function excerpt(text, from = 0) {
  const end = from + EXCERPT_LENGTH;
  return JSON.stringify(`${text.slice(from, end)}${end < text.length ? "…" : ""}`);
}

/**
 * The old and new text of one target. Text too long to show whole starts at the first difference.
 * @param {string | undefined} before
 * @param {string | undefined} after
 * @returns {string}
 */
function textChange(before, after) {
  if (before === undefined || after === undefined) {
    return `from ${before === undefined ? "no value" : excerpt(before)} to ${after === undefined ? "no value" : excerpt(after)}`;
  }
  let shared = 0;
  if (Math.max(before.length, after.length) > EXCERPT_LENGTH) {
    while (shared < before.length && before[shared] === after[shared]) {
      shared += 1;
    }
  }
  const skipped = shared > 0 ? `after its first ${shared} characters, ` : "";
  return `${skipped}from ${excerpt(before, shared)} to ${excerpt(after, shared)}`;
}

/**
 * What keeps the last observation or the current state from holding exactly one such element.
 * @param {AppElement} original
 * @param {AppObservation} before
 * @param {AppObservation} fresh
 * @returns {string}
 */
function lostTarget(original, before, fresh) {
  const inLast = findSameElement(original, before) === undefined;
  const mismatch = sameElementMismatch(original, inLast ? before : fresh);
  if (mismatch.cause === "alike") {
    const alike = inLast
      ? `is one of ${mismatch.count} elements in the last observation`
      : `now matches ${mismatch.count} elements`;
    return `${alike} with the same role, name or ID, descendants and surroundings. Observing again does not tell them apart. Act on a different element that is unique, or use the keyboard; otherwise click at screenshot coordinates with click([x, y]).`;
  }
  if (mismatch.cause === "absent") {
    return `is not in the current state: no element has its role and name or ID. ${OBSERVE_AGAIN}`;
  }
  if (mismatch.cause === "inside") {
    return `has different descendants than in the last observation. ${OBSERVE_AGAIN}`;
  }
  return `has different surroundings than in the last observation: an ancestor changed, or another element under one of its ancestors. ${OBSERVE_AGAIN}`;
}

/**
 * Which check of `targetUnchanged` failed on the element found in the current state.
 * @param {AppElement} original
 * @param {AppElement} target
 * @returns {string}
 */
function changedTarget(original, target) {
  if (target.disabled) {
    return "is disabled. Observing again does not change that; it stays refused while disabled.";
  }
  if (target.name !== original.name) {
    return `is now named ${excerpt(target.name)}. ${OBSERVE_AGAIN}`;
  }
  if (target.value !== original.value) {
    return `changed its value since the last observation, ${textChange(original.value, target.value)}. ${OBSERVE_AGAIN}`;
  }
  if (target.cellValueContext !== original.cellValueContext) {
    return `is in a cell whose value changed since the last observation. ${OBSERVE_AGAIN}`;
  }
  return `has different descendants than in the last observation. ${OBSERVE_AGAIN}`;
}

/**
 * Word the refusal `resolveTarget` decided on. Every message starts with "Target identity",
 * the phrase that refusal counts search for.
 * @param {unknown} index
 * @param {AppElement | undefined} original
 * @param {{ before: AppObservation, fresh: AppObservation, target: AppElement | undefined }} states
 * @returns {string}
 */
export function targetRefusal(index, original, { before, fresh, target }) {
  if (original === undefined) {
    return `Target identity not confirmed: index ${String(index)} is not in the last observation of this app. Use an index from that observation, or observe again.`;
  }
  const name = original.name === original.role ? "" : ` ${excerpt(original.name)}`;
  const label = `index ${original.index} (${original.role}${name})`;
  return target === undefined
    ? `Target identity not confirmed: ${label} ${lostTarget(original, before, fresh)}`
    : `Target identity confirmed, but ${label} ${changedTarget(original, target)}`;
}
