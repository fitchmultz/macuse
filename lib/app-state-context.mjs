import { hash } from "node:crypto";
import { PAGE_ROLES, isTopPage } from "./app-state-document.mjs";

/** @typedef {import("./app-state-parse.mjs").ElementState} ElementState */
/** @typedef {import("./app-state-parse.mjs").ParsedTree} ParsedTree */

/** @param {unknown} value @returns {string} */
const fingerprint = (value) => hash("sha256", JSON.stringify(value), "hex");
const itemRoles = new Set(["row", "group", "container"]);

/**
 * @param {string | undefined} value
 * @returns {boolean}
 */
function missingText(value) {
  return value === undefined || value === "";
}

/**
 * @param {ElementState} element
 * @param {ElementState | undefined} parent
 * @param {number} parentDepth
 * @returns {boolean}
 */
function titleEcho(element, parent, parentDepth) {
  return Boolean(
    parent &&
    parentDepth < 0 &&
    parent.role === "standard window" &&
    element.role === "text" &&
    missingText(element.id) &&
    missingText(element.url) &&
    element.name === parent.name &&
    element.value?.replace(/\n+$/, "") === element.name,
  );
}

/**
 * @param {ParsedTree} parsed
 * @param {number} index
 * @returns {unknown[]}
 */
function elementIdentity(parsed, index) {
  const { elements, parents } = parsed;
  const element = elements[index];
  if (element === undefined) {
    return [];
  }
  const parentIndex = parents[index] ?? -1;
  const parent = elements[parentIndex];
  // AppKit can expose the window title again as a title-bar text child.
  const echo = titleEcho(element, parent, parents[parentIndex] ?? -1);
  return [
    element.role,
    element.id,
    echo ? undefined : element.name,
    echo ? undefined : element.value,
    element.url,
  ];
}

/**
 * @param {ElementState} element
 * @returns {string[]}
 */
function identityKeys(element) {
  /** @type {(string | false)[]} */
  const keys = [
    element.id !== undefined && element.id !== ""
      ? JSON.stringify([element.role, "id", element.id])
      : false,
    element.description !== undefined && element.description !== ""
      ? JSON.stringify([element.role, "description", element.description])
      : false,
    element.name !== element.role ? JSON.stringify([element.role, "name", element.name]) : false,
    PAGE_ROLES.has(element.role) && element.url !== undefined && element.url !== ""
      ? JSON.stringify([element.role, "url", element.url])
      : false,
  ];
  return keys.filter((key) => typeof key === "string");
}

/**
 * @param {ElementState} element
 * @param {Map<string, number>} counts
 * @returns {string | undefined}
 */
function uniqueKey(element, counts) {
  return identityKeys(element).find((key) => counts.get(key) === 1);
}

/**
 * Identify top-level web-page containers whose boundary identity is unambiguous in this snapshot.
 * @param {ParsedTree} parsed
 * @param {Map<string, number>} namedCounts
 * @returns {Set<number>}
 */
function findUniqueTopPages(parsed, namedCounts) {
  const { elements } = parsed;
  const pageCount = elements.filter((element) => PAGE_ROLES.has(element.role)).length;
  /** @type {Set<number>} */
  const unique = new Set();
  for (const [index, element] of elements.entries()) {
    if (!isTopPage(parsed, index)) {
      continue;
    }
    if (pageCount === 1 || uniqueKey(element, namedCounts) !== undefined) {
      unique.add(index);
    }
  }
  return unique;
}

/**
 * Compute full element subtree hashes (`descendants`) and page-isolated outer hashes for sibling comparisons.
 * @param {ParsedTree} parsed
 * @param {Set<number>} uniqueTopPages
 * @param {ReadonlyMap<number, number>} [maskedSlots]
 * @returns {{ subtree: string[], outerSubtree: string[] }}
 */
function subtreeHashes(parsed, uniqueTopPages, maskedSlots) {
  const { elements, children } = parsed;
  /** @type {string[]} */
  const subtree = [];
  /** @type {string[]} */
  const outerSubtree = [];
  for (let i = elements.length - 1; i >= 0; i--) {
    const element = elements[i];
    if (element === undefined) {
      continue;
    }
    const childList = children[i] ?? [];
    const descendants = childList.map((child) => subtree[child] ?? "");
    element.descendants = fingerprint(descendants);
    const slot = maskedSlots?.get(i);
    const id = elementIdentity(parsed, i);
    if (slot !== undefined) {
      subtree[i] = fingerprint(["masked", slot]);
    } else {
      subtree[i] = fingerprint([id, descendants]);
    }
    const outerDescendants = childList.map((child) => outerSubtree[child] ?? "");
    if (uniqueTopPages.has(i)) {
      outerSubtree[i] = fingerprint([id, "page-boundary"]);
    } else {
      outerSubtree[i] =
        slot !== undefined ? (subtree[i] ?? "") : fingerprint([id, outerDescendants]);
    }
  }
  return { subtree, outerSubtree };
}

