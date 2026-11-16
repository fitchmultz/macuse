/**
 * One parsed Sky text element. `descendants`, `context`, `rowContext`, and
 * `cellValueContext` are enrichment hashes added by `parseAppState`.
 * @typedef {import("./app-state-parse.mjs").ElementState} ElementState
 */

/** @typedef {import("./app-state-parse.mjs").DocumentIdentity} DocumentIdentity */

/** @typedef {import("./app-state-parse.mjs").AppObservation} AppObservation */
/** @typedef {{ context?: string | undefined, rowContext?: string | undefined }} ContextFields */

export { parseAppState, parseMaskedContexts } from "./app-state-parse.mjs";

/**
 * @param {AppObservation} before
 * @param {AppObservation} after
 * @returns {boolean}
 */
export function sameDocument(before, after) {
  if (before.app !== after.app || before.nativeSheetId !== after.nativeSheetId) {
    return false;
  }
  const document = before.documentIdentity,
    freshDocument = after.documentIdentity;
  if (!document || !freshDocument) {
    return before.title === after.title && before.url === after.url;
  }
  return (
    document.windowUrl === freshDocument.windowUrl &&
    document.pageUrls.length === freshDocument.pageUrls.length &&
    document.pageUrls.every((url, index) => url === freshDocument.pageUrls[index])
  );
}

// Snapshot identity can survive index changes; it does not prove native AX object continuity.
// Never fall back from a missing ID or resolve a duplicate identity by index.
/**
 * Whether two parsed elements share the same role and primary identity key (ID, description, or name).
 * @param {ElementState} expected
 * @param {ElementState} candidate
 * @returns {boolean}
 */
export function sameElementIdentity(expected, candidate) {
  if (expected.id !== undefined && expected.id !== "") {
    return candidate.id === expected.id && candidate.role === expected.role;
  }
  if (expected.description !== undefined && expected.description !== "") {
    return candidate.description === expected.description && candidate.role === expected.role;
  }
  return candidate.role === expected.role && candidate.name === expected.name;
}

/**
 * @param {ElementState} element
 * @param {AppObservation} observation
 * @returns {ElementState[]}
 */
function identityCandidates(element, observation) {
  return observation.elements.filter((other) => sameElementIdentity(element, other));
}

/**
 * @param {ElementState} element
 * @param {AppObservation} observation
 * @returns {ElementState | undefined}
 */
export function findUniqueElement(element, observation) {
  const candidates = identityCandidates(element, observation);
  return candidates.length === 1 ? candidates[0] : undefined;
}

/**
 * Match candidates sharing `expected`'s exact context, else `expected`'s row context.
 * @template {ContextFields} C
 * @param {ContextFields} expected
 * @param {readonly C[]} candidates
 * @returns {C[]}
 */
function contextMatches(expected, candidates) {
  const exact = candidates.filter((other) => other.context === expected.context);
  if (exact.length > 0) {
    return exact;
  }
  return expected.rowContext !== undefined && expected.rowContext !== ""
    ? candidates.filter((other) => other.rowContext === expected.rowContext)
    : [];
}

/**
 * @template {ContextFields} C
 * @param {ContextFields} expected
 * @param {readonly C[]} candidates
 * @returns {C | undefined}
 */
export function selectContextualCandidate(expected, candidates) {
  const matches = contextMatches(expected, candidates);
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * @param {ElementState} element
 * @param {AppObservation} observation
 * @returns {ElementState | undefined}
 */
export function findContextElement(element, observation) {
  return selectContextualCandidate(element, identityCandidates(element, observation));
}

/**
 * @param {ElementState} element
 * @param {AppObservation} observation
 * @returns {ElementState | undefined}
 */
export function findSameElement(element, observation) {
  return selectContextualCandidate(
    element,
    identityCandidates(element, observation).filter(
      (other) => other.descendants === element.descendants,
    ),
  );
}

/**
 * Why `findSameElement` returns nothing. Call it only in that case.
 * - `absent`: no element has the element's role and ID, description or name.
 * - `inside`: such elements exist, but none has the same descendants.
 * - `around`: such elements exist, but none is in the same context.
 * - `alike`: `count` such elements share the context, so none can be singled out.
 * @param {ElementState} element
 * @param {AppObservation} observation
 * @returns {{ cause: "absent" | "inside" | "around" } | { cause: "alike", count: number }}
 */
export function sameElementMismatch(element, observation) {
  const identified = identityCandidates(element, observation);
  if (identified.length === 0) {
    return { cause: "absent" };
  }
  const candidates = identified.filter((other) => other.descendants === element.descendants);
  if (candidates.length === 0) {
    return { cause: "inside" };
  }
  const matches = contextMatches(element, candidates);
  return matches.length > 1 ? { cause: "alike", count: matches.length } : { cause: "around" };
}
