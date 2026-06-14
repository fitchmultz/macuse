/**
 * Purpose: Expose Codex Computer Use as native pi tools through the Codex app-server bridge.
 * Responsibilities: Manage one persistent app-server session, register read-only and guarded mutating Computer Use tools, normalize stable element targets, and clean up session resources on reload/shutdown.
 * Scope: Pi extension runtime only; CLI smoke tests and install helpers live under tools/.
 * Usage: Loaded by pi through package.json#pi.extensions for global/local package installs.
 * Invariants/Assumptions: Codex.app is installed locally, Computer Use is macOS-only, mutating actions remain explicitly gated, and the persistent app-server thread is extension-owned.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createHash } from "node:crypto";
import { spawn, spawnSync, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

const VERSION = "0.2.0";
const DEFAULT_CODEX_BIN = "/Applications/Codex.app/Contents/Resources/codex";
const DEFAULT_TOOL_TIMEOUT_MS = 90_000;
const DEFAULT_MAX_TEXT_CHARS = 20_000;
const WAIT_TOOLS = new Set(["waitForText", "waitForURL", "waitForTitle", "waitForElement", "waitUntilElementEnabled", "waitUntilElementDisabled"]);
const UPSTREAM_COMPUTER_USE_TOOLS = ["click", "drag", "get_app_state", "list_apps", "perform_secondary_action", "press_key", "scroll", "select_text", "set_value", "type_text"] as const;
const READ_ONLY_TOOLS = new Set(["list_apps", "get_app_state", ...WAIT_TOOLS]);
const APP_SCOPED_TOOLS = new Set([
	"get_app_state",
	"perform_secondary_action",
	"press_key",
	"type_text",
	"set_value",
	"select_text",
	"scroll",
	"click",
	"drag",
	...WAIT_TOOLS,
]);
const FEATURE_FLAGS = ["computer_use", "plugins", "tool_call_mcp_elicitation"];
const PROCESS_REGISTRY_DIR = "/tmp/macuse-appserver";
const PROCESS_REGISTRY_PREFIX = "macuse-appserver-";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

type TextContentBlock = { type: "text"; text: string; [key: string]: JsonValue };
type ImageContentBlock = { type: "image"; data: string; mimeType: string; [key: string]: JsonValue };
type ContentBlock = TextContentBlock | ImageContentBlock | { type: string; [key: string]: JsonValue };

type ComputerUseToolResult = {
	content?: unknown[];
	isError?: boolean;
	is_error?: boolean;
	_meta?: JsonValue;
	meta?: JsonValue;
};

type ComputerUseInventory = {
	present: boolean;
	authStatus: string | null;
	toolNames: string[];
	toolCount: number;
	missingTools: string[];
	checkedAt: string | null;
};

type SavedImageArtifact = {
	path: string;
	bytes: number;
	sha256: string;
	width: number | null;
	height: number | null;
};

type FilteredToolResult = {
	content: ContentBlock[];
	isError: boolean;
	meta: JsonValue;
	omittedImages: number;
	savedImagePath: string | null;
	savedImageArtifact: SavedImageArtifact | null;
};

type ApprovalMode = "inherit" | "accept-all" | "accept-once" | "deny";

type SequenceStep = {
	tool: string;
	arguments: Record<string, JsonValue>;
	label?: string;
	expectText: string[];
	expectAbsentText: string[];
	expectVisibleText: string[];
	allowError: boolean;
	requireStateChange: boolean;
};

type ListAppsParams = {
	runningOnly?: boolean;
	filter?: string;
	maxTextChars?: number;
	toolTimeoutMs?: number;
};

type TargetScope = "all" | "main";

type GetAppStateParams = {
	app: string;
	approval?: ApprovalMode;
	includeImage?: boolean;
	saveImagePath?: string;
	detail?: DetailMode;
	targetScope?: TargetScope;
	maxTextChars?: number;
	toolTimeoutMs?: number;
};

type SequenceParams = {
	app?: string;
	steps: unknown;
	approval?: ApprovalMode;
	allowMutating?: boolean;
	allowPointerClick?: boolean;
	allowPointerDrag?: boolean;
	safetyNote?: string;
	includeImage?: boolean;
	saveImagePath?: string;
	screenshotStep?: "first" | "final";
	detail?: DetailMode;
	targetScope?: TargetScope;
	maxTextChars?: number;
	toolTimeoutMs?: number;
};

type DetailMode = "compact" | "full" | "minimal";

type ElementInfo = {
	index: string;
	id?: string;
	description?: string;
	role: string;
	name: string;
	value?: string;
	disabled: boolean;
	tags: string[];
	group: "content" | "chrome" | "window" | "other";
	line: string;
	secondaryActions: string[];
};

type MachineElement = Pick<ElementInfo, "index" | "id" | "description" | "role" | "name" | "value" | "disabled" | "tags" | "group" | "secondaryActions"> & { targetHint: string; line: string };

type StateSummary = {
	app: string | null;
	window: string | null;
	title: string | null;
	url: string | null;
	visibleText: string[];
	targets: MachineElement[];
};

type ChangeSummary = {
	visibleTextChanged: boolean;
	addedVisibleText: string[];
	removedVisibleText: string[];
	targetsAdded: string[];
	targetsRemoved: string[];
	titleChanged: boolean;
	urlChanged: boolean;
	summary: string[];
};

type AppMetadata = {
	name: string;
	path: string | null;
	bundleId: string | null;
	flags: string[];
	running: boolean;
	frontmost: boolean;
	lastUsed: string | null;
	line: string;
};

type FocusSnapshot = {
	frontmost: AppMetadata[];
	frontmostNames: string[];
	changed: boolean | null;
	before: AppMetadata[] | null;
	after: AppMetadata[] | null;
};

type SequenceFailure = {
	index: number;
	stepNumber: number;
	tool: string;
	label?: string;
	message: string;
};

type SequencedResult = {
	index: number;
	label?: string;
	tool: string;
	arguments: Record<string, JsonValue>;
	durationMs: number;
	result: FilteredToolResult;
	expectText: string[];
	expectAbsentText: string[];
	expectVisibleText: string[];
	allowError: boolean;
	targetResolution?: string;
	targetWarnings: string[];
	elements: MachineElement[];
	visibleText: string[];
	changed: ChangeSummary | null;
	nextActions: string[];
	acceptedElicitations: number;
	elicitationCount: number;
};

type MousePosition = { x: number; y: number };

class ComputerUseError extends Error {
	details?: unknown;

	constructor(message: string, details?: unknown) {
		super(message);
		this.name = "ComputerUseError";
		this.details = details;
	}
}

function StringEnum<T extends readonly string[]>(values: T, options?: { description?: string; default?: T[number] }) {
	return Type.Unsafe<T[number]>({
		type: "string",
		enum: values as unknown as string[],
		...(options?.description ? { description: options.description } : {}),
		...(options?.default ? { default: options.default } : {}),
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asInt(value: unknown, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.max(1, Math.trunc(value));
}

function truncateString(value: string, max: number): string {
	if (value.length <= max) return value;
	return `${value.slice(0, max)}…[${value.length} chars]`;
}

function stripInvisibleBidiMarks(value: string): string {
	return value.replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");
}

function normalizeStringList(value: unknown, name: string): string[] {
	if (value === undefined || value === null) return [];
	if (typeof value === "string") return [value];
	if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value;
	throw new Error(`${name} must be a string or array of strings.`);
}

function isTextBlock(block: unknown): block is TextContentBlock {
	return isRecord(block) && block.type === "text" && typeof block.text === "string";
}

function isImageBlock(block: unknown): block is ImageContentBlock {
	return isRecord(block) && block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string";
}

function normalizeContent(content: unknown[] | undefined): ContentBlock[] {
	if (!content || content.length === 0) return [{ type: "text", text: "No content returned." }];
	return content.map((block) => {
		if (isTextBlock(block) || isImageBlock(block)) return block;
		return { type: "text", text: JSON.stringify(block) ?? String(block) };
	});
}

function summarizeContent(content: ContentBlock[] | undefined): string {
	const normalized = normalizeContent(content);
	const text = normalized
		.filter(isTextBlock)
		.map((block) => block.text)
		.join("\n");
	const images = normalized.filter(isImageBlock).length;
	if (text && images > 0) return `${text}\n\n[${images} image block${images === 1 ? "" : "s"} attached]`;
	if (text) return text;
	if (images > 0) return `[${images} image block${images === 1 ? "" : "s"} attached]`;
	return JSON.stringify(normalized.slice(0, 3));
}

function toolResultText(result: FilteredToolResult): string {
	return (result.content || [])
		.filter(isTextBlock)
		.map((block) => block.text)
		.join("\n");
}

function imageDimensions(path: string): { width: number | null; height: number | null } {
	const result = spawnSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", path], { encoding: "utf8", timeout: 10_000 });
	if (result.status !== 0) return { width: null, height: null };
	const width = Number((result.stdout.match(/pixelWidth:\s*(\d+)/) || [])[1]);
	const height = Number((result.stdout.match(/pixelHeight:\s*(\d+)/) || [])[1]);
	return {
		width: Number.isFinite(width) ? width : null,
		height: Number.isFinite(height) ? height : null,
	};
}

function filterToolResult(result: ComputerUseToolResult, opts: { includeImage?: boolean; saveImagePath?: string; maxTextChars: number }): FilteredToolResult {
	const content: ContentBlock[] = [];
	let omittedImages = 0;
	let savedImagePath: string | null = null;
	let savedImageArtifact: SavedImageArtifact | null = null;
	const rawContent = result?.content;
	const blocks = Array.isArray(rawContent)
		? rawContent
		: rawContent === undefined
			? []
			: [{ type: "text", text: `Malformed Computer Use content field: ${truncateString(JSON.stringify(rawContent) ?? String(rawContent), opts.maxTextChars)}` }];
	for (const block of blocks) {
		if (isTextBlock(block)) {
			content.push({ ...block, text: truncateString(block.text, opts.maxTextChars) });
		} else if (isImageBlock(block)) {
			if (opts.saveImagePath && !savedImagePath) {
				const outPath = path.resolve(opts.saveImagePath);
				mkdirSync(path.dirname(outPath), { recursive: true });
				const imageData = Buffer.from(block.data, "base64");
				writeFileSync(outPath, imageData);
				savedImagePath = outPath;
				const dimensions = imageDimensions(outPath);
				savedImageArtifact = {
					path: outPath,
					bytes: imageData.byteLength,
					sha256: createHash("sha256").update(imageData).digest("hex"),
					width: dimensions.width,
					height: dimensions.height,
				};
			}
			if (opts.includeImage) content.push(block);
			else omittedImages += 1;
		} else {
			content.push(block);
		}
	}
	return {
		content: normalizeContent(content),
		isError: Boolean(result?.isError ?? result?.is_error ?? false),
		meta: (result?._meta ?? result?.meta ?? null) as JsonValue,
		omittedImages,
		savedImagePath,
		savedImageArtifact,
	};
}

function getMousePosition(): MousePosition | null {
	const script = "import CoreGraphics; if let e = CGEvent(source: nil) { let p = e.location; print(Int(p.x), Int(p.y)) }";
	const result = spawnSync("swift", ["-e", script], { encoding: "utf8", timeout: 10_000 });
	if (result.status !== 0) return null;
	const [x, y] = result.stdout.trim().split(/\s+/).map((part) => Number(part));
	if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
	return { x, y };
}

function restoreMousePosition(position: MousePosition | null): boolean {
	if (!position) return false;
	const script = `import CoreGraphics; CGWarpMouseCursorPosition(CGPoint(x: ${Math.trunc(position.x)}, y: ${Math.trunc(position.y)})); CGAssociateMouseAndMouseCursorPosition(1)`;
	const result = spawnSync("swift", ["-e", script], { encoding: "utf8", timeout: 10_000 });
	return result.status === 0;
}

function hasMutatingSteps(steps: Array<{ tool: string }>): boolean {
	return steps.some((step) => !READ_ONLY_TOOLS.has(step.tool));
}

function contentText(content: ContentBlock[] | undefined): string {
	return normalizeContent(content)
		.filter(isTextBlock)
		.map((block) => block.text)
		.join("\n");
}

function normalizeRole(value: string): string {
	const normalized = value.toLowerCase().replace(/[\s_-]+/g, " ").trim();
	if (normalized === "textbox" || normalized === "text box" || normalized === "input") return "text field";
	if (normalized === "secure textbox" || normalized === "password") return "secure text field";
	if (normalized === "search field" || normalized === "search text field" || normalized === "searchfield") return "search";
	return normalized;
}

function parseElementRole(body: string): string {
	const match = body.match(/^(standard window|split group|container|scroll area|text entry area|secure text field|search text field|text field|edit field|close button|zoom button|minimize button|radio button|pop up button|menu bar|menu item|button|checkbox|switch|slider|splitter|combo box|tab|link|row|text|toolbar|group|web area|search)\b/i);
	return normalizeRole(match?.[1] ?? body.split(/\s+/)[0] ?? "unknown");
}

function roleMatches(actual: string, expected: string): boolean {
	const wanted = normalizeRole(expected);
	const got = normalizeRole(actual);
	if (wanted === got) return true;
	if (wanted === "text field") return ["text field", "edit field", "text entry area", "secure text field", "scroll area", "search"].includes(got);
	if (wanted === "search") return ["search", "search text field"].includes(got);
	return false;
}

function settableFieldValue(body: string): string | undefined {
	const valueMatch = body.match(/(?:^|,\s*)Value:\s*([\s\S]+)$/i);
	if (valueMatch?.[1]) return valueMatch[1].trim();
	const settableMatch = body.match(/\((?:settable|editable),\s*string\)\s+([\s\S]+)$/i);
	return settableMatch?.[1]?.trim();
}

function stableFieldName(value: string): string {
	return value.replace(/(\((?:settable|editable),\s*string\))\s+[\s\S]+$/i, "$1").trim();
}

function stripElementAttributes(value: string): string {
	return value.replace(/^\([^)]*\)\s*/, "").replace(/^Description:\s*/i, "").replace(/\s*\(disabled\)\s*$/i, "").trim();
}