/**
 * @param {ParsedTree} parsed
 * @param {string[]} outerSubtree
 * @param {string} empty
 */
function siblingHashes(parsed, outerSubtree, empty) {
  const { elements, children } = parsed;
  return children.map((nodes) => {
    const left = [empty];
    const right = Array(nodes.length + 1);
    for (const node of nodes) {
      left.push(fingerprint([left.at(-1) ?? "", outerSubtree[node] ?? ""]));
    }
    right[nodes.length] = empty;
    for (let j = nodes.length - 1; j >= 0; j--) {
      right[j] = fingerprint([outerSubtree[nodes[j] ?? 0] ?? "", right[j + 1] ?? ""]);
    }
    return {
      left,
      right,
      nonRows: fingerprint(
        nodes
          .filter((node) => elements[node]?.role !== "row")
          .map((node) => outerSubtree[node] ?? ""),
      ),
    };
  });
}

/**
 * @param {ElementState | undefined} element
 * @param {number} index
 * @param {string[]} subtree
 * @param {Map<string, number>} namedCounts
 * @returns {string | undefined}
 */
function rowKey(element, index, subtree, namedCounts) {
  if (element === undefined || element.role !== "row") {
    return;
  }
  return uniqueKey(element, namedCounts) ?? JSON.stringify(["row", "subtree", subtree[index]]);
}

/**
 * @typedef {{ windows: ElementState[], nativeWindowCandidate: boolean, siblingContexts: ReturnType<typeof siblingHashes>, subtree: string[], uniqueTopPages: Set<number>, empty: string, rowCounts: Map<string, number>, namedCounts: Map<string, number> }} ContextData
 */

/**
 * @param {ParsedTree} parsed
 * @param {ContextData} data
 * @param {number} parent
 * @param {number} child
 */
function siblingContext(parsed, data, parent, child) {
  const { elements, depths, positions } = parsed;
  const { left, right, nonRows } = data.siblingContexts[parent] ?? {
    left: [],
    right: [],
    nonRows: "",
  };
  if ((depths[parent] ?? -1) === 0) {
    return data.empty;
  }
  if (elements[child]?.role === "row") {
    return nonRows;
  }
  return fingerprint([left[positions[child] ?? 0] ?? "", right[(positions[child] ?? 0) + 1] ?? ""]);
}

/**
 * @param {ParsedTree} parsed
 * @param {ContextData} data
 * @param {number} childIndex
 * @returns {string | undefined}
 */
function uniqueRow(parsed, data, childIndex) {
  const key = rowKey(parsed.elements[childIndex], childIndex, data.subtree, data.namedCounts);
  return key !== undefined && data.rowCounts.get(key) === 1 ? key : undefined;
}

/**
 * @param {ElementState} ancestor
 * @param {number} ancestorParent
 * @param {Map<string, number>} counts
 * @returns {string | undefined}
 */
function uniqueBoundary(ancestor, ancestorParent, counts) {
  if (ancestorParent < 0 || ancestor.role === "row") {
    return;
  }
  return uniqueKey(ancestor, counts);
}

/**
 * @param {string | undefined} identifiedRow
 * @param {string | undefined} boundary
 * @param {ElementState} ancestor
 * @param {{ parent: number, counts: Map<string, number> }} context
 */
function nextBoundary(identifiedRow, boundary, ancestor, { parent, counts }) {
  if (identifiedRow === undefined || boundary !== undefined) {
    return boundary;
  }
  return uniqueBoundary(ancestor, parent, counts);
}

/**
 * @param {ElementState} ancestor
 * @param {ContextData} data
 * @returns {unknown[]}
 */
function ancestorIdentity(ancestor, data) {
  const name =
    data.nativeWindowCandidate && ancestor === data.windows[0] ? undefined : ancestor.name;
  return [
    ancestor.role,
    ancestor.id,
    name,
    itemRoles.has(ancestor.role) ? ancestor.value : undefined,
    ancestor.url,
  ];
}

/**
 * @param {string | undefined} row
 * @param {string | undefined} boundary
 * @param {unknown[]} rowPath
 * @returns {string | undefined}
 */
function rowContextHash(row, boundary, rowPath) {
  if (row !== undefined && boundary !== undefined) {
    return fingerprint([row, boundary, rowPath]);
  }
  return;
}

