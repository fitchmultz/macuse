import {
	DEFAULT_MAX_TEXT_CHARS,
	READ_ONLY_TOOLS,
	errorMessage,
	stripInvisibleBidiMarks,
	truncateString,
	type ChangeSummary,
	type ContentBlock,
	type DetailMode,
	type ElementInfo,
	type FilteredToolResult,
	type JsonValue,
	type MachineElement,
	type StateSummary,
	type TargetScope,
} from "./core";
import { isTextBlock, normalizeContent } from "./content";

export function hasMutatingSteps(steps: Array<{ tool: string }>): boolean {
	return steps.some((step) => !READ_ONLY_TOOLS.has(step.tool));
}

export function contentText(content: ContentBlock[] | undefined): string {
	return normalizeContent(content)
		.filter(isTextBlock)
		.map((block) => block.text)
		.join("\n");
}

export function normalizeRole(value: string): string {
	const normalized = value.toLowerCase().replace(/[\s_-]+/g, " ").trim();
	if (normalized === "textbox" || normalized === "text box" || normalized === "input") return "text field";
	if (normalized === "secure textbox" || normalized === "password") return "secure text field";
	if (normalized === "search field" || normalized === "search text field" || normalized === "searchfield") return "search";
	return normalized;
}

export function parseElementRole(body: string): string {
	const match = body.match(/^(standard window|split group|container|scroll area|text entry area|secure text field|search text field|text field|edit field|close button|zoom button|minimize button|radio button|pop up button|menu bar|menu item|button|checkbox|switch|slider|splitter|combo box|tab|link|row|text|toolbar|group|web area|search)\b/i);
	return normalizeRole(match?.[1] ?? body.split(/\s+/)[0] ?? "unknown");
}

export function roleMatches(actual: string, expected: string): boolean {
	const wanted = normalizeRole(expected);
	const got = normalizeRole(actual);
	if (wanted === got) return true;
	if (wanted === "text field") return ["text field", "edit field", "text entry area", "secure text field", "scroll area", "search"].includes(got);
	if (wanted === "search") return ["search", "search text field"].includes(got);
	return false;
}

export function settableFieldValue(body: string): string | undefined {
	const valueMatch = body.match(/(?:^|,\s*)Value:\s*([\s\S]+)$/i);
	if (valueMatch?.[1]) return valueMatch[1].trim();
	const settableMatch = body.match(/\((?:settable|editable),\s*string\)\s+([\s\S]+)$/i);
	return settableMatch?.[1]?.trim();
}

export function stableFieldName(value: string): string {
	return value.replace(/(\((?:settable|editable),\s*string\))\s+[\s\S]+$/i, "$1").trim();
}

export function stripElementAttributes(value: string): string {
	return value.replace(/^\([^)]*\)\s*/, "").replace(/^Description:\s*/i, "").replace(/\s*\(disabled\)\s*$/i, "").trim();
}

export function rolePrefixPattern(role: string): RegExp {
	const escaped = role.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	if (role === "search") return /^(?:search(?:\s+text\s+field)?|text\s+field)\s*/i;
	return new RegExp(`^${escaped}\\s*`, "i");
}

export function parseElementName(body: string, role: string, id?: string, description?: string): string {
	if (description) return description;
	const withoutRole = body.replace(rolePrefixPattern(role), "").trim();
	const beforeComma = withoutRole.split(/,\s*(?:ID:|Help:|Secondary Actions:|URL:|Value:|Placeholder:)/)[0]?.trim() ?? "";
	const textFieldLike = ["text field", "search", "edit field", "text entry area", "secure text field"].includes(role);
	const cleaned = textFieldLike ? stableFieldName(stripElementAttributes(beforeComma)) : stripElementAttributes(beforeComma);
	return cleaned || id || role;
}

export function elementTags(line: string, role: string, name: string, description?: string): string[] {
	const haystack = `${line} ${role} ${name} ${description ?? ""}`.toLowerCase();
	const tags = new Set<string>();
	if (/\bsettable\b|\beditable\b/.test(haystack)) tags.add("settable-field");
	if (role === "search" || /\bsearch\b/.test(haystack)) tags.add("search-field");
	if (/\b(address|location|url|omnibox|address and search bar)\b/.test(haystack)) tags.add("navigation-field");
	if (/\b(quickevent|quick event|popover|transient|draft event|new event|event editor)\b/.test(haystack)) tags.add("transient-editor");
	if (/\b(cancel|clear)\b/.test(haystack)) tags.add("clear-control");
	if (/\b(delete|erase|remove|trash|force quit|quit process|stop process|kill|sign out|log out|password|privacy|security|payment|purchase|send|submit)\b/.test(haystack)) tags.add("risk-sensitive-control");
	return [...tags];
}

export function elementGroup(line: string, role: string): ElementInfo["group"] {
	if (/\b(?:standard window|close button|zoom button|minimize button)\b/i.test(line)) return "window";
	if (/\b(?:menu bar|toolbar)\b/i.test(line)) return "chrome";
	if (/\b(?:tab group|tab|address|bookmark|extension|sidebar|show sidebar|mode:)\b/i.test(line)) return "chrome";
	if (/\b(?:Back|Forward|Reload|Home|Bookmark this tab|View site information|Share this page|Brave Shields|Brave Rewards|Extensions|Tab Search|Control your music|Address and search bar)\b/i.test(line)) return "chrome";
	if (["button", "pop up button", "search", "text field", "edit field", "text entry area", "secure text field", "checkbox", "switch", "radio button", "slider", "splitter", "combo box", "link", "row", "text", "scroll area"].includes(role)) return "content";
	return "other";
}

