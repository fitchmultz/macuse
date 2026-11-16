import {
  findSameElement,
  parseMaskedContexts,
  sameElementIdentity,
  selectContextualCandidate,
} from "./app-state.mjs";
import { fail, resolveTarget, targetUnchanged } from "./cua-guard-steps.mjs";
import { targetRefusal } from "./cua-target-refusal.mjs";

/** @typedef {import("./app-state.mjs").AppObservation} AppObservation */
/** @typedef {import("./app-state.mjs").AppElement} AppElement */

/**
 * A target element verified and mutated since the last public observation of an app.
 * @typedef {{ beforeTarget: AppElement, currentTarget: AppElement, exactValue?: string | undefined }} MutatedTarget
 */

/**
 * Ancestor identity path ignoring volatile sibling hashes and item container values.
 * @param {AppObservation} observation
 * @param {AppElement} element
 * @returns {string}
 */
function ancestorSignature(observation, element) {
  const byIndex = new Map(observation.elements.map((item) => [item.index, item]));
  /** @type {unknown[]} */
  const trail = [];
  for (let parent = element.parentIndex; parent !== undefined;) {
    const ancestor = byIndex.get(parent);
    if (ancestor === undefined) {
      break;
    }
    const omitWindowName =
      ancestor.parentIndex === undefined && ancestor.role === "standard window";
    trail.unshift([
      ancestor.role,
      ancestor.id,
      omitWindowName ? undefined : ancestor.name,
      ancestor.url,
    ]);
    parent = ancestor.parentIndex;
  }
  return JSON.stringify(trail);
}

/**
 * @param {AppObservation} before
 * @param {AppObservation} fresh
 * @param {MutatedTarget} entry
 * @returns {number | undefined}
 */
function findFreshMutatedIndex(before, fresh, entry) {
  const signature = ancestorSignature(before, entry.beforeTarget);
  const matches = fresh.elements.filter(
    (candidate) =>
      sameElementIdentity(entry.beforeTarget, candidate) &&
      candidate.disabled === entry.beforeTarget.disabled &&
      ancestorSignature(fresh, candidate) === signature &&
      (entry.exactValue === undefined || candidate.value === entry.exactValue),
  );
  if (matches.length !== 1 || matches[0] === undefined) {
    return;
  }
  return fresh.elements.indexOf(matches[0]);
}

/**
 * Deduplicate mutated entries by their original element in `before`, keeping the latest state.
 * @param {readonly MutatedTarget[]} mutated
 * @returns {Map<AppElement, MutatedTarget>}
 */
function latestByBeforeTarget(mutated) {
  /** @type {Map<AppElement, MutatedTarget>} */
  const latest = new Map();
  for (const entry of mutated) {
    const prev = latest.get(entry.beforeTarget);
    if (prev !== undefined && prev.exactValue !== undefined && entry.exactValue === undefined) {
      continue;
    }
    latest.set(entry.beforeTarget, entry);
  }
  return latest;
}

/**
 * @param {AppObservation} before
 * @param {AppObservation} fresh
 * @param {readonly MutatedTarget[]} entries
 * @returns {{ beforeSlots: Map<number, number>, freshSlots: Map<number, number> } | undefined}
 */
function buildMaskedSlotMaps(before, fresh, entries) {
  /** @type {Map<number, number>} */
  const beforeSlots = new Map();
  /** @type {Map<number, number>} */
  const freshSlots = new Map();
  for (const [slot, entry] of entries.entries()) {
    const beforeIndex = before.elements.indexOf(entry.beforeTarget);
    const freshIndex = findFreshMutatedIndex(before, fresh, entry);
    if (beforeIndex < 0 || freshIndex === undefined || freshSlots.has(freshIndex)) {
      return;
    }
    beforeSlots.set(beforeIndex, slot);
    freshSlots.set(freshIndex, slot);
  }
  return { beforeSlots, freshSlots };
}

/**
 * @param {{ context: string, rowContext?: string } | undefined} expected
 * @param {AppObservation} fresh
 * @param {{ context: string, rowContext?: string }[]} freshContexts
 * @param {AppElement} original
 * @returns {AppElement | undefined}
 */