/**
 * @param {ElementState} element
 * @param {{ path: unknown[], identifiedRow: string | undefined, boundary: string | undefined, rowPath: unknown[], cellValues: (string | undefined)[] }} context
 */
function assignContext(element, { path, identifiedRow, boundary, rowPath, cellValues }) {
  const rowContext = rowContextHash(identifiedRow, boundary, rowPath);
  // Keep the full context as a fallback if uniqueness changes between observations.
  Object.assign(element, {
    context: fingerprint(path),
    ...(rowContext !== undefined ? { rowContext } : {}),
    cellValueContext: fingerprint(cellValues),
  });
}

/**
 * @param {ParsedTree} parsed
 * @param {ContextData} data
 * @param {{ path: unknown[], rowPath: unknown[], cellValues: (string | undefined)[], identifiedRow: string | undefined, boundary: string | undefined, aboveUniquePage: boolean }} acc
 * @param {{ child: number, parent: number }} step
 * @returns {{ identifiedRow: string | undefined, boundary: string | undefined, aboveUniquePage: boolean } | undefined}
 */
function stepElementContext(parsed, data, acc, { child, parent }) {
  const ancestor = parsed.elements[parent];
  if (ancestor === undefined) {
    return;
  }
  const aboveUniquePage = acc.aboveUniquePage || data.uniqueTopPages.has(child);
  // Prefix/suffix hashes exclude this branch without rescanning a large sibling list.
  const siblings = aboveUniquePage ? data.empty : siblingContext(parsed, data, parent, child);
  if (ancestor.role === "cell") {
    acc.cellValues.unshift(ancestor.value);
  }
  // The document check handles a sole standard window; retain names for other roots.
  const identity = ancestorIdentity(ancestor, data);
  acc.path.unshift([identity, siblings]);
  acc.rowPath.unshift([identity, acc.boundary !== undefined ? data.empty : siblings]);
  const identifiedRow = acc.identifiedRow ?? uniqueRow(parsed, data, child);
  const boundary = nextBoundary(identifiedRow, acc.boundary, ancestor, {
    parent: parsed.parents[parent] ?? -1,
    counts: data.namedCounts,
  });
  return { identifiedRow, boundary, aboveUniquePage };
}

/**
 * @param {ParsedTree} parsed
 * @param {ContextData} data
 * @param {number} i
 */
function setElementContext(parsed, data, i) {
  const { elements, parents } = parsed;
  const element = elements[i];
  if (element === undefined) {
    return;
  }
  /** @type {{ path: unknown[], rowPath: unknown[], cellValues: (string | undefined)[], identifiedRow: string | undefined, boundary: string | undefined, aboveUniquePage: boolean }} */
  const acc = {
    path: [],
    rowPath: [],
    cellValues: [],
    identifiedRow: undefined,
    boundary: undefined,
    aboveUniquePage: false,
  };
  for (
    let child = i, parent = parents[i] ?? -1;
    parent >= 0;
    child = parent, parent = parents[parent] ?? -1
  ) {
    const next = stepElementContext(parsed, data, acc, { child, parent });
    if (next === undefined) {
      break;
    }
    Object.assign(acc, next);
  }
  assignContext(element, acc);
}

/**
 * @param {ParsedTree} parsed
 * @param {ElementState[]} windows
 * @param {boolean} nativeWindowCandidate
 * @param {ReadonlyMap<number, number>} [maskedSlots]
 * @returns {void}
 */
export function enrichTree(parsed, windows, nativeWindowCandidate, maskedSlots) {
  const { elements } = parsed;
  /** @type {Map<string, number>} */
  const namedCounts = new Map();
  for (const element of elements) {
    for (const key of identityKeys(element)) {
      namedCounts.set(key, (namedCounts.get(key) ?? 0) + 1);
    }
  }
  const uniqueTopPages = findUniqueTopPages(parsed, namedCounts);
  const { subtree, outerSubtree } = subtreeHashes(parsed, uniqueTopPages, maskedSlots);
  const empty = fingerprint([]);
  const siblingContexts = siblingHashes(parsed, outerSubtree, empty);
  /** @type {Map<string, number>} */
  const rowCounts = new Map();
  for (const [index, element] of elements.entries()) {
    const key = rowKey(element, index, subtree, namedCounts);
    if (key !== undefined) {
      rowCounts.set(key, (rowCounts.get(key) ?? 0) + 1);
    }
  }
  const data = {
    windows,
    nativeWindowCandidate,
    siblingContexts,
    subtree,
    uniqueTopPages,
    empty,
    rowCounts,
    namedCounts,
  };
  for (let i = 0; i < elements.length; i++) {
    setElementContext(parsed, data, i);
  }
}