export function elementBlocks(text: string): string[] {
	const blocks: string[] = [];
	let current: string[] = [];
	for (const rawLine of text.split("\n")) {
		if (/^\s*\d+\s+/.test(rawLine)) {
			if (current.length > 0) blocks.push(current.join("\n"));
			current = [rawLine];
		} else if (current.length > 0 && /\b(?:Value:|\((?:settable|editable),\s*string\))/.test(current[0] ?? "") && rawLine.trim() && !/^\s*<\/?\w+/.test(rawLine) && !/^\s*(?:App=|Window:|Visible text:|Targets:|Target groups:|Focus summary:|Warning:|Target element|Valid secondary actions:|Hints:|waitFor\w+ matched|set_value |requireStateChange |Sequence )/.test(rawLine)) {
			current.push(rawLine);
		}
	}
	if (current.length > 0) blocks.push(current.join("\n"));
	return blocks;
}

export function parseElementInfo(text: string): ElementInfo[] {
	const elements: ElementInfo[] = [];
	for (const rawLine of elementBlocks(text)) {
		const match = rawLine.match(/^\s*(\d+)\s+([\s\S]+)$/);
		if (!match) continue;
		const line = match[0].trim();
		const body = stripInvisibleBidiMarks(match[2] ?? "");
		const id = line.match(/(?:^|[\s,])ID:\s*([^,\n]+)/)?.[1]?.trim();
		const explicitDescription = line.match(/Description:\s*([^,\n]+)/)?.[1]?.trim();
		const role = parseElementRole(body);
		const controlLabel = ["button", "pop up button", "switch", "checkbox", "radio button", "combo box", "link"].includes(role) ? stripElementAttributes(body.replace(rolePrefixPattern(role), "").split(/,\s*(?:ID:|Help:|Secondary Actions:|URL:|Value:|Placeholder:)/)[0]?.trim() ?? "") : "";
		const description = explicitDescription ?? (controlLabel && !controlLabel.startsWith("Description:") ? stripInvisibleBidiMarks(controlLabel) : undefined);
		const value = role === "text" ? body.replace(/^text\s+/i, "").trim() : settableFieldValue(body);
		const name = parseElementName(body, role, id, description);
		const secondaryActions = line.match(/Secondary Actions:\s*([^\n]+)/)?.[1]
			?.split(",")
			.map((item) => item.trim())
			.filter(Boolean) ?? [];
		const disabled = /\bdisabled\b|\(disabled\)/i.test(line);
		const tags = elementTags(line, role, name, description);
		elements.push({ index: match[1], id, description, role, name, value, disabled, tags, group: elementGroup(line, role), line, secondaryActions });
	}
	return elements;
}

export function isInteractiveElement(element: ElementInfo): boolean {
	return Boolean(element.id) ||
		element.secondaryActions.length > 0 ||
		/\b(button|search|text entry area|text field|edit field|field|menu|menu item|row|checkbox|radio|slider|scroll area|combo box|tab|link)\b/i.test(element.line) ||
		/\btext\s+‎/.test(element.line);
}

export function elementTargetHint(element: ElementInfo): string {
	if (element.id) return `target: { elementId: ${JSON.stringify(element.id)} }`;
	if (element.description) return `target: { elementDescription: ${JSON.stringify(element.description)} }`;
	if (element.name && element.role) return `target: { role: ${JSON.stringify(element.role)}, name: ${JSON.stringify(element.name)} }`;
	return `fallback: { element_index: ${JSON.stringify(element.index)} }`;
}

export function elementLineWithTargetHint(element: ElementInfo): string {
	const tags = element.tags.length > 0 ? ` tags=${element.tags.join(",")}` : "";
	const value = element.value ? ` value=${JSON.stringify(element.value)}` : "";
	return `${stripInvisibleBidiMarks(element.line)}${value}${tags} — ${elementTargetHint(element)}`;
}

export function shortElementLabel(element: ElementInfo): string {
	const raw = element.name || element.description || element.id || stripInvisibleBidiMarks(element.line.replace(/^\d+\s+/, ""));
	return truncateString(raw.replace(/,\s*Help:.*$/, ""), 80);
}

export function rankElement(element: ElementInfo): number {
	let score = 0;
	if (element.group === "content") score -= 100;
	if (element.group === "chrome") score += 80;
	if (element.group === "window") score += 120;
	if (element.tags.includes("transient-editor")) score -= 90;
	if (element.tags.includes("search-field")) score -= 60;
	if (element.tags.includes("settable-field")) score -= 45;
	if (element.tags.includes("risk-sensitive-control")) score += 60;
	if (element.id) score -= 15;
	if (element.description || element.name) score -= 10;
	if (element.disabled) score += 20;
	return score + Number(element.index);
}

export function prioritizedElements(elements: ElementInfo[], scope: TargetScope = "all"): ElementInfo[] {
	return elements
		.filter((element) => scope === "all" || element.group === "content")
		.sort((a, b) => rankElement(a) - rankElement(b));
}

export function riskControlNote(text: string): string | null {
	const risky = parseElementInfo(text).filter((element) => element.tags.includes("risk-sensitive-control"));
	if (risky.length === 0) return null;
	return `Risk-sensitive controls visible: ${risky.slice(0, 6).map((element) => `${element.index}:${shortElementLabel(element)}`).join(", ")}${risky.length > 6 ? `, …${risky.length - 6} more` : ""}. Stop before pressing these unless explicitly approved.`;
}

