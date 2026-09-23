// Native macOS Sky snapshots are text. Keep complete values before any presentation limits.
const rolePattern = /^(standard window|split group|container|scroll area|scroll bar|value indicator|text entry area|secure text field|search text field|text field|edit field|close button|zoom button|minimize button|full screen button|increment arrow button|decrement arrow button|increment page button|decrement page button|radio button|pop up button|sort button|menu button|menu bar|menu item|button|checkbox|switch|slider|splitter|combo box|tab group|tab|link|row|text|toolbar|group|web area|HTML content|search)\b/i;

function parseElement(index, body) {
  const [header, ...lines] = body.split("\n");
  const rawRole = header.match(rolePattern)?.[1] ?? header.split(/\s+/)[0];
  const role = rawRole.toLowerCase().replace(/^search text field$/, "search");
  const rest = header.slice(rawRole.length).trimStart().replace(/^\([^)]*\)\s*/, "");
  const markers = [...rest.matchAll(/(?:^|,\s*)(ID|Description|Help|Secondary Actions|URL|Value|Placeholder):[ \t]?/gi)];
  const fields = new Map(markers.map((marker, i) => {
    const key = marker[1].toLowerCase();
    const value = rest.slice(marker.index + marker[0].length, markers[i + 1]?.index);
    return [key, key === "value" ? value : value.trim()];
  }));
  const label = rest.slice(0, markers[0]?.index).replace(/\s*\(disabled\)\s*$/i, "").trim();
  const inline = body.match(/\((?:disabled,\s*)?(?:settable|editable),\s*(?:string|float|int|integer|bool|boolean)\)[ \t]?([\s\S]*)$/i)
    ?? (role === "search" && fields.size === 0 ? body.match(/\((?:disabled,\s*)?(?:settable|editable)\)[ \t]?([\s\S]*)$/i) : null);
  const value = fields.has("value") ? fields.get("value") + (lines.length ? `\n${lines.join("\n")}` : "")
    : inline?.[1] ?? (role === "text" ? [label, ...lines].join("\n") : undefined);
  const id = fields.get("id");
  const description = fields.get("description") ?? (/^(?:button|pop up button|menu button|sort button|switch|checkbox|radio button|combo box|link)$/.test(role) ? label || undefined : undefined);
  return {
    index, role, name: description || (inline ? "" : label) || id || role,
    ...(id !== undefined ? { id } : {}), ...(description !== undefined ? { description } : {}),
    ...(value !== undefined ? { value } : {}), ...(fields.has("url") ? { url: fields.get("url") } : {}),
    disabled: /\([^)]*\bdisabled\b[^)]*\)/i.test(header),
    settable: /\([^)]*\b(?:settable|editable)\b[^)]*\)/i.test(header),
    secondaryActions: fields.get("secondary actions")?.split(",").map(s => s.trim()).filter(Boolean) ?? [],
    line: `${index} ${body}`,
  };
}

