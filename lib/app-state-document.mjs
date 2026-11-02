/** @typedef {import("./app-state-parse.mjs").ElementState} ElementState */
/** @typedef {import("./app-state-parse.mjs").ParsedTree} ParsedTree */

/** @param {string | null | undefined} value @returns {boolean} */
function hasText(value) {
  return value !== undefined && value !== null && value !== "";
}

/**
 * @param {string} tree
 * @param {ElementState[]} windows
 * @returns {string | null}
 */
function windowTitle(tree, windows) {
  const headerTitle = tree.match(/^Window:\s*"(.*)",\s*App:/m)?.[1] ?? null;
  return windows.length === 1 ? singleWindowTitle(windows[0], headerTitle) : headerTitle;
}

/**
 * @param {ElementState | undefined} window
 * @param {string | null} fallback
 * @returns {string | null}
 */
function singleWindowTitle(window, fallback) {
  const row = ((window?.line ?? "").split("\n")[0] ?? "").replace(
    /^\d+\s+(?:standard window|window|sheet)\s*/i,
    "",
  );
  const head = titleHead(row);
  const raised =
    window?.role === "standard window"
      ? row.match(/(?:^|, )Secondary Actions: Raise, (.+)$/)?.[1]
      : undefined;
  if (head !== "") {
    return head;
  }
  const candidate = raised ?? "";
  return candidate !== "" ? candidate : fallback;
}

/** @param {string} row @returns {string} */
function titleHead(row) {
  return (
    row.split(/(?:^|,\s*)(?:ID|Description|Help|Secondary Actions|URL|Value|Placeholder):/i)[0] ??
    ""
  );
}

/**
 * @param {ParsedTree} parsed
 * @param {ElementState[]} windows
 * @param {boolean} nativeWindowCandidate
 */
function pageEvidence(parsed, windows, nativeWindowCandidate) {
  const { elements, parents } = parsed;
  const pageRoles = new Set(["web area", "html content"]);
  const pages = elements.filter((e) => pageRoles.has(e.role));
  const pageUrls = [
    ...new Set(
      pages
        .map((e) => e.url)
        .filter((u) => u !== undefined)
        .filter((u) => u !== ""),
    ),
  ];
  // Nested pages are embedded frames and can navigate independently of their parent document.
  const topPages = elements.filter((element, index) => {
    if (!pageRoles.has(element.role)) {
      return false;
    }
    for (let parent = parents[index] ?? -1; parent >= 0; parent = parents[parent] ?? -1) {
      if (pageRoles.has(elements[parent]?.role ?? "")) {
        return false;
      }
    }
    return true;
  });
  const soleWindowUrl = windows[0]?.url;
  const documentIdentity =
    nativeWindowCandidate &&
    topPages.every((page) => page.url !== undefined && page.url !== "") &&
    (soleWindowUrl !== undefined && soleWindowUrl !== "" ? true : topPages.length > 0)
      ? {
          windowUrl: windows[0]?.url ?? null,
          pageUrls: topPages.map((page) => page.url ?? "").sort(),
        }
      : null;
  return { pages, pageUrls, documentIdentity };
}

/**
 * @param {ElementState[]} elements
 * @param {ElementState[]} windows
 * @param {string[]} pageUrls
 * @returns {string | null}
 */
function documentUrl(elements, windows, pageUrls) {
  /** @type {string | null} */
  let url = null;
  const windowUrl = (windows.length === 1 ? windows[0]?.url : undefined) ?? "";
  if (windowUrl !== "") {
    url = windowUrl;
  } else if (pageUrls.length === 1) {
    url = pageUrls[0] ?? null;
  }
  return url !== null && needsSchemeResolution(url) ? resolvedAddress(elements, url) : url;
}

/**
 * @param {ElementState[]} elements
 * @param {string} currentUrl
 * @returns {string | null}
 */