export function elementStabilityNote(text: string): string | null {
	const interactive = parseElementInfo(text).filter(isInteractiveElement);
	if (interactive.length === 0) return null;
	const withIds = interactive.filter((element) => Boolean(element.id)).length;
	const withDescriptions = interactive.filter((element) => !element.id && Boolean(element.description)).length;
	const roleNameCounts = new Map<string, number>();
	for (const element of interactive) roleNameCounts.set(`${element.role}\u0000${element.name}`, (roleNameCounts.get(`${element.role}\u0000${element.name}`) ?? 0) + 1);
	const uniqueRoleName = interactive.filter((element) => !element.id && !element.description && (roleNameCounts.get(`${element.role}\u0000${element.name}`) ?? 0) === 1).length;
	const rawIndexOnly = interactive.length - withIds - withDescriptions - uniqueRoleName;
	const idCounts = new Map<string, ElementInfo[]>();
	const roleNameElements = new Map<string, ElementInfo[]>();
	for (const element of interactive) {
		if (element.id) idCounts.set(element.id, [...(idCounts.get(element.id) ?? []), element]);
		if (element.role && element.name) roleNameElements.set(`${element.role}\u0000${element.name}`, [...(roleNameElements.get(`${element.role}\u0000${element.name}`) ?? []), element]);
	}
	const duplicateIds = [...idCounts.entries()].filter(([, elements]) => elements.length > 1).slice(0, 3).map(([id, elements]) => `${JSON.stringify(id)} at indexes ${elements.map((element) => element.index).join("/")}`);
	const duplicateRoleNames = [...roleNameElements.entries()].filter(([, elements]) => elements.length > 1 && !elements.some((element) => element.id || element.description)).slice(0, 3).map(([key, elements]) => {
		const [role, name] = key.split("\u0000");
		return `${role}/${JSON.stringify(name)} at indexes ${elements.map((element) => element.index).join("/")}`;
	});
	if (rawIndexOnly === 0 && withIds === interactive.length && duplicateIds.length === 0) return null;
	return `Target stability: ${interactive.length} interactive elements; elementId=${withIds}; elementDescription=${withDescriptions}; unique role/name=${uniqueRoleName}; raw index only=${rawIndexOnly}${duplicateIds.length ? `; duplicate elementId: ${duplicateIds.join(", ")}` : ""}${duplicateRoleNames.length ? `; duplicate role/name: ${duplicateRoleNames.join(", ")}` : ""}. Prefer elementId, then elementDescription, then unique role/name or press_key/type_text; use element_index with expectedRole/expectedName guards after mutations. When IDs/names are duplicated, use the shown indexes with stale-target guards after a fresh state read.`;
}

export function compactText(text: string, scope: TargetScope = "all"): string {
	const lines = text.split("\n");
	const header = lines.filter((line) => /^(Computer Use state|<app_state>|App=|Window:)/.test(line.trim())).slice(0, 4);
	const interactive = prioritizedElements(parseElementInfo(text).filter(isInteractiveElement), scope);
	const note = elementStabilityNote(text);
	const riskNote = riskControlNote(text);
	const groups = ["content", "chrome", "window", "other"] as const;
	const body: string[] = [];
	for (const group of groups) {
		const groupElements = interactive.filter((element) => element.group === group);
		if (groupElements.length === 0) continue;
		body.push(`${group[0].toUpperCase()}${group.slice(1)} targets:`);
		body.push(...groupElements.slice(0, group === "content" ? 40 : 12).map(elementLineWithTargetHint));
		if (groupElements.length > (group === "content" ? 40 : 12)) body.push(`…${groupElements.length - (group === "content" ? 40 : 12)} more ${group} targets omitted`);
	}
	return [...header, ...body, ...(riskNote ? [riskNote] : []), ...(note ? [note] : [])].join("\n") || truncateString(stripInvisibleBidiMarks(text), DEFAULT_MAX_TEXT_CHARS);
}

export function minimalText(text: string, scope: TargetScope = "all"): string {
	const lines = text.split("\n");
	const header = lines.filter((line) => /^(Computer Use state|App=|Window:)/.test(line.trim())).slice(0, 3);
	const elements = parseElementInfo(text);
	const visibleText = elements
		.filter((element) => /\btext\b/i.test(element.line))
		.slice(0, 8)
		.map((element) => `${element.index} ${stripInvisibleBidiMarks(element.line.replace(/^\d+\s+/, ""))}${element.value ? ` value=${JSON.stringify(element.value)}` : ""}${element.tags.length > 0 ? ` tags=${element.tags.join(",")}` : ""}`);
	const ranked = prioritizedElements(elements.filter(isInteractiveElement), scope);
	const targets = ranked
		.filter((element) => element.group !== "window")
		.slice(0, 24)
		.map((element) => `${element.index} ${shortElementLabel(element)} [${element.role}${element.disabled ? ", disabled" : ""}${element.tags.length > 0 ? `; tags=${element.tags.join(",")}` : ""}${element.value ? `; value=${JSON.stringify(element.value)}` : ""}] — ${elementTargetHint(element)}`);
	const omittedByGroup = ["content", "chrome", "window", "other"]
		.map((group) => ({ group, count: ranked.filter((element) => element.group === group).length }))
		.filter((item) => item.count > 0)
		.map((item) => `${item.group}:${item.count}`)
		.join(", ");
	const note = elementStabilityNote(text);
	const riskNote = riskControlNote(text);
	const sections = [...header];
	if (visibleText.length > 0) sections.push("Visible text:", ...visibleText);
	if (targets.length > 0) sections.push("Targets:", ...targets);
	if (omittedByGroup) sections.push(`Target groups: ${omittedByGroup}`);
	if (riskNote) sections.push(riskNote);
	if (note) sections.push(note);
	return sections.join("\n") || truncateString(stripInvisibleBidiMarks(text), DEFAULT_MAX_TEXT_CHARS);
}