function rolePrefixPattern(role: string): RegExp {
	const escaped = role.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	if (role === "search") return /^(?:search(?:\s+text\s+field)?|text\s+field)\s*/i;
	return new RegExp(`^${escaped}\\s*`, "i");
}

function parseElementName(body: string, role: string, id?: string, description?: string): string {
	if (description) return description;
	const withoutRole = body.replace(rolePrefixPattern(role), "").trim();
	const beforeComma = withoutRole.split(/,\s*(?:ID:|Help:|Secondary Actions:|URL:|Value:|Placeholder:)/)[0]?.trim() ?? "";
	const textFieldLike = ["text field", "search", "edit field", "text entry area", "secure text field"].includes(role);
	const cleaned = textFieldLike ? stableFieldName(stripElementAttributes(beforeComma)) : stripElementAttributes(beforeComma);
	return cleaned || id || role;
}

function elementTags(line: string, role: string, name: string, description?: string): string[] {
	const haystack = `${line} ${role} ${name} ${description ?? ""}`.toLowerCase();
	const tags = new Set<string>();
	if (/\bsettable\b|\beditable\b/.test(haystack)) tags.add("settable-field");
	if (role === "search" || /\bsearch\b/.test(haystack)) tags.add("search-field");
	if (/\b(address|location|url|omnibox|address and search bar)\b/.test(haystack)) tags.add("navigation-field");
	if (/\b(cancel|clear)\b/.test(haystack)) tags.add("clear-control");
	if (/\b(delete|erase|remove|trash|force quit|quit process|stop process|kill|sign out|log out|password|privacy|security|payment|purchase|send|submit)\b/.test(haystack)) tags.add("risk-sensitive-control");
	return [...tags];
}

function elementGroup(line: string, role: string): ElementInfo["group"] {
	if (/\b(?:standard window|close button|zoom button|minimize button)\b/i.test(line)) return "window";
	if (/\b(?:menu bar|toolbar)\b/i.test(line)) return "chrome";
	if (/\b(?:tab group|tab|address|bookmark|extension|sidebar|show sidebar|mode:)\b/i.test(line)) return "chrome";
	if (/\b(?:Back|Forward|Reload|Home|Bookmark this tab|View site information|Share this page|Brave Shields|Brave Rewards|Extensions|Tab Search|Control your music|Address and search bar)\b/i.test(line)) return "chrome";
	if (["button", "pop up button", "search", "text field", "edit field", "text entry area", "secure text field", "checkbox", "switch", "radio button", "slider", "splitter", "combo box", "link", "row", "text", "scroll area"].includes(role)) return "content";
	return "other";
}

