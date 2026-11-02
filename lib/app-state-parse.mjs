import { createHash } from "node:crypto";
import { documentMetadata } from "./app-state-document.mjs";

/**
 * One parsed Sky text element. `descendants`, `context`, `rowContext`, and
 * `cellValueContext` are enrichment hashes added by `parseAppState`.
 * @typedef {{ index: string, role: string, name: string, id?: string, description?: string, value?: string, url?: string, disabled: boolean, settable: boolean, secondaryActions: string[], line: string, parentIndex?: string, descendants?: string, context?: string, rowContext?: string, cellValueContext?: string }} ElementState
 */

/** @typedef {{ windowUrl: string | null, pageUrls: string[] }} DocumentIdentity */
/** @typedef {{ elements: ElementState[], depths: number[], parents: number[], positions: number[], children: number[][], tree: string, lines: string[], focusLine: number, ambiguousRoot: boolean }} ParsedTree */

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
 * @param {string} rest
 * @returns {{ fields: Map<string, string>, labelText: string }}
 */
function parseFields(rest) {
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
  return { fields, labelText: rest.slice(0, markers[0]?.index) };
}

/**
 * @param {string} body
 * @param {string} role
 * @param {number} fieldCount
 * @returns {RegExpMatchArray | null}
 */
function inlineValue(body, role, fieldCount) {
  return (
    body.match(
      /\((?:disabled,\s*)?(?:settable|editable),\s*(?:string|float|int|integer|bool|boolean)\)[ \t]?([\s\S]*)$/i,
    ) ??
    (role === "search" && fieldCount === 0
      ? body.match(/\((?:disabled,\s*)?(?:settable|editable)\)[ \t]?([\s\S]*)$/i)
      : null)
  );
}

/**
 * @param {Map<string, string>} fields
 * @param {{ lines: string[], label: string, role: string, inline: RegExpMatchArray | null }} context
 * @returns {string | undefined}
 */
function elementValue(fields, { lines, label, role, inline }) {
  if (fields.has("value")) {
    return (fields.get("value") ?? "") + (lines.length > 0 ? `\n${lines.join("\n")}` : "");
  }
  return inline?.[1] ?? (role === "text" ? [label, ...lines].join("\n") : undefined);
}

/**
 * @param {Map<string, string>} fields
 * @param {{ label: string, role: string, inline: RegExpMatchArray | null, menuItem: boolean }} context
 */
function elementAttributes(fields, { label, role, inline, menuItem }) {
  const id = fields.get("id");
  const buttonish =
    /^(?:button|pop up button|menu button|sort button|switch|checkbox|radio button|combo box|link)$/.test(
      role,
    ) && label !== ""
      ? label
      : undefined;
  const description = fields.get("description") ?? buttonish;
  return {
    name:
      [menuItem ? label : "", description, inline !== null ? "" : label, id, role].find(
        (part) => part !== undefined && part !== "",
      ) ?? role,
    ...(id !== undefined ? { id } : {}),
    ...(description !== undefined ? { description } : {}),
  };
}

/**
 * @param {string} header
 * @param {boolean} menuItem
 */
function elementHeader(header, menuItem) {
  const rawRole =
    header.match(rolePattern)?.[1] ?? (menuItem ? "" : (header.split(/\s+/)[0] ?? ""));
  const role = menuItem
    ? "menu item"
    : rawRole.toLowerCase().replace(/^search text field$/, "search");
  const rest = header
    .slice(rawRole.length)
    .trimStart()
    .replace(/^\([^)]*\)\s*/, "");
  const { fields, labelText } = parseFields(rest);
  const label = (
    menuItem && rawRole.toLowerCase() !== "menu item" ? `${rawRole} ${labelText}` : labelText
  )
    .replace(/\s*\(disabled\)\s*$/i, "")
    .trim();
  return { role, label, fields };
}

/**
 * @param {string} index
 * @param {string} body
 * @param {boolean} [menuItem]
 * @returns {ElementState}
 */