export function compactContent(content: ContentBlock[], scope: TargetScope = "all"): ContentBlock[] {
	return content.map((block) => {
		if (isTextBlock(block)) return { ...block, text: compactText(block.text, scope) };
		return block;
	});
}

export function minimalContent(content: ContentBlock[], scope: TargetScope = "all"): ContentBlock[] {
	return content.map((block) => {
		if (isTextBlock(block)) return { ...block, text: minimalText(block.text, scope) };
		return block;
	});
}

export function truncateTextContent(content: ContentBlock[], maxTextChars: number): ContentBlock[] {
	return content.map((block) => {
		if (isTextBlock(block)) return { ...block, text: truncateString(block.text, maxTextChars) };
		return block;
	});
}

export function appendElementStabilityNote(result: FilteredToolResult): void {
	const note = elementStabilityNote(contentText(result.content));
	if (note) appendText(result, note);
}

export function normalizeDetail(value: unknown, fallback: DetailMode): DetailMode {
	if (value === undefined || value === null) return fallback;
	if (value === "compact" || value === "full" || value === "minimal") return value;
	throw new Error('detail must be "compact", "full", or "minimal".');
}

export function normalizeAssertionText(value: string): string {
	return stripInvisibleBidiMarks(value).normalize("NFC");
}

export function assertionContentText(content: ContentBlock[] | undefined): string {
	const values = new Set<string>();
	for (const element of parseElementInfo(contentText(content))) {
		values.add(element.line);
		for (const value of [element.id, element.description, element.name, element.value]) {
			if (value) values.add(value);
		}
	}
	return [...values].join("\n");
}

export function contentIncludesMultilineValue(content: ContentBlock[] | undefined, expectedValue: string): { matched: boolean; partial: boolean; matchedLines: string[]; missingLines: string[] } {
	const normalizedContent = normalizeAssertionText(contentText(content));
	const normalizedExpected = normalizeAssertionText(expectedValue);
	if (normalizedContent.includes(normalizedExpected)) return { matched: true, partial: false, matchedLines: [expectedValue], missingLines: [] };
	const lines = normalizedExpected.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
	if (lines.length <= 1) return { matched: false, partial: false, matchedLines: [], missingLines: lines };
	const matchedLines = lines.filter((line) => normalizedContent.includes(line));
	const missingLines = lines.filter((line) => !normalizedContent.includes(line));
	return { matched: missingLines.length === 0, partial: matchedLines.length > 0, matchedLines, missingLines };
}

export function visibleTextValues(content: ContentBlock[]): string[] {
	const values: string[] = [];
	for (const element of parseElementInfo(contentText(content))) {
		if (/\btext\b/i.test(element.line)) values.push(element.line.replace(/^\s*\d+\s+text\s+/, "").trim());
		if (element.value && /\b(text|field|search|edit|scroll area)\b/i.test(element.role)) values.push(element.value);
	}
	return values
		.flatMap((value) => normalizeAssertionText(value).split(/\r?\n/))
		.map((value) => value.trim())
		.filter(Boolean);
}

export function visibleAssertionValues(content: ContentBlock[]): string[] {
	const text = contentText(content);
	const values = new Set<string>(visibleTextValues(content));
	const windowTitle = text.match(/^Window:\s*"([^"]+)"/m)?.[1]?.trim();
	if (windowTitle) values.add(normalizeAssertionText(windowTitle));
	for (const element of parseElementInfo(text)) {
		if (["button", "pop up button", "switch", "checkbox", "radio button", "combo box", "link", "row", "search", "text field", "edit field", "text entry area", "secure text field", "scroll area", "container", "group", "split group"].includes(element.role)) {
			for (const value of [element.name, element.description, element.value]) {
				if (!value) continue;
				for (const line of normalizeAssertionText(value).split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) values.add(line);
			}
		}
	}
	return [...values];
}

export function machineElements(content: ContentBlock[], scope: TargetScope = "all"): MachineElement[] {
	return prioritizedElements(parseElementInfo(contentText(content)), scope).map((element) => ({
		index: element.index,
		...(element.id ? { id: element.id } : {}),
		...(element.description ? { description: element.description } : {}),
		role: element.role,
		name: element.name,
		...(element.value ? { value: element.value } : {}),
		disabled: element.disabled,
		group: element.group,
		tags: element.tags,
		secondaryActions: element.secondaryActions,
		targetHint: elementTargetHint(element),
		line: stripInvisibleBidiMarks(element.line),
	}));
}

export function hasStateSummaryContent(content: ContentBlock[]): boolean {
	const text = contentText(content);
	return /^App=/m.test(text) || /^Window:\s*/m.test(text) || /<app_state>/.test(text);
}