export function parseAppState(app, text) {
  if (typeof app !== "string" || typeof text !== "string") throw new TypeError("App state requires app and text strings.");
  const elements = [];
  const depths = [];
  let current;
  const flush = () => {
    if (current) {
      elements.push(parseElement(current.index, current.lines.join("\n")));
      depths.push(current.depth);
    }
    current = undefined;
  };
  // App-specific instructions and focus summaries are not part of a field value.
  const tree = text.replace(/<app_specific_instructions>[\s\S]*?<\/app_specific_instructions>\s*/g, "");
  for (const line of tree.split("\n")) {
    if (/^\s*(?:<\/?app_state>|Computer Use state|App=|Window:|The focused UI element is|Selected text:|Note:)/.test(line)) {
      flush();
      continue;
    }
    const match = line.match(/^(\t*)(\d+)[ \t]+(.+)$/);
    // Sky indents child rows with tabs; multiline values retain their own whitespace.
    // ponytail: literal text shaped exactly like a native row remains ambiguous without structured upstream state.
    if (match && (line.startsWith("\t") || (!current && elements.length === 0) || /^(standard window|menu bar)\b/i.test(match[3]))) {
      flush();
      current = { index: match[2], depth: match[1].length, lines: [match[3]] };
    } else if (current) current.lines.push(line);
  }
  flush();
  const parents = [], stack = [];
  for (let i = 0; i < elements.length; i++) {
    stack.length = depths[i];
    parents[i] = stack.at(-1) ?? -1;
    stack[depths[i]] = i;
  }
  const identity = element => [element.role, element.id, element.name, element.value, element.url];
  for (let i = 0; i < elements.length; i++) {
    const path = [];
    for (let parent = parents[i]; parent >= 0; parent = parents[parent]) path.unshift(identity(elements[parent]));
    let row = elements[i].role === "row" ? i : parents[i];
    while (row >= 0 && elements[row].role !== "row") row = parents[row];
    const rowDetails = [];
    if (row >= 0) {
      // Keep the item's other fields, but omit the target so setValue can verify its new value.
      for (let j = row + 1; j < elements.length && depths[j] > depths[row]; j++) {
        if (j === i) {
          while (j + 1 < elements.length && depths[j + 1] > depths[i]) j++;
        } else rowDetails.push(identity(elements[j]));
      }
    }
    elements[i].context = JSON.stringify([path, rowDetails]);
  }
  const windows = elements.filter(element => element.role === "standard window");
  const headerTitle = tree.match(/^Window:\s*"(.*)",\s*App:/m)?.[1] ?? null;
  let title = headerTitle;
  if (windows.length === 1) {
    const row = windows[0].line.split("\n")[0].replace(/^\d+\s+standard window\s*/i, "");
    title = row.split(/(?:^|,\s*)(?:ID|Description|Help|Secondary Actions|URL|Value|Placeholder):/i)[0]
      || row.match(/(?:^|, )Secondary Actions: Raise, (.+)$/)?.[1] || headerTitle;
  }
  const pageUrls = [...new Set(elements.filter(e => ["web area", "html content"].includes(e.role)).map(e => e.url).filter(Boolean))];
  let url = windows.length === 1 && windows[0].url || (pageUrls.length === 1 ? pageUrls[0] : null);
  if (url && (!/^[a-z][\w+.-]*:/i.test(url) || /^[^/?#:\s]+:\d+(?:[/?#]|$)/.test(url))) {
    const display = value => value.replace(/^[a-z][\w+.-]*:\/\//i, "").replace(/\/$/, "");
    const addresses = [...new Set(elements.filter(e => /field|search/.test(e.role) && /address|location|omnibox/i.test(e.name))
      .map(e => e.value?.trim()).filter(value => value && /^[a-z][\w+.-]*:\/\//i.test(value) && display(value) === display(url)))];
    if (addresses.length === 1) url = addresses[0];
  }
  const focusedIndex = tree.match(/^The focused UI element is\s+(\d+)\s/m)?.[1];
  const focused = elements.find(e => e.index === focusedIndex);
  return { app, title, url, text, elements, ...(focused ? { focused } : {}), observedAt: Date.now() };
}

export function sameDocument(before, after) {
  return before.app === after.app && Boolean(before.title || before.url)
    && before.title === after.title && before.url === after.url;
}

// A unique stable identity may survive index changes. Never fall back from a missing ID.
export function findSameElement(element, observation) {
  const candidates = observation.elements.filter(other => {
    if (element.id) return other.id === element.id && other.role === element.role;
    if (element.description) return other.description === element.description && other.role === element.role;
    return other.role === element.role && other.name === element.name;
  });
  if (candidates.length === 1 && candidates[0].context === element.context) return candidates[0];
  // Duplicate identities cannot safely be re-resolved, even if one retained its index.
  return undefined;
}
