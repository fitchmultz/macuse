/**
 * Purpose: Expose Codex Computer Use as native pi tools through the Codex app-server bridge.
 * Responsibilities: Manage one persistent app-server session, register read-only and guarded mutating Computer Use tools, normalize stable element targets, and clean up session resources on reload/shutdown.
 * Scope: Pi extension runtime only; CLI smoke tests and install helpers live under tools/.
 * Usage: Loaded by pi through package.json#pi.extensions for global/local package installs, or through the project-local .pi/extensions shim during checkout development.
 * Invariants/Assumptions: Codex.app is installed locally, Computer Use is macOS-only, mutating actions remain explicitly gated, and the persistent app-server thread is extension-owned.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createHash } from "node:crypto";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const VERSION = "0.2.0";
const DEFAULT_CODEX_BIN = "/Applications/Codex.app/Contents/Resources/codex";
const DEFAULT_TOOL_TIMEOUT_MS = 90_000;
const DEFAULT_MAX_TEXT_CHARS = 20_000;
const WAIT_TOOLS = new Set(["waitForText", "waitForURL", "waitForTitle", "waitForElement", "waitUntilElementEnabled", "waitUntilElementDisabled"]);
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
	group: "content" | "chrome" | "window" | "other";
	line: string;
	secondaryActions: string[];
};

type MachineElement = Pick<ElementInfo, "index" | "id" | "description" | "role" | "name" | "value" | "disabled" | "group" | "secondaryActions"> & { targetHint: string; line: string };

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
	return normalized;
}

function parseElementRole(body: string): string {
	const match = body.match(/^(standard window|split group|container|scroll area|text entry area|secure text field|text field|edit field|close button|zoom button|minimize button|radio button|menu bar|menu item|button|checkbox|slider|combo box|tab|link|row|text|toolbar|group|web area)\b/i);
	return normalizeRole(match?.[1] ?? body.split(/\s+/)[0] ?? "unknown");
}

function roleMatches(actual: string, expected: string): boolean {
	const wanted = normalizeRole(expected);
	const got = normalizeRole(actual);
	if (wanted === got) return true;
	if (wanted === "text field") return ["text field", "edit field", "text entry area", "secure text field", "scroll area"].includes(got);
	return false;
}

function parseElementName(body: string, role: string, id?: string, description?: string): string {
	if (description) return description;
	const withoutRole = body.replace(new RegExp(`^${role.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*`, "i"), "").trim();
	const beforeComma = withoutRole.split(/,\s*(?:ID:|Help:|Secondary Actions:)/)[0]?.trim() ?? "";
	const cleaned = beforeComma.replace(/^Description:\s*/i, "").replace(/\s*\(disabled\)\s*$/i, "").trim();
	return cleaned || id || role;
}

function elementGroup(line: string, role: string): ElementInfo["group"] {
	if (/\b(?:standard window|close button|zoom button|minimize button)\b/i.test(line)) return "window";
	if (/\b(?:menu bar|toolbar)\b/i.test(line)) return "chrome";
	if (/\b(?:tab group|tab|address|bookmark|extension|sidebar|show sidebar|mode:)\b/i.test(line)) return "chrome";
	if (["button", "text field", "edit field", "text entry area", "secure text field", "checkbox", "radio button", "slider", "combo box", "link", "row", "text", "scroll area"].includes(role)) return "content";
	return "other";
}