export function stateSummary(content: ContentBlock[], scope: TargetScope = "all"): StateSummary {
	const text = contentText(content);
	const app = text.match(/^App=([^\n]+)/m)?.[1]?.trim() ?? null;
	const windowLine = text.match(/^Window:\s*([^\n]+)/m)?.[1]?.trim() ?? null;
	const title = windowLine?.match(/^"([^"]+)"/)?.[1] ?? null;
	const url = text.match(/\b(?:https?|file|brave|chrome|about):\/\/[^\s"'<>]+|\babout:[^\s"'<>]+/)?.[0] ?? null;
	return {
		app,
		window: windowLine,
		title,
		url,
		visibleText: visibleTextValues(content),
		targets: machineElements(content, scope),
	};
}

export function diffLists(before: string[], after: string[], limit = 8): { added: string[]; removed: string[] } {
	const beforeSet = new Set(before);
	const afterSet = new Set(after);
	return {
		added: after.filter((item) => !beforeSet.has(item)).slice(0, limit),
		removed: before.filter((item) => !afterSet.has(item)).slice(0, limit),
	};
}

export function compareState(before: StateSummary | null, after: StateSummary | null): ChangeSummary | null {
	if (!before || !after) return null;
	const visible = diffLists(before.visibleText, after.visibleText);
	const targetState = (target: MachineElement) => `${target.role}:${target.name}:${target.value ?? ""}:${target.disabled ? "disabled" : "enabled"}`;
	const beforeTargets = before.targets.map(targetState);
	const afterTargets = after.targets.map(targetState);
	const targets = diffLists(beforeTargets, afterTargets, 6);
	const titleChanged = before.title !== after.title;
	const urlChanged = before.url !== after.url;
	const summary: string[] = [];
	if (urlChanged) summary.push(`URL changed ${before.url ?? "<none>"} → ${after.url ?? "<none>"}`);
	if (titleChanged) summary.push(`title changed ${before.title ?? "<none>"} → ${after.title ?? "<none>"}`);
	if (visible.added.length || visible.removed.length) summary.push(`visible text changed${visible.added.length ? `; added ${JSON.stringify(visible.added.join(" | "))}` : ""}${visible.removed.length ? `; removed ${JSON.stringify(visible.removed.join(" | "))}` : ""}`);
	if (targets.added.length || targets.removed.length) summary.push(`targets changed${targets.added.length ? `; added ${targets.added.length}` : ""}${targets.removed.length ? `; removed ${targets.removed.length}` : ""}`);
	return {
		visibleTextChanged: visible.added.length > 0 || visible.removed.length > 0,
		addedVisibleText: visible.added,
		removedVisibleText: visible.removed,
		targetsAdded: targets.added,
		targetsRemoved: targets.removed,
		titleChanged,
		urlChanged,
		summary,
	};
}

export function observedStateChange(change: ChangeSummary | null): boolean {
	return Boolean(change && (change.visibleTextChanged || change.titleChanged || change.urlChanged || change.targetsAdded.length > 0 || change.targetsRemoved.length > 0));
}

export function targetStateChanged(before: StateSummary | null, after: StateSummary | null, args: Record<string, JsonValue>): boolean {
	if (!before || !after) return false;
	const beforeTarget = before.targets.find((target) => target.index === args.element_index);
	if (!beforeTarget) return false;
	const afterCandidates = after.targets.filter((target) => {
		if (beforeTarget.id && target.id === beforeTarget.id) return true;
		if (beforeTarget.description && target.description === beforeTarget.description) return true;
		if (target.role === beforeTarget.role && target.name === beforeTarget.name) return true;
		if (beforeTarget.role === "search" && target.role === "search") return true;
		return false;
	});
	if (afterCandidates.length !== 1) return false;
	const afterTarget = afterCandidates[0];
	return beforeTarget.value !== afterTarget.value || beforeTarget.disabled !== afterTarget.disabled || beforeTarget.name !== afterTarget.name;
}

const PRESS_KEY_ALIASES = new Map<string, string>([
	["cmd", "super"],
	["command", "super"],
	["meta", "super"],
	["control", "ctrl"],
	["option", "alt"],
	["esc", "Escape"],
	["escape", "Escape"],
	["return", "Return"],
	["enter", "Return"],
	["tab", "Tab"],
	["space", "space"],
	["comma", "comma"],
	[",", "comma"],
	["period", "period"],
	[".", "period"],
]);

const PRESS_KEY_MODIFIERS = new Set(["super", "ctrl", "alt", "shift"]);

function normalizePressKeyPart(value: string): string {
	const part = value.trim();
	return PRESS_KEY_ALIASES.get(part.toLowerCase()) ?? part;
}

function normalizePressKeyModifiers(value: JsonValue | undefined): string[] {
	if (value === undefined) return [];
	const raw = typeof value === "string" ? [value] : value;
	if (!Array.isArray(raw) || !raw.every((item) => typeof item === "string")) throw new Error("press_key modifiers must be a string or array of strings.");
	return raw.map(normalizePressKeyPart);
}

export function normalizePressKeyValue(value: string, modifiers?: JsonValue): string {
	const parts = [...normalizePressKeyModifiers(modifiers), ...value.split("+").map(normalizePressKeyPart)].filter(Boolean);
	const seenModifiers = new Set<string>();
	return parts.filter((part) => {
		const normalized = part.toLowerCase();
		if (!PRESS_KEY_MODIFIERS.has(normalized)) return true;
		if (seenModifiers.has(normalized)) return false;
		seenModifiers.add(normalized);
		return true;
	}).join("+");
}

export function normalizeToolArguments(args: Record<string, JsonValue>): Record<string, JsonValue> {
	const normalized: Record<string, JsonValue> = { ...args };
	if (normalized.element_index === undefined && normalized.element !== undefined) {
		normalized.element_index = normalized.element;
		delete normalized.element;
	}
	if (normalized.element_index !== undefined && normalized.element_index !== null) normalized.element_index = String(normalized.element_index);
	if (typeof normalized.key === "string") {
		normalized.key = normalizePressKeyValue(normalized.key, normalized.modifiers);
		delete normalized.modifiers;
	}
	return normalized;
}

export function hasElementTarget(args: Record<string, JsonValue>): boolean {
	return args.element_index !== undefined ||
		args.element !== undefined ||
		typeof args.elementId === "string" ||
		typeof args.element_id === "string" ||
		typeof args.elementDescription === "string" ||
		typeof args.element_description === "string" ||
		typeof args.role === "string" ||
		typeof args.elementRole === "string" ||
		typeof args.name === "string" ||
		typeof args.elementName === "string";
}

export function isJsonRecord(value: JsonValue): value is Record<string, JsonValue> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function withoutTargets(args: Record<string, JsonValue>): Record<string, JsonValue> {
	const normalized = { ...args };
	delete normalized.targets;
	return normalized;
}

export function selectorFromTarget(target: Record<string, JsonValue>): Record<string, JsonValue> {
	const selector: Record<string, JsonValue> = {};
	for (const key of ["element_index", "element", "elementId", "element_id", "elementDescription", "element_description", "role", "elementRole", "name", "elementName", "expectedRole", "expectedName", "expectedDescription", "expectedId", "expectedValue"] as const) {
		if (target[key] !== undefined) selector[key] = target[key];
	}
	return selector;
}

export function elementSummary(elements: ElementInfo[], limit = 40): string {
	if (elements.length === 0) return "No cached elements for this app.";
	const shown = elements.slice(0, limit).map(elementLineWithTargetHint).join("\n");
	const remaining = elements.length > limit ? `\n…${elements.length - limit} more elements omitted` : "";
	return `${shown}${remaining}`;
}

export function actionableElementSummary(elements: ElementInfo[], limit = 12): string {
	const actionable = elements.filter((element) => !/\b(?:standard window|menu bar|close button|zoom button|minimize button)\b/i.test(element.line));
	return elementSummary(actionable, limit);
}

export function conciseTargetFailure(message: string): string {
	return message.split("\nAvailable targets:\n")[0]?.split("\nAvailable elements:\n")[0] ?? message;
}

export function editDistance(a: string, b: string): number {
	const aa = a.toLowerCase();
	const bb = b.toLowerCase();
	const previous = Array.from({ length: bb.length + 1 }, (_, index) => index);
	for (let i = 1; i <= aa.length; i += 1) {
		let last = previous[0];
		previous[0] = i;
		for (let j = 1; j <= bb.length; j += 1) {
			const old = previous[j];
			previous[j] = aa[i - 1] === bb[j - 1]
				? last
				: Math.min(previous[j - 1], previous[j], last) + 1;
			last = old;
		}
	}
	return previous[bb.length] ?? 0;
}

export function semanticSuggestionScore(element: ElementInfo, requested: string, candidateValue: string): number {
	const query = requested.toLowerCase().replace(/[^a-z0-9]+/g, "");
	const label = [element.id, element.description, element.name, element.value, ...element.tags]
		.filter((item): item is string => typeof item === "string")
		.join(" ")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "");
	let score = editDistance(requested, candidateValue) * 10 + rankElement(element);
	if (label && (query.includes(label) || label.includes(query))) score -= 250;
	if ((query.includes("clear") || query.includes("allclear")) && element.tags.includes("clear-control")) score -= 500;
	if ((query.includes("delete") || query.includes("remove")) && element.tags.includes("risk-sensitive-control")) score -= 250;
	return score;
}