function parseElement(index, body, menuItem = false) {
  const [header = "", ...lines] = body.split("\n");
  const { role, label, fields } = elementHeader(header, menuItem);
  const inline = inlineValue(body, role, fields.size);
  const value = elementValue(fields, { lines, label, role, inline });
  return {
    index,
    role,
    ...elementAttributes(fields, { label, role, inline, menuItem }),
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
 * Append the current row to the parsed hierarchy.
 * @param {{ index: string, depth: number, lines: string[] } | undefined} current
 * @param {{ elements: ElementState[], depths: number[], parents: number[], stack: number[], positions: number[], children: number[][] }} state
 */
function appendTreeRow(current, state) {
  if (current === undefined) {
    return;
  }
  const { elements, depths, parents, stack, positions, children } = state;
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
  const element = parseElement(
    current.index,
    current.lines.join("\n"),
    isMenuParent(elements[parent]),
  );
  const parentIndex = parent >= 0 ? elements[parent]?.index : undefined;
  if (parentIndex !== undefined) {
    element.parentIndex = parentIndex;
  }
  elements.push(element);
  depths.push(current.depth);
  stack[current.depth] = i;
}

/** @param {ElementState | undefined} element */
function isMenuParent(element) {
  return ["menu bar", "menu item"].includes(element?.role ?? "");
}

/**
 * @param {string[]} lines
 * @param {number} closingTag
 * @param {number} focusLine
 */
function scanTreeRows(lines, closingTag, focusLine) {
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
  const state = { elements, depths, parents, stack, positions, children };
  const flush = () => {
    appendTreeRow(current, state);
    current = undefined;
  };
  let wrapped = false;
  for (const [index, line] of lines.entries()) {
    if (isOpeningTag(line, current, elements.length)) {
      wrapped = true;
      continue;
    }
    if (isClosingTag(wrapped, index, closingTag)) {
      flush();
      wrapped = false;
      continue;
    }
    const footer = treeFooter(wrapped, closingTag, focusLine, lines.length);
    const selectionTrailer = isSelectionTrailer(line, index, footer, lines);
    if (isTreeFooter(line, index === focusLine, selectionTrailer, current === undefined)) {
      flush();
      continue;
    }
    const match = line.match(/^(\t*)(\d+)[ \t]+(.+)$/);
    // Sky indents child rows with tabs; multiline values retain their own whitespace.
    // ponytail: literal text shaped exactly like a native row remains ambiguous without structured upstream state.
    if (match && isTreeRow(line, match, isFirstTreeRow(current, elements.length))) {
      flush();
      current = {
        index: match[2] ?? "",
        depth: (match[1] ?? "").length,
        lines: [match[3] ?? ""],
      };
    } else {
      ambiguousRoot = appendAmbiguousContinuation(current, line, match, ambiguousRoot);
    }
  }
  flush();
  return { elements, depths, parents, positions, children, ambiguousRoot };
}

/**
 * @param {{ lines: string[] } | undefined} current
 * @param {string} line
 * @param {RegExpMatchArray | null} match
 * @param {boolean} prior
 */
function appendAmbiguousContinuation(current, line, match, prior) {
  current?.lines.push(line);
  return match !== null || prior;
}

/**
 * @param {boolean} wrapped
 * @param {number} index
 * @param {number} closingTag
 */
function isClosingTag(wrapped, index, closingTag) {
  return wrapped && index === closingTag;
}

/**
 * @param {{ index: string, depth: number, lines: string[] } | undefined} current
 * @param {number} count
 */
function isFirstTreeRow(current, count) {
  return current === undefined && count === 0;
}

/**
 * @param {string} line
 * @param {{ index: string, depth: number, lines: string[] } | undefined} current
 * @param {number} count
 */
function isOpeningTag(line, current, count) {
  return isFirstTreeRow(current, count) && /^\s*<app_state>\s*$/.test(line);
}

/**
 * @param {boolean} wrapped
 * @param {number} closingTag
 * @param {number} focusLine
 * @param {number} length
 */
function treeFooter(wrapped, closingTag, focusLine, length) {
  if (wrapped) {
    return closingTag;
  }
  return focusLine >= 0 ? focusLine : length;
}

/**
 * @param {string} line
 * @param {boolean} focused
 * @param {boolean} selection
 * @param {boolean} betweenRows
 */
function isTreeFooter(line, focused, selection, betweenRows) {
  return (
    focused ||
    selection ||
    (betweenRows && /^\s*(?:Computer Use state|App=|Window:|Selected text:|Note:)/.test(line))
  );
}

/**
 * @param {string} line
 * @param {number} index
 * @param {number} footer
 * @param {string[]} lines
 */
function isSelectionTrailer(line, index, footer, lines) {
  return (
    line.startsWith("Selected text:") &&
    index < footer &&
    lines.slice(index + 1, footer).every((next) => next.trim().length === 0)
  );
}

/**
 * @param {string} line
 * @param {RegExpMatchArray} match
 * @param {boolean} first
 */
function isTreeRow(line, match, first) {
  return (
    line.startsWith("\t") ||
    first ||
    /^(standard window|window|sheet|menu bar)\b/i.test(match[3] ?? "")
  );
}

/**
 * @param {string} text
 */
function parseTree(text) {
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
  return { ...scanTreeRows(lines, closingTag, focusLine), tree, lines, focusLine };
}

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
 * @param {ReturnType<typeof parseTree>} parsed
 * @returns {string[]}
 */
function subtreeHashes(parsed) {
  const { elements, parents, children } = parsed;
  /**
   * @param {ElementState} element
   * @param {number} index
   * @returns {unknown[]}
   */
  const identity = (element, index) => {
    const parentIndex = parents[index] ?? -1,
      parent = elements[parentIndex];
    // AppKit can expose the window title again as a title-bar text child.
    const echo = titleEcho(element, parent, parents[parentIndex] ?? -1);
    return [
      element.role,
      element.id,
      echo ? undefined : element.name,
      echo ? undefined : element.value,
      element.url,
    ];
  };
  /** @type {string[]} */
  const subtree = [];
  for (let i = elements.length - 1; i >= 0; i--) {
    const element = elements[i];
    if (element === undefined) {
      continue;
    }
    const descendants = (children[i] ?? []).map((child) => subtree[child] ?? "");
    element.descendants = fingerprint(descendants);
    subtree[i] = fingerprint([identity(element, i), descendants]);
  }
  return subtree;
}

/**
 * @param {ReturnType<typeof parseTree>} parsed
 * @param {string[]} subtree
 * @param {string} empty
 */
function siblingHashes(parsed, subtree, empty) {
  const { elements, children } = parsed;
  /**
   * @param {number[]} nodes
   * @returns {{ left: string[], right: string[], nonRows: string }}
   */
  return children.map((nodes) => {
    const left = [empty],
      right = Array(nodes.length + 1);
    for (const node of nodes) {
      left.push(fingerprint([left.at(-1) ?? "", subtree[node] ?? ""]));
    }
    right[nodes.length] = empty;
    for (let j = nodes.length - 1; j >= 0; j--) {
      right[j] = fingerprint([subtree[nodes[j] ?? 0] ?? "", right[j + 1] ?? ""]);
    }
    return {
      left,
      right,
      nonRows: fingerprint(
        nodes.filter((node) => elements[node]?.role !== "row").map((node) => subtree[node] ?? ""),
      ),
    };
  });
}

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

/**
 * @typedef {{ windows: ElementState[], nativeWindowCandidate: boolean, siblingContexts: ReturnType<typeof siblingHashes>, empty: string, rowCounts: Map<string | false, number>, namedCounts: Map<string | false, number> }} ContextData
 */

/**
 * @param {ReturnType<typeof parseTree>} parsed
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
 * @param {ElementState | undefined} child
 * @param {Map<string | false, number>} counts
 * @returns {string | undefined}
 */
function uniqueRow(child, counts) {
  const key = child !== undefined && child.role === "row" ? namedKey(child) : false;
  return typeof key === "string" && counts.get(key) === 1 ? key : undefined;
}

/**
 * @param {ElementState} ancestor
 * @param {number} ancestorParent
 * @param {Map<string | false, number>} counts
 * @returns {string | undefined}
 */
function uniqueBoundary(ancestor, ancestorParent, counts) {
  const key = namedKey(ancestor);
  if (
    ancestorParent >= 0 &&
    ancestor.role !== "row" &&
    typeof key === "string" &&
    counts.get(key) === 1
  ) {
    return key;
  }
  return;
}

/**
 * @param {string | undefined} identifiedRow
 * @param {string | undefined} boundary
 * @param {ElementState} ancestor
 * @param {{ parent: number, counts: Map<string | false, number> }} context
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
 * @param {string | undefined} boundary
 * @param {string} empty
 * @param {string} siblings
 */
function rowSiblingContext(boundary, empty, siblings) {
  return boundary !== undefined ? empty : siblings;
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
 * @param {ReturnType<typeof parseTree>} parsed
 * @param {ContextData} data
 * @param {number} i
 */
function setElementContext(parsed, data, i) {
  const { elements, parents } = parsed;
  const { empty, rowCounts, namedCounts } = data;
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
    if (ancestor === undefined) {
      break;
    }
    // Prefix/suffix hashes exclude this branch without rescanning a large sibling list.
    const siblings = siblingContext(parsed, data, parent, child);
    if (ancestor.role === "cell") {
      cellValues.unshift(ancestor.value);
    }
    // The document check handles a sole standard window; retain names for other roots.
    const identity = ancestorIdentity(ancestor, data);
    path.unshift([identity, siblings]);
    rowPath.unshift([identity, rowSiblingContext(boundary, empty, siblings)]);
    identifiedRow ??= uniqueRow(elements[child], rowCounts);
    boundary = nextBoundary(identifiedRow, boundary, ancestor, {
      parent: parents[parent] ?? -1,
      counts: namedCounts,
    });
  }
  const element = elements[i];
  if (element === undefined) {
    return;
  }
  element.context = fingerprint(path);
  // Keep the full context as a fallback if uniqueness changes between observations.
  const rowContext = rowContextHash(identifiedRow, boundary, rowPath);
  if (rowContext !== undefined) {
    element.rowContext = rowContext;
  }
  element.cellValueContext = fingerprint(cellValues);
}

/**
 * @param {ReturnType<typeof parseTree>} parsed
 * @param {ElementState[]} windows
 * @param {boolean} nativeWindowCandidate
 * @returns {void}
 */
function enrichTree(parsed, windows, nativeWindowCandidate) {
  const { elements } = parsed;
  const subtree = subtreeHashes(parsed);
  const empty = fingerprint([]);
  const siblingContexts = siblingHashes(parsed, subtree, empty);
  /** @type {Map<string | false, number>} */
  const rowCounts = new Map();
  /** @type {Map<string | false, number>} */
  const namedCounts = new Map();
  for (const element of elements) {
    for (const key of identityKeys(element)) {
      namedCounts.set(key, (namedCounts.get(key) ?? 0) + 1);
      if (element.role === "row") {
        rowCounts.set(key, (rowCounts.get(key) ?? 0) + 1);
      }
    }
  }
  const data = { windows, nativeWindowCandidate, siblingContexts, empty, rowCounts, namedCounts };
  for (let i = 0; i < elements.length; i++) {
    setElementContext(parsed, data, i);
  }
}

/**
 * @param {string} app
 * @param {string} text
 * @returns {void}
 */
function requireStateStrings(app, text) {
  if (typeof app !== "string" || typeof text !== "string") {
    throw new TypeError("App state requires app and text strings.");
  }
}

/**
 * @param {string} app
 * @param {string} text
 * @returns {AppObservation}
 */
export function parseAppState(app, text) {
  requireStateStrings(app, text);
  const parsed = parseTree(text);
  const { elements, parents, lines, focusLine, ambiguousRoot } = parsed;
  const roots = elements.filter((element, index) => (parents[index] ?? -1) < 0);
  const documents = elements.filter((element) =>
    ["standard window", "window", "sheet", "dialog"].includes(element.role),
  );
  const windows = roots.filter((element) =>
    ["standard window", "window", "sheet"].includes(element.role),
  );
  const nativeWindowCandidate =
    !ambiguousRoot && windows.length === 1 && windows[0]?.role === "standard window";
  enrichTree(parsed, windows, nativeWindowCandidate);
  const { title, url, documentIdentity, nativeWindowIdentity, nativeSheetId } = documentMetadata(
    parsed,
    { windows, roots, documents, nativeWindowCandidate },
  );
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
