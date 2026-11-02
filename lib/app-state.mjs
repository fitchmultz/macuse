/**
 * One parsed Sky text element. `descendants`, `context`, `rowContext`, and
 * `cellValueContext` are enrichment hashes added by `parseAppState`.
 * @typedef {import("./app-state-parse.mjs").ElementState} ElementState
 */

/** @typedef {import("./app-state-parse.mjs").DocumentIdentity} DocumentIdentity */

/** @typedef {import("./app-state-parse.mjs").AppObservation} AppObservation */

export { parseAppState } from "./app-state-parse.mjs";

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
 * @param {ElementState} element
 * @param {AppObservation} observation
 * @returns {ElementState[]}
 */
function identityCandidates(element, observation) {
  return observation.elements.filter((other) => {
    if (element.id !== undefined && element.id !== "") {
      return other.id === element.id && other.role === element.role;
    }
    if (element.description !== undefined && element.description !== "") {
      return other.description === element.description && other.role === element.role;
    }
    return other.role === element.role && other.name === element.name;
  });
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
 * @param {ElementState} element
 * @param {ElementState[]} candidates
 * @returns {ElementState | undefined}
 */
function contextualCandidate(element, candidates) {
  const exact = candidates.filter((other) => other.context === element.context);
  if (exact.length > 0) {
    return exact.length === 1 ? exact[0] : undefined;
  }
  const inRow =
    element.rowContext !== undefined && element.rowContext !== ""
      ? candidates.filter((other) => other.rowContext === element.rowContext)
      : [];
  return inRow.length === 1 ? inRow[0] : undefined;
}

/**
 * @param {ElementState} element
 * @param {AppObservation} observation
 * @returns {ElementState | undefined}
 */
export function findContextElement(element, observation) {
  return contextualCandidate(element, identityCandidates(element, observation));
}

/**
 * @param {ElementState} element
 * @param {AppObservation} observation
 * @returns {ElementState | undefined}
 */
export function findSameElement(element, observation) {
  return contextualCandidate(
    element,
    identityCandidates(element, observation).filter(
      (other) => other.descendants === element.descendants,
    ),
  );
}