export function closestElementSuggestions(elements: ElementInfo[], value: string, field: "id" | "description" | "name", limit = 3): string {
	const candidates = elements
		.map((element) => ({ element, value: element[field] }))
		.filter((candidate): candidate is { element: ElementInfo; value: string } => typeof candidate.value === "string" && candidate.value.length > 0)
		.map((candidate) => ({ ...candidate, score: semanticSuggestionScore(candidate.element, value, candidate.value) }))
		.sort((a, b) => a.score - b.score)
		.slice(0, limit);
	if (candidates.length === 0) return "";
	return candidates.map((candidate) => `${candidate.value} (${elementTargetHint(candidate.element)})`).join(", ");
}

export function resolveElementId(args: Record<string, JsonValue>, cache: Map<string, ElementInfo[]>): Record<string, JsonValue> {
	const normalized = normalizeToolArguments(args);
	const elementId = normalized.elementId ?? normalized.element_id;
	if (typeof elementId !== "string" || normalized.element_index !== undefined) return normalized;
	if (typeof normalized.app !== "string") throw new Error("elementId targeting requires an app argument.");
	const elements = cache.get(normalized.app) ?? [];
	const match = elements.find((element) => element.id === elementId);
	if (!match) {
		const closest = closestElementSuggestions(elements, elementId, "id");
		throw new Error(`No elementId ${elementId} found for ${normalized.app}.${closest ? `\nClosest elementId matches: ${closest}.` : ""}\nAvailable targets:\n${actionableElementSummary(elements)}`);
	}
	normalized.element_index = match.index;
	delete normalized.elementId;
	delete normalized.element_id;
	return normalized;
}