function resolvedAddress(elements, currentUrl) {
  /**
   * @param {string} value
   * @returns {string}
   */
  const display = (value) => value.replace(/^[a-z][\w+.-]*:\/\//i, "").replace(/\/$/, "");
  const addresses = [
    ...new Set(
      elements
        .filter((e) => /field|search/.test(e.role) && /address|location|omnibox/i.test(e.name))
        .map((e) => e.value?.trim())
        .filter(
          (value) =>
            value !== undefined &&
            value !== "" &&
            /^[a-z][\w+.-]*:\/\//i.test(value) &&
            display(value) === display(currentUrl),
        ),
    ),
  ];
  return addresses.length === 1 ? (addresses[0] ?? null) : currentUrl;
}

/**
 * @param {string} url
 */
function needsSchemeResolution(url) {
  return url !== "" && (!/^[a-z][\w+.-]*:/i.test(url) || /^[^/?#:\s]+:\d+(?:[/?#]|$)/.test(url));
}

/**
 * @param {string | null} title
 * @param {string | null} url
 * @param {ElementState[]} windows
 * @param {ElementState[]} pages
 * @returns {string | undefined}
 */
function pageTitleFallback(title, url, windows, pages) {
  if (hasText(title) || hasText(url) || windows.length !== 1 || pages.length !== 1) {
    return;
  }
  return pageLabel(pages[0]);
}

/** @param {ElementState | undefined} page @returns {string | undefined} */
function pageLabel(page) {
  const label = page?.line.match(
    /^\d+\s+(?:HTML content|web area)\s+((?:https?|chrome-extension):\/\/[^\s/?#]+(?:[/?#]\S*)?)$/i,
  )?.[1];
  if (label !== undefined && label === page?.name && URL.canParse(label)) {
    return label;
  }
  return;
}

/**
 * @param {ParsedTree} parsed
 * @param {{ windows: ElementState[], roots: ElementState[], documents: ElementState[] }} scope
 * @param {ElementState[]} pages
 */
function sheetId(parsed, { windows, roots, documents }, pages) {
  const { elements, ambiguousRoot } = parsed;
  const sheet = singleSheet(windows);
  const sheetIdentity = sheet?.id;
  return !ambiguousRoot &&
    hasSheetId(sheetIdentity) &&
    documents.length === 1 &&
    pages.length === 0 &&
    sheetRootsMatch(roots, sheet) &&
    uniqueSheetId(elements, sheetIdentity)
    ? sheetIdentity
    : undefined;
}

/** @param {ElementState[]} windows @returns {ElementState | undefined} */
function singleSheet(windows) {
  return windows.length === 1 && windows[0]?.role === "sheet" ? windows[0] : undefined;
}

/** @param {ElementState[]} elements @param {string} id */
function uniqueSheetId(elements, id) {
  return elements.filter((element) => element.id === id).length === 1;
}

/**
 * @param {ElementState[]} roots
 * @param {ElementState | undefined} sheet
 * @returns {boolean}
 */
function sheetRootsMatch(roots, sheet) {
  return roots.every((root) => root === sheet || root.role === "menu bar");
}

/**
 * @param {string | undefined} value
 * @returns {value is string}
 */
function hasSheetId(value) {
  return value !== undefined && value.trim() !== "";
}

/**
 * @param {ParsedTree} parsed
 * @param {{ windows: ElementState[], roots: ElementState[], documents: ElementState[], nativeWindowCandidate: boolean }} scope
 */
export function documentMetadata(parsed, scope) {
  const { elements, tree } = parsed;
  const { windows, nativeWindowCandidate } = scope;
  let title = windowTitle(tree, windows);
  let nativeWindowIdentity = windows.every((window) => window.role === "standard window");
  const { pages, pageUrls, documentIdentity } = pageEvidence(
    parsed,
    windows,
    nativeWindowCandidate,
  );
  const url = documentUrl(elements, windows, pageUrls);
  const fallback = pageTitleFallback(title, url, windows, pages);
  if (fallback !== undefined) {
    title = fallback;
    nativeWindowIdentity = false;
  }
  // Only a sole native sheet can identify an untitled document, never nested or ambiguous roots.
  // ponytail: reused sheet IDs cannot prove instance/hidden-parent continuity; use native instance tokens if Sky exposes them.
  const nativeSheetId = sheetId(parsed, scope, pages);
  return { title, url, documentIdentity, nativeWindowIdentity, nativeSheetId };
}