function parseElementInfo(text: string): ElementInfo[] {
	const elements: ElementInfo[] = [];
	for (const rawLine of text.split("\n")) {
		const match = rawLine.match(/^\s*(\d+)\s+(.+)$/);
		if (!match) continue;
		const line = match[0].trim();
		const body = stripInvisibleBidiMarks(match[2] ?? "");
		const id = line.match(/(?:^|[\s,])ID:\s*([^,\n]+)/)?.[1]?.trim();
		const explicitDescription = line.match(/Description:\s*([^,\n]+)/)?.[1]?.trim();
		const role = parseElementRole(body);
		const buttonLabel = line.match(/^\d+\s+button\s+([^,]+?)(?:,\s|$)/)?.[1]?.trim();
		const description = explicitDescription ?? (buttonLabel && !buttonLabel.startsWith("Description:") ? stripInvisibleBidiMarks(buttonLabel) : undefined);
		const value = role === "text" ? body.replace(/^text\s+/i, "").trim() : undefined;
		const name = parseElementName(body, role, id, description);
		const secondaryActions = line.match(/Secondary Actions:\s*([^\n]+)/)?.[1]
			?.split(",")
			.map((item) => item.trim())
			.filter(Boolean) ?? [];
		const disabled = /\bdisabled\b|\(disabled\)/i.test(line);
		elements.push({ index: match[1], id, description, role, name, value, disabled, group: elementGroup(line, role), line, secondaryActions });
	}
	return elements;
}

function isInteractiveElement(element: ElementInfo): boolean {
	return Boolean(element.id) ||
		element.secondaryActions.length > 0 ||
		/\b(button|text entry area|text field|edit field|field|menu|menu item|row|checkbox|radio|slider|scroll area|combo box|tab|link)\b/i.test(element.line) ||
		/\btext\s+‎/.test(element.line);
}

function elementTargetHint(element: ElementInfo): string {
	if (element.id) return `target: { elementId: ${JSON.stringify(element.id)} }`;
	if (element.description) return `target: { elementDescription: ${JSON.stringify(element.description)} }`;
	if (element.name && element.role) return `target: { role: ${JSON.stringify(element.role)}, name: ${JSON.stringify(element.name)} }`;
	return `fallback: { element_index: ${JSON.stringify(element.index)} }`;
}