export function resolveElementRoleName(args: Record<string, JsonValue>, cache: Map<string, ElementInfo[]>): Record<string, JsonValue> {
	const normalized = normalizeToolArguments(args);
	if (normalized.element_index !== undefined) return normalized;
	const rawRole = normalized.role ?? normalized.elementRole;
	const rawName = normalized.name ?? normalized.elementName;
	if (typeof rawRole !== "string" && typeof rawName !== "string") return normalized;
	if (typeof normalized.app !== "string") throw new Error("role/name targeting requires an app argument.");
	const elements = cache.get(normalized.app) ?? [];
	const roleFiltered = elements.filter((element) => typeof rawRole !== "string" || roleMatches(element.role, rawRole));
	let matches = roleFiltered.filter((element) => {
		if (typeof rawName !== "string") return true;
		const expected = normalizeAssertionText(rawName).toLowerCase();
		const names = [element.name, element.description, element.id, element.value].filter((item): item is string => typeof item === "string");
		return names.some((name) => normalizeAssertionText(name).toLowerCase() === expected);
	});
	if (matches.length === 0 && typeof rawName === "string") {
		const expected = normalizeAssertionText(rawName).toLowerCase();
		matches = roleFiltered.filter((element) => {
			if (!element.tags.includes("settable-field") && element.role !== "search") return false;
			const names = [element.name, element.description, element.id].filter((item): item is string => typeof item === "string");
			return names.some((name) => {
				const normalizedName = normalizeAssertionText(name).toLowerCase();
				return normalizedName.startsWith(expected) || expected.startsWith(normalizedName);
			});
		});
		if (matches.length === 0 && normalizeRole(String(rawRole ?? "")) === "search" && expected === "search") {
			matches = roleFiltered.filter((element) => element.role === "search" || element.tags.includes("search-field"));
		}
	}
	if (matches.length !== 1) {
		const reason = matches.length === 0 ? "No" : `Ambiguous ${matches.length}`;
		const closest = typeof rawName === "string" ? closestElementSuggestions(elements, rawName, "name") : "";
		throw new Error(`${reason} role/name target found for ${normalized.app}. Match is exact first, then prefix-compatible for one settable/search field.${closest ? `\nClosest name matches: ${closest}.` : ""}\nAvailable targets:\n${actionableElementSummary(elements)}`);
	}
	normalized.element_index = matches[0].index;
	delete normalized.role;
	delete normalized.elementRole;
	delete normalized.name;
	delete normalized.elementName;
	return normalized;
}

export function resolveElementDescription(args: Record<string, JsonValue>, cache: Map<string, ElementInfo[]>): Record<string, JsonValue> {
	const normalized = normalizeToolArguments(args);
	const elementDescription = normalized.elementDescription ?? normalized.element_description;
	if (typeof elementDescription !== "string" || normalized.element_index !== undefined) return normalized;
	if (typeof normalized.app !== "string") throw new Error("elementDescription targeting requires an app argument.");
	const elements = cache.get(normalized.app) ?? [];
	const matches = elements.filter((element) => element.description?.toLowerCase() === elementDescription.toLowerCase());
	if (matches.length !== 1) {
		const reason = matches.length === 0 ? "No" : `Ambiguous ${matches.length}`;
		const closest = closestElementSuggestions(elements, elementDescription, "description");
		throw new Error(`${reason} elementDescription ${elementDescription} found for ${normalized.app}. Match is exact and case-insensitive.${closest ? `\nClosest elementDescription matches: ${closest}.` : ""}\nAvailable targets:\n${actionableElementSummary(elements)}`);
	}
	normalized.element_index = matches[0].index;
	delete normalized.elementDescription;
	delete normalized.element_description;
	return normalized;
}

export function resolveElementTargetFallbacks(args: Record<string, JsonValue>, cache: Map<string, ElementInfo[]>): Record<string, JsonValue> {
	if (!Array.isArray(args.targets)) return args;
	if (hasElementTarget(args)) return withoutTargets(args);
	if (typeof args.app !== "string") throw new Error("targets fallback requires an app argument or sequence-level app default");
	const failures: string[] = [];
	const availableElements = cache.get(args.app) ?? [];
	for (const [index, target] of args.targets.entries()) {
		if (!isJsonRecord(target)) {
			failures.push(`target ${index} is not an object`);
			continue;
		}
		if (target.app !== undefined) {
			failures.push(`target ${index} must not include app; set app on the sequence or step instead`);
			continue;
		}
		if (!hasElementTarget(target)) {
			failures.push(`target ${index} does not contain element_index, elementId, elementDescription, or role/name`);
			continue;
		}
		try {
			let candidate = withoutTargets({ ...args, ...selectorFromTarget(target) });
			candidate = resolveElementId(candidate, cache);
			candidate = resolveElementDescription(candidate, cache);
			candidate = resolveElementRoleName(candidate, cache);
			if (typeof candidate.element_index !== "string") throw new Error("target did not resolve to element_index");
			return candidate;
		} catch (error) {
			failures.push(`target ${index}: ${conciseTargetFailure(errorMessage(error))}`);
		}
	}
	throw new Error(`Rejected unsafe target fallback: no valid target resolved. No mutation performed.\n${failures.join("\n")}\nAvailable targets:\n${actionableElementSummary(availableElements)}`);
}

export function hasStableSelector(args: Record<string, JsonValue>): boolean {
	return typeof args.elementId === "string" || typeof args.element_id === "string" || typeof args.elementDescription === "string" || typeof args.element_description === "string" || typeof args.role === "string" || typeof args.elementRole === "string" || typeof args.name === "string" || typeof args.elementName === "string" || Array.isArray(args.targets);
}