function matchMaskedCandidate(expected, fresh, freshContexts, original) {
  if (expected === undefined) {
    return;
  }
  const candidates = fresh.elements
    .map((element, index) => ({
      element,
      context: freshContexts[index]?.context ?? "",
      rowContext: freshContexts[index]?.rowContext,
    }))
    .filter(({ element }) => sameElementIdentity(original, element));
  return selectContextualCandidate(expected, candidates)?.element;
}

/**
 * @param {AppElement} original
 * @param {ReadonlyMap<AppElement, MutatedTarget>} latest
 * @returns {AppElement}
 */
function expectedState(original, latest) {
  const entry = latest.get(original);
  return entry !== undefined && entry.exactValue !== undefined ? entry.currentTarget : original;
}

/**
 * @param {AppObservation} before
 * @param {AppObservation} fresh
 * @param {AppElement} original
 * @param {ReadonlyMap<AppElement, MutatedTarget>} latest
 * @returns {{ target: AppElement, expected: AppElement } | undefined}
 */
function resolveAcrossPriorMutations(before, fresh, original, latest) {
  const origIndex = before.elements.indexOf(original);
  if (origIndex < 0 || findSameElement(original, before) === undefined) {
    return;
  }
  const slots = buildMaskedSlotMaps(before, fresh, [...latest.values()]);
  if (slots === undefined) {
    return;
  }
  const beforeContexts = parseMaskedContexts(before.text, slots.beforeSlots);
  const freshContexts = parseMaskedContexts(fresh.text, slots.freshSlots);
  const target = matchMaskedCandidate(beforeContexts[origIndex], fresh, freshContexts, original);
  if (target === undefined) {
    return;
  }
  return { target, expected: expectedState(original, latest) };
}

/**
 * @param {AppObservation} before
 * @param {AppObservation} fresh
 * @param {AppElement} original
 * @param {readonly MutatedTarget[]} mutated
 * @returns {{ target: AppElement | undefined, expected: AppElement }}
 */
function matchTargetCandidate(before, fresh, original, mutated) {
  const latest = latestByBeforeTarget(mutated);
  const expected = expectedState(original, latest);
  const direct = findSameElement(original, before) ? findSameElement(original, fresh) : undefined;
  if (direct !== undefined) {
    return { target: direct, expected };
  }
  return (
    resolveAcrossPriorMutations(before, fresh, original, latest) ?? { target: undefined, expected }
  );
}

/**
 * Resolve an indexed target against `before`, bridging sibling/ancestor hash drift caused
 * solely by earlier verified mutations since the last public observation.
 * @param {AppObservation} before
 * @param {AppObservation} fresh
 * @param {Record<string, unknown>} input
 * @param {readonly MutatedTarget[]} mutated
 * @returns {{ target: AppElement, original: AppElement, index: number } | undefined}
 */
export function resolveTargetWithContinuity(before, fresh, input, mutated) {
  if (input.element_index === undefined) {
    return;
  }
  const original = before.elements.find((element) => element.index === String(input.element_index));
  if (mutated.length === 0 || original === undefined) {
    const resolved = resolveTarget(before, fresh, input);
    return resolved !== undefined && original !== undefined ? { ...resolved, original } : undefined;
  }
  const match = matchTargetCandidate(before, fresh, original, mutated);
  if (match.target === undefined) {
    fail(
      targetRefusal(input.element_index, original, {
        before,
        fresh,
        target: undefined,
      }),
    );
  }
  if (!targetUnchanged(match.target, match.expected)) {
    if (match.expected !== original) {
      fail(
        `Target identity not confirmed: index ${original.index} (${original.role} "${original.name}") changed since the previous verified mutation in this run. Inspect fresh app state before acting.`,
      );
    }
    fail(
      targetRefusal(input.element_index, original, {
        before,
        fresh,
        target: match.target,
      }),
    );
  }
  return { target: match.target, original, index: Number(match.target.index) };
}