function elementBlocks(text: string): string[] {
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

function parseElementInfo(text: string): ElementInfo[] {
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

function isInteractiveElement(element: ElementInfo): boolean {
	return Boolean(element.id) ||
		element.secondaryActions.length > 0 ||
		/\b(button|search|text entry area|text field|edit field|field|menu|menu item|row|checkbox|radio|slider|scroll area|combo box|tab|link)\b/i.test(element.line) ||
		/\btext\s+‎/.test(element.line);
}

function elementTargetHint(element: ElementInfo): string {
	if (element.id) return `target: { elementId: ${JSON.stringify(element.id)} }`;
	if (element.description) return `target: { elementDescription: ${JSON.stringify(element.description)} }`;
	if (element.name && element.role) return `target: { role: ${JSON.stringify(element.role)}, name: ${JSON.stringify(element.name)} }`;
	return `fallback: { element_index: ${JSON.stringify(element.index)} }`;
}

function elementLineWithTargetHint(element: ElementInfo): string {
	const tags = element.tags.length > 0 ? ` tags=${element.tags.join(",")}` : "";
	const value = element.value ? ` value=${JSON.stringify(element.value)}` : "";
	return `${stripInvisibleBidiMarks(element.line)}${value}${tags} — ${elementTargetHint(element)}`;
}

function shortElementLabel(element: ElementInfo): string {
	const raw = element.name || element.description || element.id || stripInvisibleBidiMarks(element.line.replace(/^\d+\s+/, ""));
	return truncateString(raw.replace(/,\s*Help:.*$/, ""), 80);
}

function rankElement(element: ElementInfo): number {
	let score = 0;
	if (element.group === "content") score -= 100;
	if (element.group === "chrome") score += 80;
	if (element.group === "window") score += 120;
	if (element.tags.includes("search-field")) score -= 60;
	if (element.tags.includes("settable-field")) score -= 45;
	if (element.tags.includes("risk-sensitive-control")) score += 60;
	if (element.id) score -= 15;
	if (element.description || element.name) score -= 10;
	if (element.disabled) score += 20;
	return score + Number(element.index);
}

function prioritizedElements(elements: ElementInfo[], scope: TargetScope = "all"): ElementInfo[] {
	return elements
		.filter((element) => scope === "all" || element.group === "content")
		.sort((a, b) => rankElement(a) - rankElement(b));
}

function elementStabilityNote(text: string): string | null {
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

function compactText(text: string, scope: TargetScope = "all"): string {
	const lines = text.split("\n");
	const header = lines.filter((line) => /^(Computer Use state|<app_state>|App=|Window:)/.test(line.trim())).slice(0, 4);
	const interactive = prioritizedElements(parseElementInfo(text).filter(isInteractiveElement), scope);
	const note = elementStabilityNote(text);
	const groups = ["content", "chrome", "window", "other"] as const;
	const body: string[] = [];
	for (const group of groups) {
		const groupElements = interactive.filter((element) => element.group === group);
		if (groupElements.length === 0) continue;
		body.push(`${group[0].toUpperCase()}${group.slice(1)} targets:`);
		body.push(...groupElements.slice(0, group === "content" ? 40 : 12).map(elementLineWithTargetHint));
		if (groupElements.length > (group === "content" ? 40 : 12)) body.push(`…${groupElements.length - (group === "content" ? 40 : 12)} more ${group} targets omitted`);
	}
	return [...header, ...body, ...(note ? [note] : [])].join("\n") || truncateString(stripInvisibleBidiMarks(text), DEFAULT_MAX_TEXT_CHARS);
}

function minimalText(text: string, scope: TargetScope = "all"): string {
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
	const sections = [...header];
	if (visibleText.length > 0) sections.push("Visible text:", ...visibleText);
	if (targets.length > 0) sections.push("Targets:", ...targets);
	if (omittedByGroup) sections.push(`Target groups: ${omittedByGroup}`);
	if (note) sections.push(note);
	return sections.join("\n") || truncateString(stripInvisibleBidiMarks(text), DEFAULT_MAX_TEXT_CHARS);
}

function compactContent(content: ContentBlock[], scope: TargetScope = "all"): ContentBlock[] {
	return content.map((block) => {
		if (isTextBlock(block)) return { ...block, text: compactText(block.text, scope) };
		return block;
	});
}

function minimalContent(content: ContentBlock[], scope: TargetScope = "all"): ContentBlock[] {
	return content.map((block) => {
		if (isTextBlock(block)) return { ...block, text: minimalText(block.text, scope) };
		return block;
	});
}

function truncateTextContent(content: ContentBlock[], maxTextChars: number): ContentBlock[] {
	return content.map((block) => {
		if (isTextBlock(block)) return { ...block, text: truncateString(block.text, maxTextChars) };
		return block;
	});
}

function appendElementStabilityNote(result: FilteredToolResult): void {
	const note = elementStabilityNote(contentText(result.content));
	if (note) appendText(result, note);
}

function normalizeDetail(value: unknown, fallback: DetailMode): DetailMode {
	if (value === undefined || value === null) return fallback;
	if (value === "compact" || value === "full" || value === "minimal") return value;
	throw new Error('detail must be "compact", "full", or "minimal".');
}

function normalizeAssertionText(value: string): string {
	return stripInvisibleBidiMarks(value).normalize("NFC");
}

function assertionContentText(content: ContentBlock[] | undefined): string {
	const values = new Set<string>();
	for (const element of parseElementInfo(contentText(content))) {
		values.add(element.line);
		for (const value of [element.id, element.description, element.name, element.value]) {
			if (value) values.add(value);
		}
	}
	return [...values].join("\n");
}

function contentIncludesMultilineValue(content: ContentBlock[] | undefined, expectedValue: string): { matched: boolean; partial: boolean; matchedLines: string[]; missingLines: string[] } {
	const normalizedContent = normalizeAssertionText(contentText(content));
	const normalizedExpected = normalizeAssertionText(expectedValue);
	if (normalizedContent.includes(normalizedExpected)) return { matched: true, partial: false, matchedLines: [expectedValue], missingLines: [] };
	const lines = normalizedExpected.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
	if (lines.length <= 1) return { matched: false, partial: false, matchedLines: [], missingLines: lines };
	const matchedLines = lines.filter((line) => normalizedContent.includes(line));
	const missingLines = lines.filter((line) => !normalizedContent.includes(line));
	return { matched: missingLines.length === 0, partial: matchedLines.length > 0, matchedLines, missingLines };
}

function visibleTextValues(content: ContentBlock[]): string[] {
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

function visibleAssertionValues(content: ContentBlock[]): string[] {
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

function machineElements(content: ContentBlock[], scope: TargetScope = "all"): MachineElement[] {
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

function stateSummary(content: ContentBlock[], scope: TargetScope = "all"): StateSummary {
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

function diffLists(before: string[], after: string[], limit = 8): { added: string[]; removed: string[] } {
	const beforeSet = new Set(before);
	const afterSet = new Set(after);
	return {
		added: after.filter((item) => !beforeSet.has(item)).slice(0, limit),
		removed: before.filter((item) => !afterSet.has(item)).slice(0, limit),
	};
}

function compareState(before: StateSummary | null, after: StateSummary | null): ChangeSummary | null {
	if (!before || !after) return null;
	const visible = diffLists(before.visibleText, after.visibleText);
	const beforeTargets = before.targets.map((target) => `${target.role}:${target.name}:${target.disabled ? "disabled" : "enabled"}`);
	const afterTargets = after.targets.map((target) => `${target.role}:${target.name}:${target.disabled ? "disabled" : "enabled"}`);
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

function normalizePressKeyValue(value: string): string {
	const aliases = new Map<string, string>([
		["esc", "Escape"],
		["escape", "Escape"],
		["return", "Return"],
		["enter", "Return"],
		["tab", "Tab"],
		["space", "space"],
		["period", "period"],
		[".", "period"],
	]);
	return value.split("+").map((part) => aliases.get(part.trim().toLowerCase()) ?? part.trim()).join("+");
}

function normalizeToolArguments(args: Record<string, JsonValue>): Record<string, JsonValue> {
	const normalized: Record<string, JsonValue> = { ...args };
	if (normalized.element_index === undefined && normalized.element !== undefined) {
		normalized.element_index = normalized.element;
		delete normalized.element;
	}
	if (normalized.element_index !== undefined && normalized.element_index !== null) normalized.element_index = String(normalized.element_index);
	if (typeof normalized.key === "string") normalized.key = normalizePressKeyValue(normalized.key);
	return normalized;
}

function hasElementTarget(args: Record<string, JsonValue>): boolean {
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

function isJsonRecord(value: JsonValue): value is Record<string, JsonValue> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function withoutTargets(args: Record<string, JsonValue>): Record<string, JsonValue> {
	const normalized = { ...args };
	delete normalized.targets;
	return normalized;
}

function selectorFromTarget(target: Record<string, JsonValue>): Record<string, JsonValue> {
	const selector: Record<string, JsonValue> = {};
	for (const key of ["element_index", "element", "elementId", "element_id", "elementDescription", "element_description", "role", "elementRole", "name", "elementName", "expectedRole", "expectedName", "expectedDescription", "expectedId", "expectedValue"] as const) {
		if (target[key] !== undefined) selector[key] = target[key];
	}
	return selector;
}

function elementSummary(elements: ElementInfo[], limit = 40): string {
	if (elements.length === 0) return "No cached elements for this app.";
	const shown = elements.slice(0, limit).map(elementLineWithTargetHint).join("\n");
	const remaining = elements.length > limit ? `\n…${elements.length - limit} more elements omitted` : "";
	return `${shown}${remaining}`;
}

function actionableElementSummary(elements: ElementInfo[], limit = 12): string {
	const actionable = elements.filter((element) => !/\b(?:standard window|menu bar|close button|zoom button|minimize button)\b/i.test(element.line));
	return elementSummary(actionable, limit);
}

function conciseTargetFailure(message: string): string {
	return message.split("\nAvailable targets:\n")[0]?.split("\nAvailable elements:\n")[0] ?? message;
}

function editDistance(a: string, b: string): number {
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

function semanticSuggestionScore(element: ElementInfo, requested: string, candidateValue: string): number {
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

function closestElementSuggestions(elements: ElementInfo[], value: string, field: "id" | "description" | "name", limit = 3): string {
	const candidates = elements
		.map((element) => ({ element, value: element[field] }))
		.filter((candidate): candidate is { element: ElementInfo; value: string } => typeof candidate.value === "string" && candidate.value.length > 0)
		.map((candidate) => ({ ...candidate, score: semanticSuggestionScore(candidate.element, value, candidate.value) }))
		.sort((a, b) => a.score - b.score)
		.slice(0, limit);
	if (candidates.length === 0) return "";
	return candidates.map((candidate) => `${candidate.value} (${elementTargetHint(candidate.element)})`).join(", ");
}

function resolveElementId(args: Record<string, JsonValue>, cache: Map<string, ElementInfo[]>): Record<string, JsonValue> {
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

function resolveElementRoleName(args: Record<string, JsonValue>, cache: Map<string, ElementInfo[]>): Record<string, JsonValue> {
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

function resolveElementDescription(args: Record<string, JsonValue>, cache: Map<string, ElementInfo[]>): Record<string, JsonValue> {
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

function resolveElementTargetFallbacks(args: Record<string, JsonValue>, cache: Map<string, ElementInfo[]>): Record<string, JsonValue> {
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

function hasStableSelector(args: Record<string, JsonValue>): boolean {
	return typeof args.elementId === "string" || typeof args.element_id === "string" || typeof args.elementDescription === "string" || typeof args.element_description === "string" || typeof args.role === "string" || typeof args.elementRole === "string" || typeof args.name === "string" || typeof args.elementName === "string" || Array.isArray(args.targets);
}

function validateIndexedTarget(args: Record<string, JsonValue>, cache: Map<string, ElementInfo[]>, stableSelectorUsed = false): string[] {
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

function stripSelectorOnlyKeys(args: Record<string, JsonValue>): Record<string, JsonValue> {
	const normalized = { ...args };
	for (const key of ["expectedRole", "expectedName", "expectedDescription", "expectedId", "expectedValue"] as const) delete normalized[key];
	return normalized;
}

function describeTargetResolution(originalArgs: Record<string, JsonValue>, resolvedArgs: Record<string, JsonValue>, cache: Map<string, ElementInfo[]>): string | undefined {
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

function updateElementCache(cache: Map<string, ElementInfo[]>, app: JsonValue | undefined, content: ContentBlock[]): void {
	if (typeof app !== "string") return;
	const elements = parseElementInfo(contentText(content));
	if (elements.length > 0) cache.set(app, elements);
}

function appendText(result: FilteredToolResult, text: string): void {
	result.content = [...result.content, { type: "text", text }];
}

function enrichActionError(result: FilteredToolResult, args: Record<string, JsonValue>, cache: Map<string, ElementInfo[]>): void {
	if (!result.isError || typeof args.app !== "string" || typeof args.element_index !== "string") return;
	const element = (cache.get(args.app) ?? []).find((item) => item.index === args.element_index);
	if (!element) return;
	const actions = element.secondaryActions.length > 0 ? element.secondaryActions.join(", ") : "none listed";
	const hints: string[] = [];
	if (element.tags.includes("settable-field") || /\b(text|field|search|edit|scroll area)\b/i.test(element.role)) {
		hints.push("For text/edit/search targets, prefer set_value, type_text after verified focus, or select_text; perform_secondary_action Press is often unsupported.");
	}
	if (element.tags.includes("navigation-field")) {
		hints.push("This target looks like a navigation/address field; set_value may navigate or submit a search. Stop unless navigation is explicitly allowed.");
	}
	if (element.role === "row" && actions === "none listed") {
		hints.push("Rows with no secondary actions may require a different target, keyboard navigation, or an explicitly approved pointer fallback.");
	}
	appendText(result, `Target element ${element.index}: ${element.line}\nValid secondary actions: ${actions}${hints.length ? `\nHints: ${hints.join(" ")}` : ""}`);
}

function filteredAppListLines(content: ContentBlock[], opts: { runningOnly?: boolean; filter?: string }): string[] {
	let lines = contentText(content).split("\n").map((line) => line.trim()).filter(Boolean);
	if (opts.runningOnly) lines = lines.filter((line: string) => /\[(?:[^\]]*,\s*)?(?:frontmost,\s*)?running(?:[,\]])/.test(line) || line.includes("[frontmost, running"));
	if (opts.filter) {
		const needle = opts.filter.toLowerCase();
		lines = lines.filter((line: string) => line.toLowerCase().includes(needle));
	}
	return lines;
}

function parseAppListLine(line: string): AppMetadata {
	const [left, flagsPart = ""] = line.split(/\s+\[([^\]]+)\]\s*$/).filter((part) => part !== undefined);
	const parts = (left || line).split(" — ").map((part) => part.trim());
	const flags = flagsPart
		.split(",")
		.map((flag) => flag.trim())
		.filter(Boolean);
	const lastUsedFlag = flags.find((flag) => /^last[- ]used:/i.test(flag));
	return {
		name: parts[0] || line,
		path: parts[1] || null,
		bundleId: parts[2] || null,
		flags,
		running: flags.some((flag) => flag.toLowerCase() === "running"),
		frontmost: flags.some((flag) => flag.toLowerCase() === "frontmost"),
		lastUsed: lastUsedFlag?.replace(/^last[- ]used:\s*/i, "") ?? null,
		line,
	};
}

function parseAppListContent(content: ContentBlock[], opts: { runningOnly?: boolean; filter?: string } = {}): AppMetadata[] {
	return filteredAppListLines(content, opts).map(parseAppListLine);
}

function filterAppListContent(content: ContentBlock[], opts: { runningOnly?: boolean; filter?: string; maxTextChars: number }): ContentBlock[] {
	const lines = filteredAppListLines(content, opts);
	const apps = lines.map(parseAppListLine);
	const frontmost = apps.filter((app) => app.frontmost).map((app) => app.name).join(", ") || "<none>";
	const summary = `Structured app summary: count=${apps.length}; frontmost=${frontmost}; fields=name,path,bundleId,flags,running,frontmost,lastUsed`;
	const text = lines.length > 0 ? `${summary}\n${lines.join("\n")}` : "No apps matched the requested filter.";
	return [{ type: "text", text: truncateString(text, opts.maxTextChars) }];
}

async function captureFocusSnapshot(approval: ApprovalMode, timeoutMs: number, maxTextChars: number, signal?: AbortSignal): Promise<AppMetadata[] | null> {
	try {
		const call = await client.callTool("list_apps", {}, { approval, timeoutMs, signal });
		const result = filterToolResult(call.result, { maxTextChars });
		return parseAppListContent(result.content, { runningOnly: true }).filter((app) => app.frontmost);
	} catch {
		return null;
	}
}

function focusSnapshot(before: AppMetadata[] | null, after: AppMetadata[] | null): FocusSnapshot {
	const afterNames = (after ?? []).map((app) => app.name);
	const beforeNames = (before ?? []).map((app) => app.name);
	const changed = before && after ? beforeNames.join("|") !== afterNames.join("|") : null;
	return {
		frontmost: after ?? [],
		frontmostNames: afterNames,
		changed,
		before,
		after,
	};
}

function appMatches(app: AppMetadata, target: string): boolean {
	const expected = target.toLowerCase();
	return [app.name, app.path, app.bundleId]
		.filter((value): value is string => typeof value === "string")
		.some((value) => value.toLowerCase() === expected || value.toLowerCase().includes(expected));
}

function focusSummaryText(focus: FocusSnapshot, targetApp?: string): string {
	const before = focus.before?.map((app) => app.name).join(", ") || "<unknown>";
	const after = focus.after?.map((app) => app.name).join(", ") || "<unknown>";
	const targetBecameFrontmost = targetApp ? Boolean(focus.after?.some((app) => appMatches(app, targetApp)) && !focus.before?.some((app) => appMatches(app, targetApp))) : null;
	const targetFrontmostAfter = targetApp ? Boolean(focus.after?.some((app) => appMatches(app, targetApp))) : null;
	return `Focus summary: before=${before}; after=${after}; frontmostChanged=${focus.changed ?? "unknown"}${targetApp ? `; targetAppFrontmostAfter=${targetFrontmostAfter}; targetAppBecameFrontmost=${targetBecameFrontmost}` : ""}`;
}

function appendSavedImageArtifact(result: FilteredToolResult): void {
	const artifact = result.savedImageArtifact;
	if (!artifact) return;
	const size = artifact.width && artifact.height ? `${artifact.width}x${artifact.height}` : "unknown size";
	appendText(result, `Saved image artifact: ${artifact.path} (${artifact.bytes} bytes, ${size}, sha256=${artifact.sha256})`);
}

function appendImageWarning(result: FilteredToolResult, opts: { includeImage?: boolean; saveImagePath?: string }): void {
	appendSavedImageArtifact(result);
	if (!opts.includeImage) return;
	appendText(result, `Image blocks were requested. Display depends on the current model and pi host support; use saveImagePath for reliable screenshot artifacts${opts.saveImagePath ? ` (saved first image to ${path.resolve(opts.saveImagePath)})` : ""}.`);
}

function computerUseDiagnostic(result: FilteredToolResult, tool: string, args: Record<string, JsonValue>): string | null {
	const text = toolResultText(result);
	const app = typeof args.app === "string" ? args.app : "the target app";
	if (/-10005|timeoutReached/i.test(text)) {
		return `Diagnostic: upstream Computer Use timed out while collecting state for ${app}. macuse cannot safely operate that app until upstream get_app_state succeeds. detail:\"minimal\" and targetScope filtering reduce returned tokens only after upstream responds, so they cannot fix this timeout. Try /macuse-restart, a larger toolTimeoutMs, closing heavy browser windows/tabs, or use agent_browser for web/Chrome tasks when browser automation is acceptable.`;
	}
	if (/Computer Use is not active .*first must call get_app_state|first must call get_app_state/i.test(text)) {
		return `Diagnostic: upstream Computer Use refused ${tool} because ${app} has no active state session. No mutation was performed by macuse. A successful codex_cu_get_app_state for the same app is required first; if that state call times out, this is an upstream Computer Use blocker rather than a target-selection problem.`;
	}
	return null;
}

function appendComputerUseDiagnostic(result: FilteredToolResult, tool: string, args: Record<string, JsonValue>): string | null {
	const diagnostic = computerUseDiagnostic(result, tool, args);
	if (diagnostic) {
		appendText(result, diagnostic);
		if (/no active state session|refused/i.test(diagnostic)) result.isError = true;
	}
	return diagnostic;
}

function failureResult(message: string, maxTextChars: number): FilteredToolResult {
	return {
		content: [{ type: "text", text: truncateString(message, maxTextChars) }],
		isError: true,
		meta: null,
		omittedImages: 0,
		savedImagePath: null,
		savedImageArtifact: null,
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function bridgeDetails(base: Record<string, unknown>, stderrTail: string): Record<string, unknown> {
	return {
		computerUse: {
			version: VERSION,
			persistentAppServer: true,
			...base,
		},
		stderrTail,
	};
}

type ProcessRecord = {
	version: string;
	nonce: string;
	cwd: string;
	codexBin: string;
	ownerPid: number;
	ownerStart: string | null;
	appServerPid: number;
	appServerStart: string | null;
	pidFile: string;
	createdAt: string;
};

type ReapSummary = {
	pidFile: string;
	appServerPid?: number;
	ownerPid?: number;
	action: "removed-dead" | "reaped-orphan" | "kept-active" | "ignored";
	reason: string;
};

function processStart(pid: number): string | null {
	if (!Number.isInteger(pid) || pid <= 0) return null;
	const result = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", timeout: 5_000 });
	if (result.status !== 0) return null;
	return result.stdout.trim() || null;
}

function processCommand(pid: number): string | null {
	if (!Number.isInteger(pid) || pid <= 0) return null;
	const result = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8", timeout: 5_000 });
	if (result.status !== 0) return null;
	return result.stdout.trim() || null;
}

function processAlive(pid: number, expectedStart?: string | null): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
	} catch {
		return false;
	}
	if (!expectedStart) return true;
	return processStart(pid) === expectedStart;
}

function appServerCommandMatches(pid: number, codexBin: string): boolean {
	const command = processCommand(pid);
	if (!command) return false;
	return command.includes(codexBin) && command.includes("app-server") && command.includes("--enable computer_use");
}

function processChildren(): Map<number, number[]> {
	const result = spawnSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8", timeout: 5_000 });
	const children = new Map<number, number[]>();
	if (result.status !== 0) return children;
	for (const line of result.stdout.split("\n")) {
		const [pidText, ppidText] = line.trim().split(/\s+/);
		const pid = Number(pidText);
		const ppid = Number(ppidText);
		if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
		const list = children.get(ppid) ?? [];
		list.push(pid);
		children.set(ppid, list);
	}
	return children;
}

function processTree(rootPid: number): number[] {
	const children = processChildren();
	const ordered: number[] = [];
	const visit = (pid: number) => {
		for (const child of children.get(pid) ?? []) visit(child);
		ordered.push(pid);
	};
	visit(rootPid);
	return ordered;
}

function killProcessTree(rootPid: number, signal: NodeJS.Signals): void {
	for (const pid of processTree(rootPid)) {
		try {
			process.kill(pid, signal);
		} catch {
			// Process may have exited between ps and kill.
		}
	}
}

function registryKey(cwd: string, codexBin: string): string {
	return createHash("sha256").update(`${cwd}\0${codexBin}`).digest("hex").slice(0, 16);
}

function safeUnlink(file: string): void {
	try {
		unlinkSync(file);
	} catch {
		// Already gone or not removable; stale cleanup is best effort.
	}
}

function readProcessRecord(file: string): ProcessRecord | null {
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
		if (!isRecord(parsed)) return null;
		if (parsed.version !== VERSION || typeof parsed.cwd !== "string" || typeof parsed.codexBin !== "string" || typeof parsed.pidFile !== "string") return null;
		if (typeof parsed.nonce !== "string" || typeof parsed.createdAt !== "string") return null;
		if (typeof parsed.ownerPid !== "number" || typeof parsed.appServerPid !== "number") return null;
		return parsed as ProcessRecord;
	} catch {
		return null;
	}
}

function reapStaleAppServers(cwd: string, codexBin: string): ReapSummary[] {
	mkdirSync(PROCESS_REGISTRY_DIR, { recursive: true });
	const key = registryKey(cwd, codexBin);
	const summaries: ReapSummary[] = [];
	for (const name of readdirSync(PROCESS_REGISTRY_DIR)) {
		if (!name.startsWith(`${PROCESS_REGISTRY_PREFIX}${key}-`) || !name.endsWith(".json")) continue;
		const file = path.join(PROCESS_REGISTRY_DIR, name);
		const record = readProcessRecord(file);
		if (!record || record.cwd !== cwd || record.codexBin !== codexBin) {
			summaries.push({ pidFile: file, action: "ignored", reason: "record did not match current cwd/codexBin" });
			continue;
		}
		const appAlive = processAlive(record.appServerPid, record.appServerStart);
		if (!appAlive) {
			safeUnlink(file);
			summaries.push({ pidFile: file, appServerPid: record.appServerPid, ownerPid: record.ownerPid, action: "removed-dead", reason: "app-server process is no longer alive" });
			continue;
		}
		const ownerAlive = processAlive(record.ownerPid, record.ownerStart);
		if (ownerAlive) {
			summaries.push({ pidFile: file, appServerPid: record.appServerPid, ownerPid: record.ownerPid, action: "kept-active", reason: "owner process is still alive" });
			continue;
		}
		if (!appServerCommandMatches(record.appServerPid, codexBin)) {
			summaries.push({ pidFile: file, appServerPid: record.appServerPid, ownerPid: record.ownerPid, action: "ignored", reason: "process command did not match macuse app-server fingerprint" });
			continue;
		}
		killProcessTree(record.appServerPid, "SIGTERM");
		setTimeout(() => {
			if (processAlive(record.appServerPid, record.appServerStart)) killProcessTree(record.appServerPid, "SIGKILL");
		}, 2_000).unref();
		safeUnlink(file);
		summaries.push({ pidFile: file, appServerPid: record.appServerPid, ownerPid: record.ownerPid, action: "reaped-orphan", reason: "owner process is gone" });
	}
	return summaries;
}

const WATCHDOG_SCRIPT = String.raw`
const { spawnSync } = require('node:child_process');
const { existsSync, readFileSync, unlinkSync } = require('node:fs');
const record = JSON.parse(process.argv[1]);
function ps(pid, field) {
  const result = spawnSync('ps', ['-p', String(pid), '-o', field + '='], { encoding: 'utf8', timeout: 5000 });
  return result.status === 0 ? result.stdout.trim() : '';
}
function alive(pid, start) {
  try { process.kill(pid, 0); } catch { return false; }
  return !start || ps(pid, 'lstart') === start;
}
function commandMatches(pid) {
  const command = ps(pid, 'command');
  return command.includes(record.codexBin) && command.includes('app-server') && command.includes('--enable computer_use');
}
function children() {
  const result = spawnSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8', timeout: 5000 });
  const map = new Map();
  if (result.status !== 0) return map;
  for (const line of result.stdout.split('\n')) {
    const [pidText, ppidText] = line.trim().split(/\s+/);
    const pid = Number(pidText), ppid = Number(ppidText);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    const list = map.get(ppid) || [];
    list.push(pid);
    map.set(ppid, list);
  }
  return map;
}
function tree(root) {
  const map = children();
  const out = [];
  function visit(pid) { for (const child of map.get(pid) || []) visit(child); out.push(pid); }
  visit(root);
  return out;
}
function killTree(signal) {
  for (const pid of tree(record.appServerPid)) {
    try { process.kill(pid, signal); } catch {}
  }
}
function samePidFile() {
  try {
    const current = JSON.parse(readFileSync(record.pidFile, 'utf8'));
    return current.nonce === record.nonce && current.appServerPid === record.appServerPid;
  } catch { return false; }
}
const timer = setInterval(() => {
  if (!existsSync(record.pidFile) || !samePidFile()) process.exit(0);
  if (!alive(record.appServerPid, record.appServerStart)) {
    try { unlinkSync(record.pidFile); } catch {}
    process.exit(0);
  }
  if (alive(record.ownerPid, record.ownerStart)) return;
  if (commandMatches(record.appServerPid)) {
    killTree('SIGTERM');
    setTimeout(() => { if (alive(record.appServerPid, record.appServerStart)) killTree('SIGKILL'); }, 2000).unref();
  }
  try { unlinkSync(record.pidFile); } catch {}
  clearInterval(timer);
  setTimeout(() => process.exit(0), 2500).unref();
}, 1000);
timer.unref();
setInterval(() => {}, 60000);
`;

function writeProcessRecord(cwd: string, codexBin: string, appServerPid: number): ProcessRecord {
	mkdirSync(PROCESS_REGISTRY_DIR, { recursive: true });
	const key = registryKey(cwd, codexBin);
	const nonce = createHash("sha256").update(`${process.pid}\0${appServerPid}\0${Date.now()}\0${Math.random()}`).digest("hex").slice(0, 16);
	const pidFile = path.join(PROCESS_REGISTRY_DIR, `${PROCESS_REGISTRY_PREFIX}${key}-${process.pid}-${appServerPid}-${nonce}.json`);
	const record: ProcessRecord = {
		version: VERSION,
		nonce,
		cwd,
		codexBin,
		ownerPid: process.pid,
		ownerStart: processStart(process.pid),
		appServerPid,
		appServerStart: processStart(appServerPid),
		pidFile,
		createdAt: new Date().toISOString(),
	};
	writeFileSync(pidFile, JSON.stringify(record, null, 2));
	return record;
}

function startWatchdog(record: ProcessRecord): ChildProcess | null {
	try {
		const proc = spawn(process.execPath, ["-e", WATCHDOG_SCRIPT, JSON.stringify(record)], {
			detached: true,
			stdio: "ignore",
		});
		proc.unref();
		return proc;
	} catch {
		return null;
	}
}

type PendingRequest = {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
	method: string;
	onAbort?: () => void;
};

type AppServerThread = { id: string } & Record<string, unknown>;

type JsonRpcId = string | number;

type JsonRpcMessage = Record<string, unknown> & {
	id?: unknown;
	method?: unknown;
	params?: unknown;
	result?: unknown;
	error?: { message?: unknown } & Record<string, unknown>;
};

function parseJsonMessage(line: string): JsonRpcMessage | null {
	try {
		const parsed = JSON.parse(line) as unknown;
		return isRecord(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

function summarizeComputerUseInventory(statusResult: unknown): ComputerUseInventory {
	const servers = isRecord(statusResult) && Array.isArray(statusResult.data) ? statusResult.data : [];
	const server = servers.find((candidate) => isRecord(candidate) && candidate.name === "computer-use");
	if (!isRecord(server)) {
		return { present: false, authStatus: null, toolNames: [], toolCount: 0, missingTools: [...UPSTREAM_COMPUTER_USE_TOOLS], checkedAt: new Date().toISOString() };
	}
	const tools = isRecord(server.tools) ? Object.keys(server.tools).sort() : [];
	return {
		present: true,
		authStatus: typeof server.authStatus === "string" ? server.authStatus : null,
		toolNames: tools,
		toolCount: tools.length,
		missingTools: UPSTREAM_COMPUTER_USE_TOOLS.filter((tool) => !tools.includes(tool)),
		checkedAt: new Date().toISOString(),
	};
}

function mergeComputerUseInventories(current: ComputerUseInventory, next: ComputerUseInventory): ComputerUseInventory {
	if (current.present) return current;
	return next;
}

class AppServerClient {
	private proc: ChildProcessWithoutNullStreams | null = null;
	private nextId = 1;
	private pending = new Map<number, PendingRequest>();
	private buffer = "";
	private queue: Promise<unknown> = Promise.resolve();
	private initializing: Promise<void> | null = null;
	private initialized: unknown = null;
	private thread: AppServerThread | null = null;
	private currentApproval: ApprovalMode = "inherit";
	private acceptedThisCall = 0;
	private acceptedElicitations = 0;
	private elicitationCount = 0;
	private notifications: Array<{ method: string; params?: unknown }> = [];
	private stderr = "";
	private processRecord: ProcessRecord | null = null;
	private watchdog: ChildProcess | null = null;
	private staleReapSummary: ReapSummary[] = [];
	private computerUseInventory: ComputerUseInventory | null = null;

	constructor(private readonly codexBin = process.env.CODEX_BIN || DEFAULT_CODEX_BIN, private readonly cwd = process.cwd()) {
		this.staleReapSummary = reapStaleAppServers(this.cwd, this.codexBin);
	}

	status() {
		return {
			version: VERSION,
			codexBin: this.codexBin,
			cwd: this.cwd,
			running: Boolean(this.proc && this.proc.exitCode === null && this.proc.signalCode === null),
			processPid: this.proc?.pid ?? null,
			processRecord: this.processRecord,
			watchdogPid: this.watchdog?.pid ?? null,
			registryDir: PROCESS_REGISTRY_DIR,
			staleReapSummary: this.staleReapSummary,
			threadId: this.thread?.id ?? null,
			computerUse: this.computerUseInventory,
			acceptedElicitations: this.acceptedElicitations,
			elicitationCount: this.elicitationCount,
			notifications: this.notifications.slice(-10),
			stderrTail: this.stderr.slice(-4000),
		};
	}

	async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.queue.then(fn, fn);
		this.queue = run.catch(() => undefined);
		return run;
	}

	async ensureReady(timeoutMs: number, signal?: AbortSignal): Promise<void> {
		if (this.proc && this.proc.exitCode === null && this.proc.signalCode === null && this.thread?.id) return;
		if (this.initializing) return this.initializing;
		this.initializing = this.start(timeoutMs, signal).catch(async (error) => {
			await this.stop();
			throw error;
		}).finally(() => {
			this.initializing = null;
		});
		return this.initializing;
	}

	private async start(timeoutMs: number, signal?: AbortSignal): Promise<void> {
		if (!existsSync(this.codexBin)) throw new ComputerUseError(`Codex app-server binary not found: ${this.codexBin}`);
		const args = ["app-server"];
		for (const flag of FEATURE_FLAGS) args.push("--enable", flag);
		this.proc = spawn(this.codexBin, args, {
			cwd: this.cwd,
			env: process.env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.proc.stdout.setEncoding("utf8");
		this.proc.stderr.setEncoding("utf8");
		this.proc.stdout.on("data", (chunk) => this.onStdout(String(chunk)));
		this.proc.stderr.on("data", (chunk) => {
			this.stderr += String(chunk);
			if (this.stderr.length > 20_000) this.stderr = this.stderr.slice(-20_000);
		});
		this.proc.on("exit", (code, exitSignal) => this.onExit(code, exitSignal));
		this.proc.on("error", (error) => this.onExit(null, null, error));
		if (this.proc.pid) {
			this.processRecord = writeProcessRecord(this.cwd, this.codexBin, this.proc.pid);
			this.watchdog = startWatchdog(this.processRecord);
		}

		this.initialized = await this.request("initialize", {
			clientInfo: { name: "pi-macuse-computer-use", version: VERSION },
			capabilities: { experimentalApi: true, requestAttestation: false },
		}, Math.min(timeoutMs, 15_000), signal);
		this.notify("notifications/initialized");
		await this.verifyComputerUseInventory(Math.min(Math.max(timeoutMs, 10_000), 30_000), signal);
		const threadStart = await this.request("thread/start", {
			cwd: this.cwd,
			ephemeral: true,
			approvalPolicy: "on-request",
			sandbox: "workspace-write",
			config: {
				features: {
					computer_use: true,
					plugins: true,
					tool_call_mcp_elicitation: true,
				},
			},
		}, Math.min(Math.max(timeoutMs, 45_000), 120_000), signal);
		const thread = isRecord(threadStart) && isRecord(threadStart.thread) ? threadStart.thread : null;
		if (typeof thread?.id !== "string") throw new ComputerUseError("thread/start response did not include thread.id", threadStart);
		this.thread = thread as AppServerThread;
	}

	private async verifyComputerUseInventory(timeoutMs: number, signal?: AbortSignal): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		let cursor: string | null = null;
		let inventory: ComputerUseInventory = { present: false, authStatus: null, toolNames: [], toolCount: 0, missingTools: [...UPSTREAM_COMPUTER_USE_TOOLS], checkedAt: null };
		for (let page = 0; page < 10; page += 1) {
			const remaining = Math.max(1_000, deadline - Date.now());
			if (remaining <= 1_000 && page > 0) break;
			const params: Record<string, unknown> = { detail: "toolsAndAuthOnly", limit: 100 };
			if (cursor) params.cursor = cursor;
			const status = await this.request("mcpServerStatus/list", params, Math.min(remaining, 10_000), signal);
			inventory = mergeComputerUseInventories(inventory, summarizeComputerUseInventory(status));
			const nextCursor = isRecord(status) && typeof status.nextCursor === "string" ? status.nextCursor : null;
			if (inventory.present || !nextCursor) break;
			cursor = nextCursor;
		}
		this.computerUseInventory = inventory;
		if (!inventory.present) throw new ComputerUseError("Codex app-server did not list the computer-use MCP server.", inventory);
		if (inventory.missingTools.length > 0) throw new ComputerUseError(`Computer Use MCP server is missing required tools: ${inventory.missingTools.join(", ")}`, inventory);
	}

	private onStdout(chunk: string): void {
		this.buffer += chunk;
		for (;;) {
			const idx = this.buffer.indexOf("\n");
			if (idx === -1) break;
			const line = this.buffer.slice(0, idx).trim();
			this.buffer = this.buffer.slice(idx + 1);
			if (line) this.onLine(line);
		}
	}

	private onLine(line: string): void {
		const message = parseJsonMessage(line);
		if (!message) {
			this.stderr += `\n[invalid app-server JSON] ${line.slice(0, 500)}`;
			return;
		}
		const id: JsonRpcId | null = typeof message.id === "number" || typeof message.id === "string" ? message.id : null;
		const pendingId = typeof id === "number" ? id : null;
		if (pendingId !== null && (Object.prototype.hasOwnProperty.call(message, "result") || Object.prototype.hasOwnProperty.call(message, "error")) && this.pending.has(pendingId)) {
			const pending = this.pending.get(pendingId)!;
			clearTimeout(pending.timer);
			if (pending.onAbort) pending.onAbort();
			this.pending.delete(pendingId);
			const errorText = message.error ? String(message.error.message || "JSON-RPC error") : "";
			if (message.error) pending.reject(new ComputerUseError(`${pending.method} failed: ${errorText}`, message.error));
			else pending.resolve(message.result);
			return;
		}
		if (id !== null && typeof message.method === "string") {
			this.onServerRequest({ ...message, id, method: message.method });
			return;
		}
		if (typeof message.method === "string") {
			this.notifications.push({ method: message.method, params: message.params });
			if (this.notifications.length > 50) this.notifications.shift();
		}
	}

	private onServerRequest(request: JsonRpcMessage & { id: JsonRpcId; method: string }): void {
		if (request.method === "mcpServer/elicitation/request") {
			this.elicitationCount += 1;
			const decision = this.decideElicitation();
			this.write({ jsonrpc: "2.0", id: request.id, result: decision });
			return;
		}
		this.write({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: `pi macuse bridge does not implement ${request.method}` } });
	}

	private decideElicitation() {
		if (this.currentApproval === "inherit" || this.currentApproval === "accept-all") {
			this.acceptedElicitations += 1;
			return { action: "accept", content: {}, _meta: null };
		}
		if (this.currentApproval === "accept-once" && this.acceptedThisCall < 1) {
			this.acceptedThisCall += 1;
			this.acceptedElicitations += 1;
			return { action: "accept", content: {}, _meta: null };
		}
		return { action: "decline", content: null, _meta: null };
	}

	private onExit(code: number | null, signal: NodeJS.Signals | null, error?: Error): void {
		const message = error?.message || `Codex app-server exited code=${code} signal=${signal}`;
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			if (pending.onAbort) pending.onAbort();
			pending.reject(new ComputerUseError(message));
		}
		this.pending.clear();
		this.proc = null;
		this.thread = null;
		this.initialized = null;
		this.computerUseInventory = null;
		if (this.processRecord) safeUnlink(this.processRecord.pidFile);
		this.processRecord = null;
		this.watchdog = null;
	}

	private write(message: unknown): void {
		if (!this.proc || !this.proc.stdin.writable) throw new ComputerUseError("Codex app-server stdin is not writable");
		this.proc.stdin.write(`${JSON.stringify(message)}\n`);
	}

	private notify(method: string, params: Record<string, unknown> = {}): void {
		this.write({ jsonrpc: "2.0", method, params });
	}

	private request(method: string, params: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
		const id = this.nextId++;
		return new Promise<unknown>((resolve, reject) => {
			let onAbort: (() => void) | undefined;
			const cleanup = () => {
				clearTimeout(timer);
				if (onAbort) signal?.removeEventListener("abort", onAbort);
			};
			const timer = setTimeout(() => {
				this.pending.delete(id);
				if (onAbort) signal?.removeEventListener("abort", onAbort);
				reject(new ComputerUseError(`${method} timed out after ${timeoutMs}ms`, { method, id }));
			}, timeoutMs);
			onAbort = () => {
				this.pending.delete(id);
				cleanup();
				reject(new ComputerUseError(`${method} was aborted`, { method, id }));
			};
			if (signal?.aborted) {
				cleanup();
				reject(new ComputerUseError(`${method} was aborted`, { method, id }));
				return;
			}
			signal?.addEventListener("abort", onAbort, { once: true });
			this.pending.set(id, { resolve, reject, timer, method, onAbort: cleanup });
			try {
				this.write({ jsonrpc: "2.0", id, method, params });
			} catch (error: unknown) {
				this.pending.delete(id);
				cleanup();
				reject(error);
			}
		});
	}

	async callTool(tool: string, args: Record<string, JsonValue>, opts: { approval: ApprovalMode; timeoutMs: number; signal?: AbortSignal }): Promise<{ result: ComputerUseToolResult; durationMs: number; acceptedElicitations: number; elicitationCount: number }> {
		return this.runExclusive(async () => {
			await this.ensureReady(opts.timeoutMs, opts.signal);
			const acceptedBefore = this.acceptedElicitations;
			const elicitationBefore = this.elicitationCount;
			this.currentApproval = opts.approval;
			this.acceptedThisCall = 0;
			const started = Date.now();
			try {
				const threadId = this.thread?.id;
				if (!threadId) throw new ComputerUseError("Codex app-server thread is not ready.");
				const result = await this.request("mcpServer/tool/call", {
					threadId,
					server: "computer-use",
					tool,
					arguments: args,
				}, opts.timeoutMs, opts.signal) as ComputerUseToolResult;
				return {
					result,
					durationMs: Date.now() - started,
					acceptedElicitations: this.acceptedElicitations - acceptedBefore,
					elicitationCount: this.elicitationCount - elicitationBefore,
				};
			} finally {
				this.currentApproval = "inherit";
				this.acceptedThisCall = 0;
			}
		});
	}

	async stop(): Promise<void> {
		const proc = this.proc;
		const record = this.processRecord;
		this.proc = null;
		this.thread = null;
		this.initialized = null;
		this.computerUseInventory = null;
		this.processRecord = null;
		this.watchdog = null;
		if (record) safeUnlink(record.pidFile);
		if (!proc) return;
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			if (pending.onAbort) pending.onAbort();
			pending.reject(new ComputerUseError("Codex app-server stopped by macuse"));
		}
		this.pending.clear();
		if (proc.exitCode !== null || proc.signalCode !== null) return;
		const pid = proc.pid;
		if (pid) killProcessTree(pid, "SIGTERM");
		else proc.kill("SIGTERM");
		await new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				if (proc.exitCode === null && proc.signalCode === null) {
					if (pid) killProcessTree(pid, "SIGKILL");
					else proc.kill("SIGKILL");
				}
				resolve();
			}, 3_000);
			proc.once("exit", () => {
				clearTimeout(timer);
				resolve();
			});
		});
	}

	async restart(): Promise<void> {
		await this.stop();
	}
}

function isWaitTool(tool: string): boolean {
	return WAIT_TOOLS.has(tool);
}

function validateWaitArguments(tool: string, args: Record<string, JsonValue>): void {
	if (typeof args.app !== "string") throw new Error(`${tool} requires an app argument or sequence-level app default.`);
	if (tool === "waitForText" && typeof args.text !== "string") throw new Error("waitForText requires arguments.text.");
	if (tool === "waitForURL" && typeof args.url !== "string") throw new Error("waitForURL requires arguments.url.");
	if (tool === "waitForTitle" && typeof args.title !== "string") throw new Error("waitForTitle requires arguments.title.");
	if (["waitForElement", "waitUntilElementEnabled", "waitUntilElementDisabled"].includes(tool) && !hasElementTarget(args) && !Array.isArray(args.targets)) throw new Error(`${tool} requires an element target such as elementId, elementDescription, role/name, or targets.`);
}

function waitConditionMet(tool: string, args: Record<string, JsonValue>, result: FilteredToolResult, cache: Map<string, ElementInfo[]>): string | null {
	const app = typeof args.app === "string" ? args.app : "";
	const summary = stateSummary(result.content);
	const visible = visibleAssertionValues(result.content);
	const raw = normalizeAssertionText(assertionContentText(result.content));
	const scopeHaystack = normalizeAssertionText([summary.title, summary.url, ...visible, raw].filter(Boolean).join("\n"));
	if (typeof args.title === "string" && !scopeHaystack.includes(normalizeAssertionText(args.title))) return null;
	if (typeof args.url === "string" && !scopeHaystack.includes(normalizeAssertionText(args.url))) return null;
	if (tool === "waitForText") {
		if (typeof args.text !== "string") throw new Error("waitForText requires arguments.text.");
		const expected = normalizeAssertionText(args.text);
		if (visible.some((value) => value.includes(expected))) return `waitForText matched visible text ${JSON.stringify(args.text)}${typeof args.title === "string" ? ` with title ${JSON.stringify(args.title)}` : ""}${typeof args.url === "string" ? ` with URL ${JSON.stringify(args.url)}` : ""}`;
		if (args.visibleOnly === true) return null;
		return raw.includes(expected) ? `waitForText matched raw app content text/value ${JSON.stringify(args.text)}${typeof args.title === "string" ? ` with title ${JSON.stringify(args.title)}` : ""}${typeof args.url === "string" ? ` with URL ${JSON.stringify(args.url)}` : ""}` : null;
	}
	if (tool === "waitForURL") {
		if (typeof args.url !== "string") throw new Error("waitForURL requires arguments.url.");
		return summary.url && summary.url.includes(args.url) ? `waitForURL matched ${JSON.stringify(args.url)} at ${summary.url}` : null;
	}
	if (tool === "waitForTitle") {
		if (typeof args.title !== "string") throw new Error("waitForTitle requires arguments.title.");
		return summary.title && summary.title.includes(args.title) ? `waitForTitle matched ${JSON.stringify(args.title)} at ${summary.title}` : null;
	}
	let resolved = resolveElementTargetFallbacks(args, cache);
	resolved = resolveElementId(resolved, cache);
	resolved = resolveElementDescription(resolved, cache);
	resolved = resolveElementRoleName(resolved, cache);
	validateIndexedTarget(resolved, cache, hasStableSelector(args));
	const element = (cache.get(app) ?? []).find((item) => item.index === resolved.element_index);
	if (!element) return null;
	if (tool === "waitUntilElementEnabled" && element.disabled) return null;
	if (tool === "waitUntilElementDisabled" && !element.disabled) return null;
	return `${tool} matched element_index ${element.index} (${elementLineWithTargetHint(element)})`;
}

async function runWaitStep(step: SequenceStep, args: Record<string, JsonValue>, opts: { approval: ApprovalMode; timeoutMs: number; maxTextChars: number; signal?: AbortSignal; cache: Map<string, ElementInfo[]>; beforeState: StateSummary | null; scope: TargetScope }): Promise<{ result: FilteredToolResult; durationMs: number; targetResolution?: string; elements: MachineElement[]; visibleText: string[]; changed: ChangeSummary | null; nextActions: string[] }> {
	validateWaitArguments(step.tool, args);
	const started = Date.now();
	const waitTimeoutMs = asInt(args.timeoutMs, opts.timeoutMs);
	const perPollToolTimeoutMs = asInt(args.toolTimeoutMs, opts.timeoutMs);
	const deadline = started + waitTimeoutMs;
	const intervalMs = Math.max(100, Math.min(asInt(args.intervalMs, 750), 10_000));
	let last: FilteredToolResult | null = null;
	let lastMessage = "condition did not match";
	for (;;) {
		const remainingMs = deadline - Date.now();
		if (remainingMs < 1_000) break;
		const callTimeoutMs = Math.max(1_000, Math.min(perPollToolTimeoutMs, remainingMs));
		const call = await client.callTool("get_app_state", { app: args.app }, { approval: opts.approval, timeoutMs: callTimeoutMs, signal: opts.signal });
		const result = filterToolResult(call.result, { maxTextChars: opts.maxTextChars });
		appendComputerUseDiagnostic(result, "get_app_state", { app: args.app });
		updateElementCache(opts.cache, args.app, result.content);
		updateElementCache(sessionElementCache, args.app, result.content);
		last = result;
		try {
			const matched = waitConditionMet(step.tool, args, result, opts.cache);
			if (matched) {
				appendText(result, matched);
				const after = stateSummary(result.content, opts.scope);
				return { result, durationMs: Date.now() - started, targetResolution: matched, elements: machineElements(result.content, opts.scope), visibleText: after.visibleText, changed: compareState(opts.beforeState, after), nextActions: [] };
			}
		} catch (error) {
			lastMessage = errorMessage(error);
			if (lastMessage.includes("Stale element_index")) throw error;
		}
		const sleepMs = Math.min(intervalMs, deadline - Date.now());
		if (sleepMs <= 0) break;
		await new Promise((resolve) => setTimeout(resolve, sleepMs));
	}
	const message = `${step.tool} timed out after ${waitTimeoutMs}ms: ${lastMessage}. Next action: re-run codex_cu_get_app_state with detail:"minimal" for ${args.app}. Transport get_app_state calls used up to ${perPollToolTimeoutMs}ms each, with the final sub-1000ms remainder handled by the wait predicate instead of issuing a tiny transport call.`;
	if (last) appendText(last, message);
	else last = failureResult(message, opts.maxTextChars);
	last.isError = true;
	throw new ComputerUseError(message, last);
}

function normalizeSequenceSteps(value: unknown): SequenceStep[] {
	if (!Array.isArray(value) || value.length === 0) throw new Error("codex_cu_sequence requires at least one step.");
	return value.map((step, index) => {
		if (!isRecord(step)) throw new Error(`sequence step ${index} must be an object.`);
		if (typeof step.tool !== "string" || step.tool.length === 0) throw new Error(`sequence step ${index} requires a non-empty tool string.`);
		const rawArgs = step.arguments ?? {};
		if (!isRecord(rawArgs)) throw new Error(`sequence step ${index} arguments must be an object.`);
		const args = { ...(rawArgs as Record<string, JsonValue>) };
		if (step.tool === "set_value" && args.value === undefined && step.value !== undefined) args.value = step.value as JsonValue;
		return {
			tool: step.tool,
			arguments: args,
			label: typeof step.label === "string" ? step.label : undefined,
			expectText: normalizeStringList(step.expectText, `sequence step ${index} expectText`),
			expectAbsentText: normalizeStringList(step.expectAbsentText, `sequence step ${index} expectAbsentText`),
			expectVisibleText: normalizeStringList(step.expectVisibleText, `sequence step ${index} expectVisibleText`),
			allowError: step.allowError === true,
			requireStateChange: step.requireStateChange === true,
		};
	});
}

function validateStepResult(step: SequencedResult): void {
	const stepNumber = step.index + 1;
	if (step.result.isError && !step.allowError) {
		const resultText = toolResultText(step.result);
		const reason = resultText.includes("actionDispatchedButNoStateChange")
			? "did not produce an observable state change required by requireStateChange"
			: "returned tool error";
		throw new ComputerUseError(`sequence step ${stepNumber} (index ${step.index}) ${step.tool} ${reason}`, step.result);
	}
	const text = normalizeAssertionText(assertionContentText(step.result.content));
	const fullText = normalizeAssertionText(toolResultText(step.result));
	for (const rawExpected of step.expectText || []) {
		const expected = normalizeAssertionText(rawExpected);
		if (!text.includes(expected)) {
			const metadataOnly = fullText.includes(expected);
			throw new ComputerUseError(`sequence step ${stepNumber} (index ${step.index}) ${step.tool} missing expected app content text: ${rawExpected}${metadataOnly ? "; expected text matched only macuse/upstream metadata, not app content. Use expectVisibleText for UI-visible assertions." : ""}`, { expected: rawExpected, normalizedExpected: expected, metadataOnly, textPreview: truncateString(text, 1000) });
		}
	}
	for (const rawUnexpected of step.expectAbsentText || []) {
		const unexpected = normalizeAssertionText(rawUnexpected);
		if (text.includes(unexpected)) throw new ComputerUseError(`sequence step ${stepNumber} (index ${step.index}) ${step.tool} contained forbidden app content text: ${rawUnexpected}`, { unexpected: rawUnexpected, normalizedUnexpected: unexpected, textPreview: truncateString(text, 1000) });
	}
	if (step.expectVisibleText.length > 0) {
		const visible = visibleAssertionValues(step.result.content);
		for (const rawExpected of step.expectVisibleText) {
			const expected = normalizeAssertionText(rawExpected);
			if (!visible.some((value) => value.includes(expected))) throw new ComputerUseError(`sequence step ${stepNumber} (index ${step.index}) ${step.tool} missing expected visible text: ${rawExpected}`, { expected: rawExpected, visibleText: visible, note: "expectVisibleText matches visible text, window titles, and visible control labels as substrings; use a more specific expected string when duplicates matter." });
		}
	}
}

function assertionSummary(step: SequencedResult): string | null {
	const text = normalizeAssertionText(assertionContentText(step.result.content));
	const lines: string[] = [];
	for (const rawExpected of step.expectText) {
		const expected = normalizeAssertionText(rawExpected);
		const matchingLine = text.split("\n").find((line) => line.includes(expected));
		const snippet = matchingLine ? truncateString(matchingLine.replace(/\s+/g, " ").trim(), 160) : "";
		lines.push(`expectText passed: ${JSON.stringify(rawExpected)}${snippet ? `; matched line: ${JSON.stringify(snippet)}` : ""}`);
	}
	for (const rawUnexpected of step.expectAbsentText) lines.push(`expectAbsentText passed: ${JSON.stringify(rawUnexpected)} absent`);
	const visible = visibleAssertionValues(step.result.content);
	for (const rawExpected of step.expectVisibleText) lines.push(`expectVisibleText passed: ${JSON.stringify(rawExpected)}${visible.length > 0 ? `; visible text: ${JSON.stringify(visible.join(" | "))}` : ""}`);
	return lines.length > 0 ? lines.join("\n") : null;
}

function sequenceTargetMethod(step: SequencedResult): string {
	if (step.tool === "get_app_state" || isWaitTool(step.tool)) return "read-only";
	const resolution = step.targetResolution ?? "";
	if (resolution.includes("targets[")) return "targets fallback";
	if (resolution.includes("elementId")) return "elementId";
	if (resolution.includes("elementDescription")) return "elementDescription";
	if (resolution.includes("role=") && resolution.includes("name=")) return "role/name";
	if (resolution.includes("element_index")) return "element_index";
	if (step.tool === "press_key" || step.tool === "type_text") return "keyboard/text";
	return "none";
}

function sequenceRunSummary(steps: SequencedResult[], failed: SequenceFailure | null, focus?: FocusSnapshot, mousePreservation?: { before: MousePosition; after: MousePosition | null; restored: boolean }): string {
	const apps = [...new Set(steps.map((step) => typeof step.arguments.app === "string" ? step.arguments.app : null).filter((app): app is string => Boolean(app)))];
	const actionSteps = steps.filter((step) => !READ_ONLY_TOOLS.has(step.tool));
	const finalStep = [...steps].reverse().find((step) => step.visibleText.length > 0) ?? steps.at(-1);
	const finalVisible = finalStep?.visibleText.slice(0, 8) ?? [];
	const tagMatches = steps.flatMap((step) => [...(step.targetResolution?.matchAll(/tags=\[(.*?)\]/g) ?? [])].map((match) => match[1] ?? ""));
	const tags = [...new Set(tagMatches.flatMap((match) => match.split(",").map((item) => item.replace(/["\s]/g, "")).filter(Boolean)))];
	const readbackDrift = steps
		.filter((step, index) => index > 0 && step.tool === "get_app_state" && Boolean(step.changed?.visibleTextChanged))
		.slice(0, 3)
		.map((step) => `step ${step.index + 1} readback changed visible text`);
	const lines = [
		"Run summary:",
		`- apps: ${apps.length ? apps.join(", ") : "<none>"}`,
		`- actions: ${actionSteps.length ? actionSteps.map((step) => `${step.index + 1}:${step.tool}/${sequenceTargetMethod(step)}`).join(", ") : "none (read-only)"}`,
		`- safety tags on resolved targets: ${tags.length ? tags.join(", ") : "none reported"}`,
		`- final visible text: ${finalVisible.length ? JSON.stringify(finalVisible.join(" | ")) : "<none parsed>"}`,
		...(focus ? [`- focus: before=${focus.before?.map((app) => app.name).join(", ") || "<unknown>"}; after=${focus.after?.map((app) => app.name).join(", ") || "<unknown>"}; changed=${focus.changed ?? "unknown"}`] : []),
		...(mousePreservation ? [`- mouse: restored=${mousePreservation.restored}`] : []),
		...(failed ? [`- failure: step ${failed.stepNumber} ${failed.tool}: ${failed.message}`] : []),
		...(readbackDrift.length ? [`- anomaly hints: ${readbackDrift.join("; ")}`] : []),
	];
	return lines.join("\n");
}

function sequenceContent(steps: SequencedResult[], includeImages = false, failed: SequenceFailure | null = null, totalSteps = steps.length, detail: DetailMode = "compact", maxTextChars = DEFAULT_MAX_TEXT_CHARS, focus?: FocusSnapshot, targetApp?: string, mousePreservation?: { before: MousePosition; after: MousePosition | null; restored: boolean }): ContentBlock[] {
	if (steps.length === 0) return [{ type: "text", text: "Computer Use sequence returned no steps." }];
	const completedStepCount = failed ? failed.index : steps.length;
	const summary = failed
		? `Sequence failed at step ${failed.stepNumber} of ${totalSteps} (index ${failed.index}, ${failed.tool}). Completed ${completedStepCount} step${completedStepCount === 1 ? "" : "s"}. To resume, start a new sequence from step index ${failed.index} against current app state.`
		: `Sequence completed ${steps.length} of ${totalSteps} step${totalSteps === 1 ? "" : "s"}.`;
	const focusLine = focus ? `\n${focusSummaryText(focus, targetApp)}` : "";
	const mouseLine = mousePreservation ? `\nMouse preservation: before=(${mousePreservation.before.x},${mousePreservation.before.y}); after=(${mousePreservation.after?.x ?? "unknown"},${mousePreservation.after?.y ?? "unknown"}); restored=${mousePreservation.restored}` : "";
	const runSummary = sequenceRunSummary(steps, failed, focus, mousePreservation);
	const orderedSteps = failed ? [steps[failed.index], ...steps.filter((step) => step.index !== failed.index)].filter((step): step is SequencedResult => Boolean(step)) : steps;
	const stepText = orderedSteps.map((step) => {
		const header = `Step ${step.index + 1} (index ${step.index}): ${step.tool} (${step.durationMs}ms, isError=${step.result.isError}, elicitations=${step.elicitationCount}, accepted=${step.acceptedElicitations})`;
		const diagnostics = [
			step.targetResolution,
			...step.targetWarnings.map((warning) => `warning: ${warning}`),
			...(step.changed?.summary ?? []).map((line) => `changed: ${line}`),
			...step.nextActions.map((action) => `next: ${action}`),
		].filter(Boolean);
		if (detail === "minimal" && !step.result.isError) {
			const assertions = assertionSummary(step);
			const lines = [...diagnostics, assertions].filter(Boolean);
			return lines.length > 0 ? `${header}\n${lines.join("\n")}` : header;
		}
		const shouldShowBody = detail !== "minimal" || step.result.isError;
		return shouldShowBody ? `${header}\n${[...diagnostics, summarizeContent(step.result.content)].filter(Boolean).join("\n")}` : `${header}${diagnostics.length ? `\n${diagnostics.join("\n")}` : ""}`;
	}).join("\n\n---\n\n");
	const text = failed ? `${summary}${focusLine}${mouseLine}\n\n${stepText}\n\n${runSummary}` : `${summary}${focusLine}${mouseLine}\n\n${runSummary}\n\n${stepText}`;
	const content: ContentBlock[] = [{ type: "text", text: truncateString(text, maxTextChars) }];
	if (includeImages) {
		for (const step of steps) {
			for (const block of step.result.content || []) {
				if (block.type === "image") content.push(block);
			}
		}
	}
	return content;
}

const timeoutParam = Type.Optional(Type.Number({ minimum: 1_000, maximum: 300_000, description: "Tool timeout in milliseconds. Default 90000." }));
const maxTextParam = Type.Optional(Type.Number({ minimum: 1_000, maximum: 200_000, description: "Maximum characters per returned text block. Default 20000." }));
const approvalParam = Type.Optional(StringEnum(["inherit", "accept-all", "accept-once", "deny"] as const, { description: "How to answer Computer Use app-approval prompts. Default inherit, which auto-accepts app approvals to match Codex's Any App setting." }));
const detailParam = Type.Optional(StringEnum(["minimal", "compact", "full"] as const, { description: "Output detail. minimal returns app/window, visible text, and concise target hints; compact trims accessibility trees to interactive element lines; full returns the raw Computer Use text." }));

const client = new AppServerClient();
const sessionElementCache = new Map<string, ElementInfo[]>();

export default function (pi: ExtensionAPI) {
	pi.on("session_shutdown", async () => {
		sessionElementCache.clear();
		await client.stop();
	});

	pi.registerCommand("macuse-status", {
		description: "Show Codex Computer Use persistent app-server status",
		handler: async (_args, ctx) => {
			const status = client.status();
			const reaped = status.staleReapSummary.filter((item) => item.action === "reaped-orphan").length;
			const computerUse = status.computerUse ? ` computer-use=${status.computerUse.present ? `${status.computerUse.toolCount} tools` : "missing"}${status.computerUse.missingTools.length ? ` missing=${status.computerUse.missingTools.join(",")}` : ""}` : "";
			ctx.ui.notify(`macuse ${status.running ? "running" : "stopped"}${status.threadId ? ` thread=${status.threadId}` : ""}${status.processPid ? ` pid=${status.processPid}` : ""}${status.watchdogPid ? ` watchdog=${status.watchdogPid}` : ""}${computerUse}${reaped ? ` reaped=${reaped}` : ""}`, status.running ? "info" : "warning");
		},
	});

	pi.registerCommand("macuse-stop", {
		description: "Stop the persistent Codex Computer Use app-server session; it restarts lazily on the next macuse tool call",
		handler: async (_args, ctx) => {
			sessionElementCache.clear();
			await client.stop();
			ctx.ui.notify("macuse Computer Use app-server stopped; it will restart lazily on the next tool call.", "info");
		},
	});

	pi.registerCommand("macuse-restart", {
		description: "Restart the persistent Codex Computer Use app-server session",
		handler: async (_args, ctx) => {
			sessionElementCache.clear();
			await client.restart();
			ctx.ui.notify("macuse Computer Use app-server stopped; it will restart on the next tool call.", "info");
		},
	});

	pi.registerTool({
		name: "codex_cu_list_apps",
		label: "Codex CU List Apps",
		description: "Read-only: list apps known to OpenAI Codex Computer Use through a persistent Codex app-server session. Use runningOnly:true to return only currently running apps, and filter to substring-match app names, paths, or bundle IDs.",
		promptSnippet: "List local macOS apps available to Codex Computer Use.",
		promptGuidelines: [
			"Use codex_cu_list_apps to discover the exact app name, bundle ID, or path before using codex_cu_get_app_state.",
			"codex_cu_list_apps is read-only; it does not click, type, drag, scroll, or mutate GUI state.",
		],
		parameters: Type.Object({
			runningOnly: Type.Optional(Type.Boolean({ description: "Return only currently running apps. Default false." })),
			filter: Type.Optional(Type.String({ description: "Optional case-insensitive substring filter across each app list line." })),
			maxTextChars: maxTextParam,
			toolTimeoutMs: timeoutParam,
		}),
		async execute(_toolCallId, params, signal, onUpdate) {
			const input = params as ListAppsParams;
			onUpdate?.({ content: [{ type: "text", text: "Calling persistent Codex Computer Use list_apps..." }] });
			const toolTimeoutMs = asInt(input.toolTimeoutMs, DEFAULT_TOOL_TIMEOUT_MS);
			const maxTextChars = asInt(input.maxTextChars, DEFAULT_MAX_TEXT_CHARS);
			const call = await client.callTool("list_apps", {}, { approval: "inherit", timeoutMs: toolTimeoutMs, signal });
			const result = filterToolResult(call.result, { maxTextChars });
			const appMetadata = parseAppListContent(result.content, { runningOnly: Boolean(input.runningOnly), filter: input.filter });
			const outputContent = filterAppListContent(result.content, { runningOnly: Boolean(input.runningOnly), filter: input.filter, maxTextChars });
			return {
				content: outputContent,
				details: bridgeDetails({
					tool: "list_apps",
					threadId: client.status().threadId,
					isError: result.isError,
					omittedImages: result.omittedImages,
					runningOnly: Boolean(input.runningOnly),
					filter: input.filter ?? null,
					apps: appMetadata,
					frontmostApps: appMetadata.filter((app) => app.frontmost),
					acceptedElicitations: call.acceptedElicitations,
					elicitationCount: call.elicitationCount,
					durationMs: call.durationMs,
				}, client.status().stderrTail),
			};
		},
	});

	pi.registerTool({
		name: "codex_cu_get_app_state",
		label: "Codex CU Get App State",
		description: "Read-only: get a target macOS app's accessibility tree and optional screenshot through persistent OpenAI Codex Computer Use. Pass detail:'minimal' for app/window/display summary plus concise target hints, detail:'compact' for grouped interactive elements, or detail:'full' for the raw tree. targetScope:'main' suppresses likely chrome/window targets in transformed output.",
		promptSnippet: "Inspect a local macOS app window with Codex Computer Use.",
		promptGuidelines: [
			"Use codex_cu_get_app_state for read-only inspection of a local macOS app when file, CLI, or browser tools are insufficient.",
			"App approval defaults to inherit, matching Codex's Any App setting by auto-accepting app approvals.",
			"Use codex_cu_sequence for mutating Computer Use actions, with before/after get_app_state evidence, allowMutating=true, and a concrete safetyNote.",
		],
		parameters: Type.Object({
			app: Type.String({ description: "App name, full app path, or unambiguous bundle identifier, e.g. Calculator or com.apple.calculator." }),
			approval: approvalParam,
			includeImage: Type.Optional(Type.Boolean({ description: "Attach the screenshot image returned by Computer Use when the current model/host supports image blocks. Use saveImagePath for reliable screenshot artifacts. Default false to keep turns light." })),
			saveImagePath: Type.Optional(Type.String({ description: "Optional filesystem path where the screenshot should be saved." })),
			detail: detailParam,
			targetScope: Type.Optional(StringEnum(["all", "main"] as const, { description: "Output target scope. all includes app/window/chrome targets; main prioritizes likely app/page content controls." })),
			maxTextChars: maxTextParam,
			toolTimeoutMs: timeoutParam,
		}),
		async execute(_toolCallId, params, signal, onUpdate) {
			const input = params as GetAppStateParams;
			const app = input.app;
			const approval = input.approval || "inherit";
			onUpdate?.({ content: [{ type: "text", text: `Calling persistent Computer Use get_app_state for ${app} with approval=${approval}...` }] });
			const toolTimeoutMs = asInt(input.toolTimeoutMs, DEFAULT_TOOL_TIMEOUT_MS);
			const maxTextChars = asInt(input.maxTextChars, DEFAULT_MAX_TEXT_CHARS);
			const detail = normalizeDetail(input.detail, "full");
			const targetScope: TargetScope = input.targetScope === "main" ? "main" : "all";
			const frontmostBefore = await captureFocusSnapshot(approval, toolTimeoutMs, maxTextChars, signal);
			const call = await client.callTool("get_app_state", { app }, { approval, timeoutMs: toolTimeoutMs, signal });
			const frontmostAfter = await captureFocusSnapshot(approval, toolTimeoutMs, maxTextChars, signal);
			const result = filterToolResult(call.result, {
				includeImage: Boolean(input.includeImage),
				saveImagePath: input.saveImagePath,
				maxTextChars,
			});
			updateElementCache(sessionElementCache, app, result.content);
			const diagnostics = [appendComputerUseDiagnostic(result, "get_app_state", { app })].filter((item): item is string => Boolean(item));
			if (detail === "full") appendElementStabilityNote(result);
			appendImageWarning(result, { includeImage: Boolean(input.includeImage), saveImagePath: input.saveImagePath });
			const focus = focusSnapshot(frontmostBefore, frontmostAfter);
			const transformedContent = detail === "minimal" ? minimalContent(result.content, targetScope) : detail === "compact" ? compactContent(result.content, targetScope) : result.content;
			const outputContent = truncateTextContent([...transformedContent, { type: "text", text: focusSummaryText(focus, app) }], maxTextChars);
			return {
				content: outputContent,
				details: bridgeDetails({
					tool: "get_app_state",
					app,
					threadId: client.status().threadId,
					isError: result.isError,
					omittedImages: result.omittedImages,
					savedImagePath: result.savedImagePath,
					savedImageArtifact: result.savedImageArtifact,
					imageSupportNote: input.includeImage ? "Image rendering is model/host dependent; saveImagePath is the reliable screenshot artifact path." : null,
					detail,
					targetScope,
					...stateSummary(result.content, targetScope),
					focus,
					diagnostics,
					elements: machineElements(result.content, targetScope),
					acceptedElicitations: call.acceptedElicitations,
					elicitationCount: call.elicitationCount,
					durationMs: call.durationMs,
				}, client.status().stderrTail),
			};
		},
	});

	pi.registerTool({
		name: "codex_cu_sequence",
		label: "Codex CU Sequence",
		description: "Run Codex Computer Use calls in one persistent app-server thread. Valid tools: list_apps, get_app_state, perform_secondary_action, press_key, type_text, set_value, select_text, scroll, click, drag, waitForText, waitForURL, waitForTitle, waitForElement, waitUntilElementEnabled, waitUntilElementDisabled. Element targets use element_index as a string; numbers are coerced, element is accepted as an alias, elementId resolves IDs like One or AllClear, elementDescription exact-matches descriptions like Add, and role/name selectors match parsed accessibility targets. Example step: {tool:'perform_secondary_action', arguments:{app:'Calculator', role:'button', name:'Add', action:'Press'}}.",
		promptSnippet: "Run a sequence of local macOS Computer Use actions.",
		promptGuidelines: [
			"Use codex_cu_sequence only after codex_cu_get_app_state has identified the target app/window or when the first sequence step is get_app_state.",
			"For mutating codex_cu_sequence steps, keep the flow narrow, include an explicit safetyNote, set allowMutating=true, and stop before purchases, sends, deletes, credential changes, account/security/privacy changes, or ambiguous windows.",
			"App approval defaults to inherit, matching Codex's Any App setting by auto-accepting app approvals.",
			"Prefer perform_secondary_action with action=Press, press_key, set_value, select_text, or element-targeted scroll over pointer click when possible to preserve mouse/system focus.",
			"press_key uses xdotool-style key names. Examples: '5', 'Return', 'Escape', 'Tab', 'space', 'plus', 'minus', 'equal', 'ctrl+c'. For text entry, prefer type_text unless a real key event is required.",
			"select_text requires a text string to match; start/end offset selection is not supported by the upstream Computer Use tool.",
			"For element targeting, prefer stable elementId values from get_app_state when present, then elementDescription exact matches, then element_index. Numeric indices can shift after mutations; the extension refreshes before element-targeted sequence steps, but description/ID targeting is still safer.",
			"For dynamic controls, codex_cu_sequence steps may use arguments.targets with fallback target objects, such as [{elementId:'AllClear'},{elementDescription:'Clear'}]; the extension resolves the first currently valid target before calling Computer Use.",
		],
		parameters: Type.Object({
			app: Type.Optional(Type.String({ description: "Optional default app name/bundle/path applied to steps whose arguments omit app." })),
			steps: Type.Array(Type.Any({ description: "Ordered Computer Use tool calls. Each step must be an object with tool, optional arguments, optional label, expectText, expectAbsentText, expectVisibleText, allowError, and optional requireStateChange. Element-targeted tools accept element_index as string or number, element as an alias, elementId/element_id, elementDescription/element_description, role/name selectors, or arguments.targets fallback objects; raw index targets may pass expectedRole/expectedName/expectedDescription/expectedId/expectedValue for stale-target guards. Wait helpers accept timeoutMs, intervalMs, toolTimeoutMs, visibleOnly, and optional title/url scoping. set_value can put value inside arguments or as top-level step.value. select_text selects by text string, not start/end offsets." }), { minItems: 1, description: "Ordered Computer Use tool calls to run in one persistent app-server thread." }),
			approval: approvalParam,
			allowMutating: Type.Optional(Type.Boolean({ description: "Required when any step is not list_apps or get_app_state." })),
			allowPointerClick: Type.Optional(Type.Boolean({ description: "Required to use the pointer-based click tool. Prefer perform_secondary_action action=Press when possible." })),
			allowPointerDrag: Type.Optional(Type.Boolean({ description: "Required to use the pointer-based drag tool. The extension restores the mouse position afterward." })),
			safetyNote: Type.Optional(Type.String({ description: "Required for mutating steps. State target app, intended effect, and stop boundary." })),
			includeImage: Type.Optional(Type.Boolean({ description: "Attach screenshot image blocks returned by sequence steps when the current model/host supports image blocks. Use saveImagePath for reliable screenshot artifacts. Default false." })),
			saveImagePath: Type.Optional(Type.String({ description: "Optional filesystem path where a sequence screenshot should be saved. Use screenshotStep to choose first or final state. Default first for backward compatibility." })),
			screenshotStep: Type.Optional(StringEnum(["first", "final"] as const, { description: "Which sequence step may save saveImagePath. Default first; use final to capture final visual state." })),
			detail: Type.Optional(StringEnum(["minimal", "compact", "full"] as const, { description: "Output detail. Default compact for sequences. minimal suppresses successful non-state action bodies; full returns full accessibility trees for every step." })),
			targetScope: Type.Optional(StringEnum(["all", "main"] as const, { description: "Output target scope for parsed targets. main suppresses likely app/browser chrome and window controls where possible." })),
			maxTextChars: maxTextParam,
			toolTimeoutMs: timeoutParam,
		}),
		async execute(_toolCallId, params, signal, onUpdate) {
			const input = params as SequenceParams;
			const defaultApp = typeof input.app === "string" ? input.app : undefined;
			const steps = normalizeSequenceSteps(input.steps).map((step) => {
				if (!defaultApp || step.arguments.app !== undefined || !APP_SCOPED_TOOLS.has(step.tool)) return step;
				return { ...step, arguments: { app: defaultApp, ...step.arguments } };
			});
			const mutating = hasMutatingSteps(steps);
			const hasPointerClick = steps.some((step) => step.tool === "click");
			const hasPointerDrag = steps.some((step) => step.tool === "drag");
			if (hasPointerClick && !input.allowPointerClick) {
				throw new Error("codex_cu_sequence pointer click steps require allowPointerClick=true. Prefer perform_secondary_action with action=Press when possible to preserve mouse focus.");
			}
			if (hasPointerDrag && !input.allowPointerDrag) {
				throw new Error("codex_cu_sequence pointer drag steps require allowPointerDrag=true. Pointer drag can move the user's cursor; the extension restores mouse position afterward.");
			}
			if (mutating) {
				if (!input.allowMutating) throw new Error("codex_cu_sequence mutating steps require allowMutating=true.");
				const safetyNote = String(input.safetyNote || "").trim();
				if (safetyNote.length < 20) throw new Error("codex_cu_sequence mutating steps require a safetyNote describing target, intended effect, and stop boundary.");
			}
			const approval = input.approval || "inherit";
			onUpdate?.({ content: [{ type: "text", text: `Running persistent Codex Computer Use sequence (${steps.length} steps, mutating=${mutating})...` }] });
			const toolTimeoutMs = asInt(input.toolTimeoutMs, DEFAULT_TOOL_TIMEOUT_MS);
			const maxTextChars = asInt(input.maxTextChars, DEFAULT_MAX_TEXT_CHARS);
			const detail = normalizeDetail(input.detail, "compact");
			const targetScope: TargetScope = input.targetScope === "main" ? "main" : "all";
			const screenshotStep = input.screenshotStep === "final" ? "final" : "first";
			const mouseBefore = hasPointerClick || hasPointerDrag ? getMousePosition() : null;
			let mouseRestored = false;
			const frontmostBefore = await captureFocusSnapshot(approval, toolTimeoutMs, maxTextChars, signal);
			const results: SequencedResult[] = [];
			const elementCache = new Map(sessionElementCache);
			const stateCache = new Map<string, StateSummary>();
			let failed: SequenceFailure | null = null;
			let implicitRefreshes = 0;
			try {
				for (const [index, step] of steps.entries()) {
					const originalStepArgs = normalizeToolArguments(step.arguments);
					let stepArgs = originalStepArgs;
					let targetResolution: string | undefined;
					try {
						let beforeState = typeof stepArgs.app === "string" ? stateCache.get(stepArgs.app) ?? null : null;
						if (isWaitTool(step.tool)) {
							const waited = await runWaitStep(step, stepArgs, { approval, timeoutMs: toolTimeoutMs, maxTextChars, signal, cache: elementCache, beforeState, scope: targetScope });
							const row: SequencedResult = {
								index,
								label: step.label,
								tool: step.tool,
								arguments: stepArgs,
								durationMs: waited.durationMs,
								result: waited.result,
								expectText: step.expectText,
								expectAbsentText: step.expectAbsentText,
								expectVisibleText: step.expectVisibleText,
								allowError: step.allowError,
								targetResolution: waited.targetResolution,
								targetWarnings: [],
								elements: waited.elements,
								visibleText: waited.visibleText,
								changed: waited.changed,
								nextActions: waited.nextActions,
								acceptedElicitations: 0,
								elicitationCount: 0,
							};
							if (typeof stepArgs.app === "string") stateCache.set(stepArgs.app, stateSummary(waited.result.content, targetScope));
							validateStepResult(row);
							if (detail === "compact") row.result.content = compactContent(row.result.content, targetScope);
							results.push(row);
							continue;
						}
						const elementId = stepArgs.elementId ?? stepArgs.element_id;
						const elementDescription = stepArgs.elementDescription ?? stepArgs.element_description;
						const elementRole = stepArgs.role ?? stepArgs.elementRole;
						const elementName = stepArgs.name ?? stepArgs.elementName;
						const targetsElement = step.tool !== "get_app_state" && typeof stepArgs.app === "string" && (
							stepArgs.element_index !== undefined ||
							typeof elementId === "string" ||
							typeof elementDescription === "string" ||
							typeof elementRole === "string" ||
							typeof elementName === "string" ||
							Array.isArray(stepArgs.targets)
						);
						if (targetsElement && typeof stepArgs.app === "string") {
							const refresh = await client.callTool("get_app_state", { app: stepArgs.app }, { approval, timeoutMs: toolTimeoutMs, signal });
							const refreshed = filterToolResult(refresh.result, { maxTextChars });
							updateElementCache(elementCache, stepArgs.app, refreshed.content);
							updateElementCache(sessionElementCache, stepArgs.app, refreshed.content);
							beforeState = stateSummary(refreshed.content, targetScope);
							stateCache.set(stepArgs.app, beforeState);
							implicitRefreshes += 1;
						}
						if (!beforeState && step.requireStateChange && step.tool !== "get_app_state" && step.tool !== "list_apps" && typeof stepArgs.app === "string") {
							const refresh = await client.callTool("get_app_state", { app: stepArgs.app }, { approval, timeoutMs: toolTimeoutMs, signal });
							const refreshed = filterToolResult(refresh.result, { maxTextChars });
							updateElementCache(elementCache, stepArgs.app, refreshed.content);
							updateElementCache(sessionElementCache, stepArgs.app, refreshed.content);
							beforeState = stateSummary(refreshed.content, targetScope);
							stateCache.set(stepArgs.app, beforeState);
							implicitRefreshes += 1;
						}
						stepArgs = resolveElementTargetFallbacks(stepArgs, elementCache);
						stepArgs = resolveElementId(stepArgs, elementCache);
						stepArgs = resolveElementDescription(stepArgs, elementCache);
						stepArgs = resolveElementRoleName(stepArgs, elementCache);
						const targetWarnings = validateIndexedTarget(stepArgs, elementCache, hasStableSelector(originalStepArgs));
						targetResolution = describeTargetResolution(originalStepArgs, stepArgs, elementCache);
						let callTool = step.tool;
						let callArgs = stripSelectorOnlyKeys(stepArgs);
						if (step.tool === "set_value" && stepArgs.value === "" && typeof stepArgs.app === "string") {
							const clearCandidates = (elementCache.get(stepArgs.app) ?? []).filter((element) => element.role === "button" && element.tags.includes("clear-control") && !element.tags.includes("risk-sensitive-control"));
							if (clearCandidates.length === 1) {
								const clearTarget = clearCandidates[0];
								callTool = "perform_secondary_action";
								callArgs = { app: stepArgs.app, element_index: clearTarget.index, action: "Press" };
								targetResolution = `${targetResolution ?? "resolved target"}; empty set_value fallback used clear-control button element_index ${clearTarget.index} (${elementLineWithTargetHint(clearTarget)})`;
							}
						}
						const saveImageForStep = screenshotStep === "first" ? index === 0 : index === steps.length - 1;
						const call = await client.callTool(callTool, callArgs, { approval, timeoutMs: toolTimeoutMs, signal });
						let filtered = filterToolResult(call.result, {
							includeImage: Boolean(input.includeImage),
							saveImagePath: saveImageForStep ? input.saveImagePath : undefined,
							maxTextChars,
						});
						let postActionNoChange = false;
						let postActionReadbackDone = false;
						let actionErrorRecoveredByStateChange = false;
						if (filtered.isError && step.requireStateChange && typeof stepArgs.app === "string") {
							const verify = await client.callTool("get_app_state", { app: stepArgs.app }, { approval, timeoutMs: toolTimeoutMs, signal });
							const verified = filterToolResult(verify.result, {
								includeImage: Boolean(input.includeImage),
								saveImagePath: saveImageForStep ? input.saveImagePath : undefined,
								maxTextChars,
							});
							appendComputerUseDiagnostic(verified, "get_app_state", { app: stepArgs.app });
							const verifiedState = stateSummary(verified.content, targetScope);
							const errorReadbackChange = compareState(beforeState, verifiedState);
							const changedDespiteError = Boolean(errorReadbackChange && (errorReadbackChange.visibleTextChanged || errorReadbackChange.titleChanged || errorReadbackChange.urlChanged || errorReadbackChange.targetsAdded.length > 0 || errorReadbackChange.targetsRemoved.length > 0));
							if (changedDespiteError) {
								actionErrorRecoveredByStateChange = true;
								appendText(verified, `Warning: actionReportedErrorButStateChanged — ${step.tool} returned an upstream error, but requireStateChange was satisfied by post-action get_app_state readback. Treat the action as dispatched, then inspect final state before continuing. Original error output: ${truncateString(toolResultText(filtered), 800)}`);
								updateElementCache(elementCache, stepArgs.app, verified.content);
								updateElementCache(sessionElementCache, stepArgs.app, verified.content);
								filtered = verified;
								postActionReadbackDone = true;
							}
						}
						if (step.tool === "set_value" && typeof stepArgs.value === "string" && stepArgs.value.length > 0 && typeof stepArgs.app === "string") {
							const verify = await client.callTool("get_app_state", { app: stepArgs.app }, { approval, timeoutMs: toolTimeoutMs, signal });
							const verified = filterToolResult(verify.result, {
								includeImage: Boolean(input.includeImage),
								saveImagePath: saveImageForStep ? input.saveImagePath : undefined,
								maxTextChars,
							});
							appendComputerUseDiagnostic(verified, "get_app_state", { app: stepArgs.app });
							updateElementCache(elementCache, stepArgs.app, verified.content);
							updateElementCache(sessionElementCache, stepArgs.app, verified.content);
							postActionReadbackDone = true;
							const normalizedStateText = normalizeAssertionText(assertionContentText(verified.content));
							const multilineMatch = contentIncludesMultilineValue(verified.content, stepArgs.value);
							if (normalizedStateText.includes(normalizeAssertionText(stepArgs.value)) || multilineMatch.matched) {
								appendText(verified, `set_value verified in post-action app state: ${JSON.stringify(stepArgs.value)}`);
								filtered = verified;
							} else if (multilineMatch.partial) {
								appendText(verified, `Warning: set_value multiline verification was partial. Matched ${multilineMatch.matchedLines.length} expected line(s), but post-action state output did not expose ${multilineMatch.missingLines.length} line(s). This often means upstream accessibility/minimal output truncated a multiline text value; verify with follow-up expectVisibleText/expectText lines before relying on the edit. Missing lines: ${JSON.stringify(multilineMatch.missingLines.slice(0, 5))}`);
								filtered = verified;
							} else {
								filtered.isError = true;
								appendText(filtered, `set_value did not appear in post-action app state; upstream may have reported a false positive for target ${targetResolution ?? "<unknown>"}. Expected value: ${JSON.stringify(stepArgs.value)}. Try a focused keyboard fallback only when the target document/window is unambiguous.`);
							}
						}
						const isStateTool = step.tool === "get_app_state" || step.tool === "list_apps";
						if (!postActionReadbackDone && !filtered.isError && !isStateTool && typeof stepArgs.app === "string") {
							const verify = await client.callTool("get_app_state", { app: stepArgs.app }, { approval, timeoutMs: toolTimeoutMs, signal });
							let verified = filterToolResult(verify.result, {
								includeImage: Boolean(input.includeImage),
								saveImagePath: saveImageForStep ? input.saveImagePath : undefined,
								maxTextChars,
							});
							appendComputerUseDiagnostic(verified, "get_app_state", { app: stepArgs.app });
							let verifiedState = stateSummary(verified.content, targetScope);
							let readbackChange = compareState(beforeState, verifiedState);
							postActionNoChange = !readbackChange || (!readbackChange.visibleTextChanged && !readbackChange.titleChanged && !readbackChange.urlChanged && readbackChange.targetsAdded.length === 0 && readbackChange.targetsRemoved.length === 0);
							if (postActionNoChange && step.requireStateChange) {
								await new Promise((resolve) => setTimeout(resolve, 600));
								const delayedVerify = await client.callTool("get_app_state", { app: stepArgs.app }, { approval, timeoutMs: toolTimeoutMs, signal });
								const delayed = filterToolResult(delayedVerify.result, {
									includeImage: Boolean(input.includeImage),
									saveImagePath: saveImageForStep ? input.saveImagePath : undefined,
									maxTextChars,
								});
								appendComputerUseDiagnostic(delayed, "get_app_state", { app: stepArgs.app });
								const delayedState = stateSummary(delayed.content, targetScope);
								const delayedChange = compareState(beforeState, delayedState);
								const delayedNoChange = !delayedChange || (!delayedChange.visibleTextChanged && !delayedChange.titleChanged && !delayedChange.urlChanged && delayedChange.targetsAdded.length === 0 && delayedChange.targetsRemoved.length === 0);
								if (!delayedNoChange) {
									appendText(delayed, "requireStateChange verified after delayed post-action readback; transient UI was not visible on the first readback.");
									verified = delayed;
									verifiedState = delayedState;
									readbackChange = delayedChange;
									postActionNoChange = false;
								}
							}
							if (postActionNoChange) {
								appendText(verified, `Warning: actionDispatchedButNoStateChange — ${step.tool} returned success, but a post-action get_app_state readback did not show observable title, URL, visible-text, or target changes. If the target should have opened/navigated, treat this as a failed UI action; retry after a fresh state read or escalate to guarded pointer click using allowPointerClick when the target/window is unambiguous.`);
							}
							if (step.requireStateChange && postActionNoChange) verified.isError = true;
							updateElementCache(elementCache, stepArgs.app, verified.content);
							updateElementCache(sessionElementCache, stepArgs.app, verified.content);
							filtered = verified;
						}
						const diagnostics = [appendComputerUseDiagnostic(filtered, step.tool, stepArgs)].filter((item): item is string => Boolean(item));
						const afterState = stateSummary(filtered.content, targetScope);
						updateElementCache(elementCache, stepArgs.app, filtered.content);
						updateElementCache(sessionElementCache, stepArgs.app, filtered.content);
						if (typeof stepArgs.app === "string") stateCache.set(stepArgs.app, afterState);
						if (detail === "full") appendElementStabilityNote(filtered);
						appendImageWarning(filtered, { includeImage: Boolean(input.includeImage), saveImagePath: saveImageForStep ? input.saveImagePath : undefined });
						enrichActionError(filtered, stepArgs, elementCache);
						const changed = compareState(beforeState, afterState);
						const rawIndexTarget = originalStepArgs.element_index !== undefined || originalStepArgs.element !== undefined;
						const nextActions = [
							...(rawIndexTarget && changed && (changed.urlChanged || changed.titleChanged || changed.visibleTextChanged) && !step.tool.startsWith("get_app_state") ? [`If the UI rerendered or navigated, call codex_cu_get_app_state({app:${JSON.stringify(stepArgs.app)}, detail:"minimal"}) before using raw element_index targets.`] : []),
							...(diagnostics.length > 0 ? [`Resolve upstream Computer Use state for ${JSON.stringify(stepArgs.app)} before retrying mutating actions; use agent_browser for web/Chrome if Computer Use state keeps timing out.`] : []),
							...(postActionNoChange ? [`AX action dispatched but no observable state change was seen. If a click/open was expected, retry with a fresh state read; use a pointer click fallback only with allowPointerClick and an unambiguous target/window.`] : []),
							...(actionErrorRecoveredByStateChange ? [`Upstream reported an error, but post-action state changed. Inspect the final state carefully before issuing another mutating step.`] : []),
						];
						const row: SequencedResult = {
							index,
							label: step.label,
							tool: step.tool,
							arguments: callArgs,
							durationMs: call.durationMs,
							result: filtered,
							expectText: step.expectText,
							expectAbsentText: step.expectAbsentText,
							expectVisibleText: step.expectVisibleText,
							allowError: step.allowError,
							targetResolution,
							targetWarnings,
							elements: step.tool === "get_app_state" ? machineElements(filtered.content, targetScope) : [],
							visibleText: afterState.visibleText,
							changed,
							nextActions,
							acceptedElicitations: call.acceptedElicitations,
							elicitationCount: call.elicitationCount,
						};
						try {
							validateStepResult(row);
						} catch (error) {
							row.result.isError = true;
							row.result.content = [{ type: "text", text: `Sequence stopped: ${errorMessage(error)}` }, ...row.result.content];
							failed = { index, stepNumber: index + 1, tool: step.tool, label: step.label, message: errorMessage(error) };
						}
						if (detail === "compact" && !row.result.isError) row.result.content = compactContent(row.result.content, targetScope);
						results.push(row);
						if (failed) break;
					} catch (error) {
						const message = errorMessage(error);
						const allowed = step.allowError;
						if (!allowed) failed = { index, stepNumber: index + 1, tool: step.tool, label: step.label, message };
						results.push({
							index,
							label: step.label,
							tool: step.tool,
							arguments: stepArgs,
							durationMs: 0,
							result: failureResult(`Sequence ${allowed ? "allowed error" : "stopped"} before completing step ${index + 1} (index ${index}, ${step.tool}):\n${message}`, maxTextChars),
							expectText: step.expectText,
							expectAbsentText: step.expectAbsentText,
							expectVisibleText: step.expectVisibleText,
							allowError: step.allowError,
							targetResolution,
							targetWarnings: [],
							elements: [],
							visibleText: [],
							changed: null,
							nextActions: ["Inspect the failed-step diagnostic, then re-run codex_cu_get_app_state with detail:\"minimal\" before retrying any raw element_index target."],
							acceptedElicitations: 0,
							elicitationCount: 0,
						});
						if (!allowed) break;
					}
				}
			} finally {
				if (mouseBefore) mouseRestored = restoreMousePosition(mouseBefore);
			}
			const mouseAfter = mouseBefore ? getMousePosition() : null;
			const frontmostAfter = await captureFocusSnapshot(approval, toolTimeoutMs, maxTextChars, signal);
			const focus = focusSnapshot(frontmostBefore, frontmostAfter);
			const mousePreservation = mouseBefore ? { before: mouseBefore, after: mouseAfter, restored: mouseRestored } : undefined;
			return {
				content: sequenceContent(results, Boolean(input.includeImage), failed, steps.length, detail, maxTextChars, focus, defaultApp, mousePreservation),
				details: bridgeDetails({
					tool: "sequence",
					threadId: client.status().threadId,
					detail,
					targetScope,
					failed,
					failedStepIndex: failed?.index ?? null,
					failedStepNumber: failed?.stepNumber ?? null,
					failedStepLabel: failed?.label ?? null,
					completedStepCount: failed ? failed.index : results.length,
					resumeFromStepIndex: failed?.index ?? null,
					defaultApp: defaultApp ?? null,
					implicitRefreshes,
					imageSupportNote: input.includeImage ? "Image rendering is model/host dependent; saveImagePath is the reliable screenshot artifact path." : null,
					screenshotStep,
					focus,
					pointerToolsUsed: hasPointerClick || hasPointerDrag,
					steps: results.map((step) => ({
						index: step.index,
						tool: step.tool,
						arguments: step.arguments,
						durationMs: step.durationMs,
						isError: step.result.isError,
						omittedImages: step.result.omittedImages,
						savedImagePath: step.result.savedImagePath,
						savedImageArtifact: step.result.savedImageArtifact,
						acceptedElicitations: step.acceptedElicitations,
						elicitationCount: step.elicitationCount,
						targetResolution: step.targetResolution ?? null,
						targetWarnings: step.targetWarnings,
						visibleText: step.visibleText,
						changed: step.changed,
						nextActions: step.nextActions,
						elements: step.elements,
					})),
					mousePreservation: mousePreservation ?? null,
				}, client.status().stderrTail),
			};
		},
	});
}
