import { createHash } from "node:crypto";

/**
 * One parsed Sky text element. `descendants`, `context`, `rowContext`, and
 * `cellValueContext` are enrichment hashes added by `parseAppState`.
 * @typedef {{ index: string, role: string, name: string, id?: string, description?: string, value?: string, url?: string, disabled: boolean, settable: boolean, secondaryActions: string[], line: string, parentIndex?: string, descendants?: string, context?: string, rowContext?: string, cellValueContext?: string }} ElementState
 */

/** @typedef {{ windowUrl: string | null, pageUrls: string[] }} DocumentIdentity */

/**
 * @typedef {{ app: string, title: string | null, url: string | null, documentIdentity: DocumentIdentity | null, nativeWindowIdentity: boolean, nativeSheetId?: string, text: string, elements: ElementState[], focused?: ElementState, focusedWindow?: boolean, observedAt: number }} AppObservation
 */

// Native macOS Sky snapshots are text. Keep complete values before any presentation limits.
const rolePattern =
  /^(standard window|split group|container|scroll area|scroll bar|value indicator|text entry area|secure text field|search text field|text field|edit field|close button|zoom button|minimize button|full screen button|increment arrow button|decrement arrow button|increment page button|decrement page button|radio button|pop up button|sort button|menu button|menu bar|menu item|button|checkbox|switch|slider|splitter|combo box|tab group|tab|link|row|text|toolbar|group|web area|HTML content|search)\b/i;
/**
 * @param {unknown} value
 * @returns {string}
 */
const fingerprint = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const itemRoles = new Set(["row", "group", "container"]);

/**
 * @param {string} index
 * @param {string} body
 * @param {boolean} [menuItem]
 * @returns {ElementState}
 */
function parseElement(index, body, menuItem = false) {
  const [header = "", ...lines] = body.split("\n");
  const rawRole =
    header.match(rolePattern)?.[1] ?? (menuItem ? "" : (header.split(/\s+/)[0] ?? ""));
  const role = menuItem
    ? "menu item"
    : rawRole.toLowerCase().replace(/^search text field$/, "search");
  const rest = header
    .slice(rawRole.length)
    .trimStart()
    .replace(/^\([^)]*\)\s*/, "");
  const markers = [
    ...rest.matchAll(
      /(?:^|,\s*)(ID|Description|Help|Secondary Actions|URL|Value|Placeholder):[ \t]?/gi,
    ),
  ];
  const fields = new Map(
    markers.map((marker, i) => {
      const key = (marker[1] ?? "").toLowerCase();
      const value = rest.slice(marker.index + marker[0].length, markers[i + 1]?.index);
      return [key, key === "value" ? value : value.trim()];
    }),
  );
  const labelText = rest.slice(0, markers[0]?.index);
  const label = (
    menuItem && rawRole.toLowerCase() !== "menu item" ? `${rawRole} ${labelText}` : labelText
  )
    .replace(/\s*\(disabled\)\s*$/i, "")
    .trim();
  const inline =
    body.match(
      /\((?:disabled,\s*)?(?:settable|editable),\s*(?:string|float|int|integer|bool|boolean)\)[ \t]?([\s\S]*)$/i,
    ) ??
    (role === "search" && fields.size === 0
      ? body.match(/\((?:disabled,\s*)?(?:settable|editable)\)[ \t]?([\s\S]*)$/i)
      : null);
  const value = fields.has("value")
    ? (fields.get("value") ?? "") + (lines.length > 0 ? `\n${lines.join("\n")}` : "")
    : (inline?.[1] ?? (role === "text" ? [label, ...lines].join("\n") : undefined));
  const id = fields.get("id");
  const buttonish =
    /^(?:button|pop up button|menu button|sort button|switch|checkbox|radio button|combo box|link)$/.test(
      role,
    ) && label !== ""
      ? label
      : undefined;
  const description = fields.get("description") ?? buttonish;
  return {
    index,
    role,
    name:
      [menuItem ? label : "", description, inline !== null ? "" : label, id, role].find(
        (part) => part !== undefined && part !== "",
      ) ?? role,
    ...(id !== undefined ? { id } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(value !== undefined ? { value } : {}),
    ...(fields.get("url") !== undefined ? { url: fields.get("url") ?? "" } : {}),
    disabled: /\([^)]*\bdisabled\b[^)]*\)/i.test(header),
    settable: /\([^)]*\b(?:settable|editable)\b[^)]*\)/i.test(header),
    secondaryActions:
      fields
        .get("secondary actions")
        ?.split(",")
        .map((s) => s.trim())
        .filter(Boolean) ?? [],
    line: `${index} ${body}`,
  };
}

/**
 * @param {string} app
 * @param {string} text
 * @returns {AppObservation}
 */