export function validateIndexedTarget(args: Record<string, JsonValue>, cache: Map<string, ElementInfo[]>, stableSelectorUsed = false): string[] {
	if (typeof args.app !== "string" || typeof args.element_index !== "string") return [];
	const element = (cache.get(args.app) ?? []).find((item) => item.index === args.element_index);
	if (!element) throw new Error(`element_index ${args.element_index} is not present in the latest ${args.app} snapshot. Re-run get_app_state and target by elementId, elementDescription, or role/name.`);
	const expectations: Array<[string, JsonValue | undefined, string | undefined]> = [
		["expectedRole", args.expectedRole, element.role],
		["expectedName", args.expectedName, element.name],
		["expectedDescription", args.expectedDescription, element.description],
		["expectedId", args.expectedId, element.id],
		["expectedValue", args.expectedValue, element.value],
	];
	for (const [field, expected, actual] of expectations) {
		if (typeof expected !== "string") continue;
		const ok = field === "expectedRole" ? roleMatches(actual ?? "", expected) : normalizeAssertionText(actual ?? "").toLowerCase() === normalizeAssertionText(expected).toLowerCase();
		if (!ok) {
			const identity = `role=${JSON.stringify(element.role)}, name=${JSON.stringify(element.name)}, id=${JSON.stringify(element.id ?? null)}, description=${JSON.stringify(element.description ?? null)}, value=${JSON.stringify(element.value ?? null)}`;
			throw new Error(`Guard failed before mutation: guard=failed; mutation=false; index=${args.element_index}; ${field} expected ${JSON.stringify(expected)}; actual=${JSON.stringify(actual ?? "")}; actualTarget={${identity}}. No mutation performed; re-snapshot or use elementId/elementDescription/role/name.`);
		}
	}
	const hasExpectation = expectations.some(([, expected]) => typeof expected === "string");
	if (!stableSelectorUsed && !hasExpectation) return [`Target selected by raw element_index ${args.element_index}; indices can go stale after rerenders. Prefer elementId, elementDescription, role/name, targets fallback, or pass expectedRole/expectedName to fail closed.`];
	return [];
}

export function describeTargetResolution(originalArgs: Record<string, JsonValue>, resolvedArgs: Record<string, JsonValue>, cache: Map<string, ElementInfo[]>): string | undefined {
	if (typeof resolvedArgs.app !== "string" || typeof resolvedArgs.element_index !== "string") return undefined;
	const element = (cache.get(resolvedArgs.app) ?? []).find((item) => item.index === resolvedArgs.element_index);
	const tags = element?.tags.length ? `, tags=${JSON.stringify(element.tags)}` : "";
	const identity = element ? `role=${JSON.stringify(element.role)}, name=${JSON.stringify(element.name)}, id=${JSON.stringify(element.id ?? null)}, description=${JSON.stringify(element.description ?? null)}, value=${JSON.stringify(element.value ?? null)}${tags}` : "";
	const resolved = `resolved target: element_index ${resolvedArgs.element_index}${element ? ` (${identity}; ${elementTargetHint(element)})` : ""}`;
	if (!Array.isArray(originalArgs.targets)) return hasElementTarget(originalArgs) ? resolved : undefined;
	const targetIndex = originalArgs.targets.findIndex((target) => {
		if (!isJsonRecord(target)) return false;
		if (target.element_index !== undefined && String(target.element_index) === resolvedArgs.element_index) return true;
		if (typeof target.elementId === "string" && target.elementId === element?.id) return true;
		if (typeof target.element_id === "string" && target.element_id === element?.id) return true;
		const description = element?.description?.toLowerCase();
		if (typeof target.elementDescription === "string" && target.elementDescription.toLowerCase() === description) return true;
		if (typeof target.element_description === "string" && target.element_description.toLowerCase() === description) return true;
		const targetRole = typeof target.role === "string" ? target.role : typeof target.elementRole === "string" ? target.elementRole : undefined;
		const targetName = typeof target.name === "string" ? target.name : typeof target.elementName === "string" ? target.elementName : undefined;
		if (targetRole && element && !roleMatches(element.role, targetRole)) return false;
		if (targetName && element) return [element.name, element.description, element.id, element.value].some((name) => typeof name === "string" && name.toLowerCase() === targetName.toLowerCase());
		return false;
	});
	return targetIndex >= 0 ? `targets[${targetIndex}] ${resolved}` : resolved;
}

export function updateElementCache(cache: Map<string, ElementInfo[]>, app: JsonValue | undefined, content: ContentBlock[]): void {
	if (typeof app !== "string") return;
	const elements = parseElementInfo(contentText(content));
	if (elements.length > 0) cache.set(app, elements);
}

export function appendText(result: FilteredToolResult, text: string): void {
	result.content = [...result.content, { type: "text", text }];
}

export function enrichActionError(result: FilteredToolResult, args: Record<string, JsonValue>, cache: Map<string, ElementInfo[]>): void {
	if (!result.isError || typeof args.app !== "string" || typeof args.element_index !== "string") return;
	const element = (cache.get(args.app) ?? []).find((item) => item.index === args.element_index);
	if (!element) return;
	const actions = element.secondaryActions.length > 0 ? element.secondaryActions.join(", ") : "none listed";
	const hints: string[] = [];
	if (element.tags.includes("settable-field") || /\b(text|field|search|edit|scroll area)\b/i.test(element.role)) {
		hints.push("For text/edit/search targets, prefer set_value only when the target is actually settable, type_text after verified focus, or select_text; perform_secondary_action Press is often unsupported.");
	}
	if (args.value !== undefined && !element.tags.includes("settable-field")) {
		hints.push("This target exposes text/search UI but is not marked settable by Accessibility; set_value is expected to fail. Use keyboard focus flow or stop before pointer fallback unless explicitly approved.");
	}
	if (element.tags.includes("navigation-field")) {
		hints.push("This target looks like a navigation/address field; set_value may navigate or submit a search. Stop unless navigation is explicitly allowed.");
	}
	if (element.role === "row" && actions === "none listed") {
		hints.push("Rows with no secondary actions may require a different target, keyboard navigation, or an explicitly approved pointer fallback.");
	}
	appendText(result, `Target element ${element.index}: ${element.line}\nValid secondary actions: ${actions}${hints.length ? `\nHints: ${hints.join(" ")}` : ""}`);
}