function elementLineWithTargetHint(element: ElementInfo): string {
	return `${stripInvisibleBidiMarks(element.line)} — ${elementTargetHint(element)}`;
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
	const withoutIds = interactive.filter((element) => !element.id).length;
	if (withoutIds === 0) return null;
	return `Note: ${withoutIds} of ${interactive.length} interactive elements lack stable IDs. Prefer elementId when present, elementDescription when shown, press_key/type_text when practical, or re-snapshot before using element_index after mutations.`;
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
		.map((element) => `${element.index} ${stripInvisibleBidiMarks(element.line.replace(/^\d+\s+/, ""))}`);
	const ranked = prioritizedElements(elements.filter(isInteractiveElement), scope);
	const targets = ranked
		.filter((element) => element.group !== "window")
		.slice(0, 24)
		.map((element) => `${element.index} ${shortElementLabel(element)} [${element.role}${element.disabled ? ", disabled" : ""}] — ${elementTargetHint(element)}`);
	const omittedByGroup = ["content", "chrome", "window", "other"]
		.map((group) => ({ group, count: ranked.filter((element) => element.group === group).length }))
		.filter((item) => item.count > 0)
		.map((item) => `${item.group}:${item.count}`)
		.join(", ");
	const sections = [...header];
	if (visibleText.length > 0) sections.push("Visible text:", ...visibleText);
	if (targets.length > 0) sections.push("Targets:", ...targets);
	if (omittedByGroup) sections.push(`Target groups: ${omittedByGroup}`);
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

function visibleTextValues(content: ContentBlock[]): string[] {
	return parseElementInfo(contentText(content))
		.filter((element) => /\btext\b/i.test(element.line))
		.map((element) => normalizeAssertionText(element.line.replace(/^\s*\d+\s+text\s+/, "").trim()))
		.filter(Boolean);
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
	const url = text.match(/https?:\/\/[^\s"'<>]+/)?.[0] ?? null;
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

function normalizeToolArguments(args: Record<string, JsonValue>): Record<string, JsonValue> {
	const normalized: Record<string, JsonValue> = { ...args };
	if (normalized.element_index === undefined && normalized.element !== undefined) {
		normalized.element_index = normalized.element;
		delete normalized.element;
	}
	if (normalized.element_index !== undefined && normalized.element_index !== null) normalized.element_index = String(normalized.element_index);
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

function closestElementSuggestions(elements: ElementInfo[], value: string, field: "id" | "description" | "name", limit = 3): string {
	const candidates = elements
		.map((element) => ({ element, value: element[field] }))
		.filter((candidate): candidate is { element: ElementInfo; value: string } => typeof candidate.value === "string" && candidate.value.length > 0)
		.map((candidate) => ({ ...candidate, score: editDistance(value, candidate.value) }))
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
	const matches = elements.filter((element) => {
		if (typeof rawRole === "string" && !roleMatches(element.role, rawRole)) return false;
		if (typeof rawName === "string") {
			const expected = normalizeAssertionText(rawName).toLowerCase();
			const names = [element.name, element.description, element.id, element.value].filter((item): item is string => typeof item === "string");
			if (!names.some((name) => normalizeAssertionText(name).toLowerCase() === expected)) return false;
		}
		return true;
	});
	if (matches.length !== 1) {
		const reason = matches.length === 0 ? "No" : `Ambiguous ${matches.length}`;
		const closest = typeof rawName === "string" ? closestElementSuggestions(elements, rawName, "name") : "";
		throw new Error(`${reason} role/name target found for ${normalized.app}. Match is exact and case-insensitive.${closest ? `\nClosest name matches: ${closest}.` : ""}\nAvailable targets:\n${actionableElementSummary(elements)}`);
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
		if (!ok) throw new Error(`Stale element_index ${args.element_index}: ${field} expected ${JSON.stringify(expected)} but latest target is ${JSON.stringify(actual ?? "")}. No mutation performed; re-snapshot or use elementId/elementDescription/role/name.`);
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
	const resolved = `resolved target: element_index ${resolvedArgs.element_index}${element ? ` (${elementLineWithTargetHint(element)})` : ""}`;
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
	appendText(result, `Target element ${element.index}: ${element.line}\nValid secondary actions: ${actions}`);
}

function filterAppListContent(content: ContentBlock[], opts: { runningOnly?: boolean; filter?: string; maxTextChars: number }): ContentBlock[] {
	return content.map((block) => {
		if (!isTextBlock(block)) return block;
		let lines = block.text.split("\n").filter(Boolean);
		if (opts.runningOnly) lines = lines.filter((line: string) => /\[(?:[^\]]*,\s*)?(?:frontmost,\s*)?running(?:[,\]])/.test(line) || line.includes("[frontmost, running"));
		if (opts.filter) {
			const needle = opts.filter.toLowerCase();
			lines = lines.filter((line: string) => line.toLowerCase().includes(needle));
		}
		const text = lines.join("\n") || "No apps matched the requested filter.";
		return { ...block, text: truncateString(text, opts.maxTextChars) };
	});
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
	if (diagnostic) appendText(result, diagnostic);
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

	constructor(private readonly codexBin = process.env.CODEX_BIN || DEFAULT_CODEX_BIN, private readonly cwd = process.cwd()) {}

	status() {
		return {
			version: VERSION,
			codexBin: this.codexBin,
			cwd: this.cwd,
			running: Boolean(this.proc && this.proc.exitCode === null && this.proc.signalCode === null),
			threadId: this.thread?.id ?? null,
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

		this.initialized = await this.request("initialize", {
			clientInfo: { name: "pi-macuse-computer-use", version: VERSION },
			capabilities: { experimental_api: true, mcp_elicitations: true },
		}, Math.min(timeoutMs, 15_000), signal);
		this.notify("notifications/initialized");
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
		if (!proc) return;
		this.proc = null;
		this.thread = null;
		if (proc.exitCode !== null || proc.signalCode !== null) return;
		proc.kill("SIGTERM");
		await new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
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
	if (tool === "waitForText") {
		if (typeof args.text !== "string") throw new Error("waitForText requires arguments.text.");
		const expected = normalizeAssertionText(args.text);
		const visible = visibleTextValues(result.content);
		return visible.some((value) => value.includes(expected)) ? `waitForText matched visible text ${JSON.stringify(args.text)}` : null;
	}
	if (tool === "waitForURL") {
		if (typeof args.url !== "string") throw new Error("waitForURL requires arguments.url.");
		const summary = stateSummary(result.content);
		return summary.url && summary.url.includes(args.url) ? `waitForURL matched ${JSON.stringify(args.url)} at ${summary.url}` : null;
	}
	if (tool === "waitForTitle") {
		if (typeof args.title !== "string") throw new Error("waitForTitle requires arguments.title.");
		const summary = stateSummary(result.content);
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
	const deadline = started + asInt(args.timeoutMs, opts.timeoutMs);
	const intervalMs = Math.max(100, Math.min(asInt(args.intervalMs, 750), 10_000));
	let last: FilteredToolResult | null = null;
	let lastMessage = "condition did not match";
	for (;;) {
		const remainingMs = deadline - Date.now();
		if (remainingMs <= 0) break;
		const call = await client.callTool("get_app_state", { app: args.app }, { approval: opts.approval, timeoutMs: Math.min(opts.timeoutMs, remainingMs), signal: opts.signal });
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
	const message = `${step.tool} timed out after ${asInt(args.timeoutMs, opts.timeoutMs)}ms: ${lastMessage}. Next action: re-run codex_cu_get_app_state with detail:"minimal" for ${args.app}.`;
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
		};
	});
}

function validateStepResult(step: SequencedResult): void {
	const stepNumber = step.index + 1;
	if (step.result.isError && !step.allowError) {
		throw new ComputerUseError(`sequence step ${stepNumber} (index ${step.index}) ${step.tool} returned tool error`, step.result);
	}
	const text = normalizeAssertionText(toolResultText(step.result));
	for (const rawExpected of step.expectText || []) {
		const expected = normalizeAssertionText(rawExpected);
		if (!text.includes(expected)) throw new ComputerUseError(`sequence step ${stepNumber} (index ${step.index}) ${step.tool} missing expected text: ${rawExpected}`, { expected: rawExpected, normalizedExpected: expected, textPreview: truncateString(text, 1000) });
	}
	for (const rawUnexpected of step.expectAbsentText || []) {
		const unexpected = normalizeAssertionText(rawUnexpected);
		if (text.includes(unexpected)) throw new ComputerUseError(`sequence step ${stepNumber} (index ${step.index}) ${step.tool} contained forbidden text: ${rawUnexpected}`, { unexpected: rawUnexpected, normalizedUnexpected: unexpected, textPreview: truncateString(text, 1000) });
	}
	if (step.expectVisibleText.length > 0) {
		const visible = visibleTextValues(step.result.content);
		for (const rawExpected of step.expectVisibleText) {
			const expected = normalizeAssertionText(rawExpected);
			if (!visible.includes(expected)) throw new ComputerUseError(`sequence step ${stepNumber} (index ${step.index}) ${step.tool} missing expected visible text: ${rawExpected}`, { expected: rawExpected, visibleText: visible });
		}
	}
}

function assertionSummary(step: SequencedResult): string | null {
	const text = normalizeAssertionText(toolResultText(step.result));
	const lines: string[] = [];
	for (const rawExpected of step.expectText) {
		const expected = normalizeAssertionText(rawExpected);
		const matchingLine = text.split("\n").find((line) => line.includes(expected));
		const snippet = matchingLine ? truncateString(matchingLine.replace(/\s+/g, " ").trim(), 160) : "";
		lines.push(`expectText passed: ${JSON.stringify(rawExpected)}${snippet ? `; matched line: ${JSON.stringify(snippet)}` : ""}`);
	}
	for (const rawUnexpected of step.expectAbsentText) lines.push(`expectAbsentText passed: ${JSON.stringify(rawUnexpected)} absent`);
	const visible = visibleTextValues(step.result.content);
	for (const rawExpected of step.expectVisibleText) lines.push(`expectVisibleText passed: ${JSON.stringify(rawExpected)}${visible.length > 0 ? `; visible text: ${JSON.stringify(visible.join(" | "))}` : ""}`);
	return lines.length > 0 ? lines.join("\n") : null;
}

function sequenceContent(steps: SequencedResult[], includeImages = false, failed: SequenceFailure | null = null, totalSteps = steps.length, detail: DetailMode = "compact", maxTextChars = DEFAULT_MAX_TEXT_CHARS): ContentBlock[] {
	if (steps.length === 0) return [{ type: "text", text: "Computer Use sequence returned no steps." }];
	const completedStepCount = failed ? failed.index : steps.length;
	const summary = failed
		? `Sequence failed at step ${failed.stepNumber} of ${totalSteps} (index ${failed.index}, ${failed.tool}). Completed ${completedStepCount} step${completedStepCount === 1 ? "" : "s"}. To resume, start a new sequence from step index ${failed.index} against current app state.`
		: `Sequence completed ${steps.length} of ${totalSteps} step${totalSteps === 1 ? "" : "s"}.`;
	const orderedSteps = failed ? [steps[failed.index], ...steps.filter((step) => step.index !== failed.index)].filter((step): step is SequencedResult => Boolean(step)) : steps;
	const text = `${summary}\n\n${orderedSteps.map((step) => {
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
	}).join("\n\n---\n\n")}`;
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
			ctx.ui.notify(`macuse ${status.running ? "running" : "stopped"}${status.threadId ? ` thread=${status.threadId}` : ""}`, status.running ? "info" : "warning");
		},
	});

	pi.registerCommand("macuse-restart", {
		description: "Restart the persistent Codex Computer Use app-server session",
		handler: async (_args, ctx) => {
			sessionElementCache.clear();
			await client.restart();
			ctx.ui.notify("macuse Computer Use session stopped; it will restart on the next tool call.", "info");
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
			const call = await client.callTool("get_app_state", { app }, { approval, timeoutMs: toolTimeoutMs, signal });
			const result = filterToolResult(call.result, {
				includeImage: Boolean(input.includeImage),
				saveImagePath: input.saveImagePath,
				maxTextChars,
			});
			updateElementCache(sessionElementCache, app, result.content);
			const diagnostics = [appendComputerUseDiagnostic(result, "get_app_state", { app })].filter((item): item is string => Boolean(item));
			if (detail === "full") appendElementStabilityNote(result);
			appendImageWarning(result, { includeImage: Boolean(input.includeImage), saveImagePath: input.saveImagePath });
			const transformedContent = detail === "minimal" ? minimalContent(result.content, targetScope) : detail === "compact" ? compactContent(result.content, targetScope) : result.content;
			const outputContent = truncateTextContent(transformedContent, maxTextChars);
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
			steps: Type.Array(Type.Any({ description: "Ordered Computer Use tool calls. Each step must be an object with tool, optional arguments, optional label, expectText, expectAbsentText, expectVisibleText, and allowError. Element-targeted tools accept element_index as string or number, element as an alias, elementId/element_id, elementDescription/element_description, role/name selectors, or arguments.targets fallback objects; raw index targets may pass expectedRole/expectedName/expectedDescription/expectedId/expectedValue for stale-target guards. Wait helpers accept timeoutMs and intervalMs. set_value can put value inside arguments or as top-level step.value. select_text selects by text string, not start/end offsets." }), { minItems: 1, description: "Ordered Computer Use tool calls to run in one persistent app-server thread." }),
			approval: approvalParam,
			allowMutating: Type.Optional(Type.Boolean({ description: "Required when any step is not list_apps or get_app_state." })),
			allowPointerClick: Type.Optional(Type.Boolean({ description: "Required to use the pointer-based click tool. Prefer perform_secondary_action action=Press when possible." })),
			allowPointerDrag: Type.Optional(Type.Boolean({ description: "Required to use the pointer-based drag tool. The extension restores the mouse position afterward." })),
			safetyNote: Type.Optional(Type.String({ description: "Required for mutating steps. State target app, intended effect, and stop boundary." })),
			includeImage: Type.Optional(Type.Boolean({ description: "Attach screenshot image blocks returned by sequence steps when the current model/host supports image blocks. Use saveImagePath for reliable screenshot artifacts. Default false." })),
			saveImagePath: Type.Optional(Type.String({ description: "Optional filesystem path where the first returned screenshot should be saved." })),
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
			const mouseBefore = hasPointerClick || hasPointerDrag ? getMousePosition() : null;
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
						const beforeState = typeof stepArgs.app === "string" ? stateCache.get(stepArgs.app) ?? null : null;
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
							stateCache.set(stepArgs.app, stateSummary(refreshed.content, targetScope));
							implicitRefreshes += 1;
						}
						stepArgs = resolveElementTargetFallbacks(stepArgs, elementCache);
						stepArgs = resolveElementId(stepArgs, elementCache);
						stepArgs = resolveElementDescription(stepArgs, elementCache);
						stepArgs = resolveElementRoleName(stepArgs, elementCache);
						const targetWarnings = validateIndexedTarget(stepArgs, elementCache, hasStableSelector(originalStepArgs));
						targetResolution = describeTargetResolution(originalStepArgs, stepArgs, elementCache);
						const callArgs = stripSelectorOnlyKeys(stepArgs);
						const call = await client.callTool(step.tool, callArgs, { approval, timeoutMs: toolTimeoutMs, signal });
						const filtered = filterToolResult(call.result, {
							includeImage: Boolean(input.includeImage),
							saveImagePath: index === 0 ? input.saveImagePath : undefined,
							maxTextChars,
						});
						const diagnostics = [appendComputerUseDiagnostic(filtered, step.tool, stepArgs)].filter((item): item is string => Boolean(item));
						const afterState = stateSummary(filtered.content, targetScope);
						updateElementCache(elementCache, stepArgs.app, filtered.content);
						updateElementCache(sessionElementCache, stepArgs.app, filtered.content);
						if (typeof stepArgs.app === "string") stateCache.set(stepArgs.app, afterState);
						if (detail === "full") appendElementStabilityNote(filtered);
						appendImageWarning(filtered, { includeImage: Boolean(input.includeImage), saveImagePath: index === 0 ? input.saveImagePath : undefined });
						enrichActionError(filtered, stepArgs, elementCache);
						const changed = compareState(beforeState, afterState);
						const nextActions = [
							...(changed && (changed.urlChanged || changed.titleChanged || changed.visibleTextChanged) && !step.tool.startsWith("get_app_state") ? [`If the UI rerendered or navigated, call codex_cu_get_app_state({app:${JSON.stringify(stepArgs.app)}, detail:"minimal"}) before using raw element_index targets.`] : []),
							...(diagnostics.length > 0 ? [`Resolve upstream Computer Use state for ${JSON.stringify(stepArgs.app)} before retrying mutating actions; use agent_browser for web/Chrome if Computer Use state keeps timing out.`] : []),
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
							appendText(row.result, `Sequence stopped: ${errorMessage(error)}`);
							failed = { index, stepNumber: index + 1, tool: step.tool, label: step.label, message: errorMessage(error) };
						}
						if (detail === "compact") row.result.content = compactContent(row.result.content, targetScope);
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
				if (mouseBefore) restoreMousePosition(mouseBefore);
			}
			const mouseAfter = mouseBefore ? getMousePosition() : null;
			return {
				content: sequenceContent(results, Boolean(input.includeImage), failed, steps.length, detail, maxTextChars),
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
					mousePreservation: mouseBefore ? { before: mouseBefore, restored: mouseAfter } : null,
				}, client.status().stderrTail),
			};
		},
	});
}