export function parseAppState(app, text) {
  if (typeof app !== "string" || typeof text !== "string")
    throw new TypeError("App state requires app and text strings.");
  /** @type {ElementState[]} */
  const elements = [];
  /** @type {number[]} */
  const depths = [];
  /** @type {number[]} */
  const parents = [];
  /** @type {number[]} */
  const stack = [];
  /** @type {number[]} */
  const positions = [];
  /** @type {number[][]} */
  const children = [];
  /** @type {{ index: string, depth: number, lines: string[] } | undefined} */
  let current;
  let ambiguousRoot = false;
  const flush = () => {
    if (current) {
      const i = elements.length;
      stack.length = current.depth;
      const parent = stack.at(-1) ?? -1;
      parents[i] = parent;
      if (parent >= 0) {
        const siblings = children[parent] ?? [];
        positions[i] = siblings.length;
        siblings.push(i);
      }
      children.push([]);
      // Sky's menu descendants are labels, even when named Window or Sheet.
      const element = parseElement(
        current.index,
        current.lines.join("\n"),
        parent >= 0 && ["menu bar", "menu item"].includes(elements[parent]?.role ?? ""),
      );
      if (parent >= 0) {
        const parentIndexValue = elements[parent]?.index;
        if (parentIndexValue !== undefined) element.parentIndex = parentIndexValue;
      }
      elements.push(element);
      depths.push(current.depth);
      stack[current.depth] = i;
    }
    current = undefined;
  };
  // App-specific instructions and focus summaries are not part of a field value.
  const tree = text.replace(
    /^<app_specific_instructions>[\s\S]*?<\/app_specific_instructions>\s*/,
    "",
  );
  const lines = tree.split("\n");
  const closingTag = lines.findLastIndex((line) => /^\s*<\/app_state>\s*$/.test(line));
  const focusLine = lines.findLastIndex(
    (line, index) =>
      /^The focused UI element is\s+\d+\s/.test(line) &&
      lines
        .slice(index + 1)
        .every(
          (next) =>
            next.trim().length === 0 ||
            /^\s*<\/app_state>\s*$/.test(next) ||
            next.startsWith("Selected text:"),
        ),
  );
  let wrapped = false;
  for (const [index, line] of lines.entries()) {
    if (!current && elements.length === 0 && /^\s*<app_state>\s*$/.test(line)) {
      wrapped = true;
      continue;
    }
    if (wrapped && index === closingTag) {
      flush();
      wrapped = false;
      continue;
    }
    let footer;
    if (wrapped) footer = closingTag;
    else if (focusLine >= 0) footer = focusLine;
    else footer = lines.length;
    const selectionTrailer =
      line.startsWith("Selected text:") &&
      index < footer &&
      lines.slice(index + 1, footer).every((next) => next.trim().length === 0);
    if (
      index === focusLine ||
      selectionTrailer ||
      (!current && /^\s*(?:Computer Use state|App=|Window:|Selected text:|Note:)/.test(line))
    ) {
      flush();
      continue;
    }
    const match = line.match(/^(\t*)(\d+)[ \t]+(.+)$/);
    // Sky indents child rows with tabs; multiline values retain their own whitespace.
    // ponytail: literal text shaped exactly like a native row remains ambiguous without structured upstream state.
    if (
      match &&
      (line.startsWith("\t") ||
        (!current && elements.length === 0) ||
        /^(standard window|window|sheet|menu bar)\b/i.test(match[3] ?? ""))
    ) {
      flush();
      current = {
        index: match[2] ?? "",
        depth: (match[1] ?? "").length,
        lines: [match[3] ?? ""],
      };
    } else {
      if (match) ambiguousRoot = true;
      if (current) current.lines.push(line);
    }
  }
  flush();
  const roots = elements.filter((element, index) => (parents[index] ?? -1) < 0);
  const documents = elements.filter((element) =>
    ["standard window", "window", "sheet", "dialog"].includes(element.role),
  );
  const windows = roots.filter((element) =>
    ["standard window", "window", "sheet"].includes(element.role),
  );
  const nativeWindowCandidate =
    !ambiguousRoot && windows.length === 1 && windows[0]?.role === "standard window";
  /**
   * @param {ElementState} element
   * @param {number} index
   * @returns {unknown[]}
   */
  const identity = (element, index) => {
    const parentIndex = parents[index] ?? -1,
      parent = elements[parentIndex];
    // AppKit can expose the window title again as a title-bar text child.
    const titleEcho =
      parent &&
      (parents[parentIndex] ?? -1) < 0 &&
      parent.role === "standard window" &&
      element.role === "text" &&
      (element.id === undefined || element.id === "") &&
      (element.url === undefined || element.url === "") &&
      element.name === parent.name &&
      element.value?.replace(/\n+$/, "") === element.name;
    return [
      element.role,
      element.id,
      titleEcho === true ? undefined : element.name,
      titleEcho === true ? undefined : element.value,
      element.url,
    ];
  };
  /** @type {string[]} */
  const subtree = [];
  for (let i = elements.length - 1; i >= 0; i--) {
    const element = elements[i];
    if (element === undefined) continue;
    const descendants = (children[i] ?? []).map((child) => subtree[child] ?? "");
    element.descendants = fingerprint(descendants);
    subtree[i] = fingerprint([identity(element, i), descendants]);
  }
  const empty = fingerprint([]);
  /**
   * @param {number[]} nodes
   * @returns {{ left: string[], right: string[], nonRows: string }}
   */
  const siblingContexts = children.map((nodes) => {
    const left = [empty],
      right = Array(nodes.length + 1);
    for (const node of nodes) left.push(fingerprint([left.at(-1) ?? "", subtree[node] ?? ""]));
    right[nodes.length] = empty;
    for (let j = nodes.length - 1; j >= 0; j--)
      right[j] = fingerprint([subtree[nodes[j] ?? 0] ?? "", right[j + 1] ?? ""]);
    return {
      left,
      right,
      nonRows: fingerprint(
        nodes.filter((node) => elements[node]?.role !== "row").map((node) => subtree[node] ?? ""),
      ),
    };
  });
  /**
   * @param {ElementState} element
   * @returns {(string | false)[]}
   */
  const identityKeys = (element) => {
    /** @type {(string | false)[]} */
    const keys = [
      element.id !== undefined && element.id !== ""
        ? JSON.stringify([element.role, "id", element.id])
        : false,
      element.description !== undefined && element.description !== ""
        ? JSON.stringify([element.role, "description", element.description])
        : false,
      element.name !== element.role ? JSON.stringify([element.role, "name", element.name]) : false,
    ];
    return keys.filter(Boolean);
  };
  /**
   * @param {ElementState} element
   * @returns {string | false}
   */
  const namedKey = (element) => identityKeys(element)[0] ?? false;
  /** @type {Map<string | false, number>} */
  const rowCounts = new Map();
  /** @type {Map<string | false, number>} */
  const namedCounts = new Map();
  for (const element of elements) {
    for (const key of identityKeys(element)) {
      namedCounts.set(key, (namedCounts.get(key) ?? 0) + 1);
      if (element.role === "row") rowCounts.set(key, (rowCounts.get(key) ?? 0) + 1);
    }
  }
  for (let i = 0; i < elements.length; i++) {
    const path = [],
      rowPath = [];
    const cellValues = [];
    /** @type {string | undefined} */
    let identifiedRow;
    /** @type {string | undefined} */
    let boundary;
    for (
      let child = i, parent = parents[i] ?? -1;
      parent >= 0;
      child = parent, parent = parents[parent] ?? -1
    ) {
      const ancestor = elements[parent];
      if (ancestor === undefined) break;
      // Prefix/suffix hashes exclude this branch without rescanning a large sibling list.
      const { left, right, nonRows } = siblingContexts[parent] ?? {
        left: [],
        right: [],
        nonRows: "",
      };
      // Other rows are independent; a group might instead be part of this item.
      let siblings;
      if ((depths[parent] ?? -1) === 0) siblings = empty;
      else if (elements[child]?.role === "row") siblings = nonRows;
      else
        siblings = fingerprint([
          left[positions[child] ?? 0] ?? "",
          right[(positions[child] ?? 0) + 1] ?? "",
        ]);
      if (ancestor.role === "cell") cellValues.unshift(ancestor.value);
      // The document check handles a sole standard window; retain names for other roots.
      const name = nativeWindowCandidate && ancestor === windows[0] ? undefined : ancestor.name;
      const ancestorIdentity = [
        ancestor.role,
        ancestor.id,
        name,
        itemRoles.has(ancestor.role) ? ancestor.value : undefined,
        ancestor.url,
      ];
      path.unshift([ancestorIdentity, siblings]);
      rowPath.unshift([ancestorIdentity, boundary !== undefined ? empty : siblings]);
      const childElement = elements[child];
      const row =
        childElement !== undefined && childElement.role === "row" ? namedKey(childElement) : false;
      if (identifiedRow === undefined && typeof row === "string" && rowCounts.get(row) === 1)
        identifiedRow = row;
      const named = namedKey(ancestor);
      if (
        identifiedRow !== undefined &&
        boundary === undefined &&
        (parents[parent] ?? -1) >= 0 &&
        ancestor.role !== "row" &&
        typeof named === "string" &&
        namedCounts.get(named) === 1
      )
        boundary = named;
    }
    const element = elements[i];
    if (element === undefined) continue;
    element.context = fingerprint(path);
    // Keep the full context as a fallback if uniqueness changes between observations.
    if (identifiedRow !== undefined && boundary !== undefined)
      element.rowContext = fingerprint([identifiedRow, boundary, rowPath]);
    element.cellValueContext = fingerprint(cellValues);
  }
  const headerTitle = tree.match(/^Window:\s*"(.*)",\s*App:/m)?.[1] ?? null;
  let title = headerTitle;
  // Nonstandard roots may not appear in the native AXWindow list (notably sheets).
  let nativeWindowIdentity = windows.every((window) => window.role === "standard window");
  if (windows.length === 1) {
    const row = ((windows[0]?.line ?? "").split("\n")[0] ?? "").replace(
      /^\d+\s+(?:standard window|window|sheet)\s*/i,
      "",
    );
    const head =
      row.split(/(?:^|,\s*)(?:ID|Description|Help|Secondary Actions|URL|Value|Placeholder):/i)[0] ??
      "";
    const raised =
      windows[0]?.role === "standard window"
        ? row.match(/(?:^|, )Secondary Actions: Raise, (.+)$/)?.[1]
        : undefined;
    if (head !== "") title = head;
    else if (raised !== undefined && raised !== "") title = raised;
    else title = headerTitle;
  }
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
    if (!pageRoles.has(element.role)) return false;
    for (let parent = parents[index] ?? -1; parent >= 0; parent = parents[parent] ?? -1)
      if (pageRoles.has(elements[parent]?.role ?? "")) return false;
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
  /** @type {string | null} */
  let url = null;
  const windowUrl = windows.length === 1 ? windows[0]?.url : undefined;
  if (windowUrl !== undefined && windowUrl !== "") url = windowUrl;
  else if (pageUrls.length === 1) url = pageUrls[0] ?? null;
  if (
    url !== null &&
    url !== "" &&
    (!/^[a-z][\w+.-]*:/i.test(url) || /^[^/?#:\s]+:\d+(?:[/?#]|$)/.test(url))
  ) {
    const currentUrl = url;
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
    if (addresses.length === 1) url = addresses[0] ?? null;
  }
  if (
    (title === null || title === "") &&
    (url === null || url === "") &&
    windows.length === 1 &&
    pages.length === 1
  ) {
    const label = pages[0]?.line.match(
      /^\d+\s+(?:HTML content|web area)\s+((?:https?|chrome-extension):\/\/[^\s/?#]+(?:[/?#]\S*)?)$/i,
    )?.[1];
    // Sky exposes AX text, not native-window or origin proof.
    if (label !== undefined && label === pages[0]?.name && URL.canParse(label)) {
      title = label;
      nativeWindowIdentity = false;
    }
  }
  const sheet = windows.length === 1 && windows[0]?.role === "sheet" ? windows[0] : undefined;
  // Only a sole native sheet can identify an untitled document, never nested or ambiguous roots.
  // ponytail: reused sheet IDs cannot prove instance/hidden-parent continuity; use native instance tokens if Sky exposes them.
  const sheetIdentity = sheet?.id;
  const nativeSheetId =
    !ambiguousRoot &&
    sheetIdentity !== undefined &&
    sheetIdentity.trim() !== "" &&
    documents.length === 1 &&
    pages.length === 0 &&
    roots.every((root) => root === sheet || root.role === "menu bar") &&
    elements.filter((element) => element.id === sheetIdentity).length === 1
      ? sheetIdentity
      : undefined;
  const focusedIndex = lines[focusLine]?.match(/^The focused UI element is\s+(\d+)\s/)?.[1];
  const focused = elements.find((e) => e.index === focusedIndex);
  return {
    app,
    title,
    url,
    documentIdentity,
    nativeWindowIdentity,
    ...(nativeSheetId !== undefined ? { nativeSheetId } : {}),
    text,
    elements,
    ...(focused !== undefined
      ? { focused, focusedWindow: focused === windows[0] && nativeWindowCandidate }
      : {}),
    observedAt: Date.now(),
  };
}

/**
 * @param {AppObservation} before
 * @param {AppObservation} after
 * @returns {boolean}
 */
export function sameDocument(before, after) {
  if (before.app !== after.app || before.nativeSheetId !== after.nativeSheetId) return false;
  const document = before.documentIdentity,
    freshDocument = after.documentIdentity;
  if (!document || !freshDocument) return before.title === after.title && before.url === after.url;
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
    if (element.id !== undefined && element.id !== "")
      return other.id === element.id && other.role === element.role;
    if (element.description !== undefined && element.description !== "")
      return other.description === element.description && other.role === element.role;
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
  if (exact.length > 0) return exact.length === 1 ? exact[0] : undefined;
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
