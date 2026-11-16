import { documentMetadata } from "./app-state-document.mjs";
import { enrichTree } from "./app-state-context.mjs";

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
  /^(standard window|split group|container|scroll area|scroll bar|value indicator|text entry area|secure text field|search text field|text field|edit field|close button|zoom button|minimize button|full screen button|increment arrow button|decrement arrow button|increment page button|decrement page button|radio button|pop up button|sort button|menu button|menu bar|menu item|menu|button|checkbox|switch|slider|splitter|combo box|tab group|tab|link|row|text|toolbar|group|web area|HTML content|search)\b/i;

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
  return ["menu bar", "menu", "menu item"].includes(element?.role ?? "");
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
 * Parse structural windows/roots metadata needed to enrich element contexts.
 * @param {string} text
 */
function parseTreeContext(text) {
  const parsed = parseTree(text);
  const { elements, parents, ambiguousRoot } = parsed;
  const roots = elements.filter((element, index) => (parents[index] ?? -1) < 0);
  const documents = elements.filter((element) =>
    ["standard window", "window", "sheet", "dialog"].includes(element.role),
  );
  const windows = roots.filter((element) =>
    ["standard window", "window", "sheet"].includes(element.role),
  );
  const nativeWindowCandidate =
    !ambiguousRoot && windows.length === 1 && windows[0]?.role === "standard window";
  return { parsed, roots, documents, windows, nativeWindowCandidate };
}

/**
 * Recompute context hashes for a tree with specific element indices masked by stable slot IDs.
 * @param {string} text
 * @param {ReadonlyMap<number, number>} maskedSlots
 * @returns {{ context: string, rowContext?: string }[]}
 */
export function parseMaskedContexts(text, maskedSlots) {
  const { parsed, windows, nativeWindowCandidate } = parseTreeContext(text);
  enrichTree(parsed, windows, nativeWindowCandidate, maskedSlots);
  return parsed.elements.map((element) =>
    element.rowContext === undefined
      ? { context: element.context ?? "" }
      : { context: element.context ?? "", rowContext: element.rowContext },
  );
}

/**
 * @param {string} app
 * @param {string} text
 * @returns {AppObservation}
 */
export function parseAppState(app, text) {
  requireStateStrings(app, text);
  const { parsed, roots, documents, windows, nativeWindowCandidate } = parseTreeContext(text);
  const { elements, lines, focusLine } = parsed;
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
