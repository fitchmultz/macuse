import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const VERSION = resolveMacuseVersion();
export const DEFAULT_CHATGPT_RESOURCES = "/Applications/ChatGPT.app/Contents/Resources";
export const DEFAULT_CODEX_BIN = path.join(DEFAULT_CHATGPT_RESOURCES, "codex");
const DEFAULT_BUNDLED_PLUGIN_ROOT = path.join(DEFAULT_CHATGPT_RESOURCES, "plugins/openai-bundled/plugins");
const DEFAULT_BUNDLED_COMPUTER_USE_PLUGIN_DIR = path.join(DEFAULT_BUNDLED_PLUGIN_ROOT, "computer-use");
const DEFAULT_BUNDLED_RECORD_AND_REPLAY_PLUGIN_DIR = path.join(DEFAULT_BUNDLED_PLUGIN_ROOT, "record-and-replay");
const DEFAULT_BUNDLED_COMPUTER_HISTORY_PLUGIN_DIR = path.join(DEFAULT_BUNDLED_PLUGIN_ROOT, "computer-history");

export const MCP_SERVERS = {
	"computer-use": { pluginDir: DEFAULT_BUNDLED_COMPUTER_USE_PLUGIN_DIR, args: ["mcp"], tools: ["click", "drag", "get_app_state", "list_apps", "perform_secondary_action", "press_key", "scroll", "select_text", "set_value", "type_text"] },
	"event-stream": { pluginDir: DEFAULT_BUNDLED_RECORD_AND_REPLAY_PLUGIN_DIR, args: ["event-stream", "mcp"], tools: ["event_stream_start", "event_stream_status", "event_stream_stop"] },
	"computer-history": { pluginDir: DEFAULT_BUNDLED_COMPUTER_HISTORY_PLUGIN_DIR, args: ["computer-history", "mcp"], tools: ["computer_history_get_settings", "computer_history_pause", "computer_history_resume", "computer_history_status", "computer_history_update_settings"] },
} as const;
export type McpServerName = keyof typeof MCP_SERVERS;

export function mcpServerForTool(tool: string): McpServerName {
	const match = (Object.entries(MCP_SERVERS) as [McpServerName, (typeof MCP_SERVERS)[McpServerName]][]).find(([, server]) => (server.tools as readonly string[]).includes(tool));
	if (!match) throw new Error(`Unsupported upstream Computer Use tool: ${tool}`);
	return match[0];
}

export function mcpServerConfigs() {
	return Object.fromEntries(Object.entries(MCP_SERVERS).map(([name, server]) => [name, {
		command: path.join(server.pluginDir, "bin/computer-use-client-launcher"),
		args: [...server.args],
		cwd: server.pluginDir,
		env_vars: ["CODEX_HOME"],
		enabled: true,
	}]));
}

/**
 * Resolve the canonical package version from package.json via import.meta.url.
 * Single source of truth: package.json is the owner, and the version is written
 * into every /tmp/macuse-appserver PID record so stale-record reaping stays
 * consistent across upgrades.
 */
function resolveMacuseVersion(): string {
	let dir = path.dirname(fileURLToPath(import.meta.url));
	for (let i = 0; i < 8; i += 1) {
		try {
			const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as { name?: unknown; version?: unknown };
			if (pkg && pkg.name === "macuse" && typeof pkg.version === "string") return pkg.version;
		} catch {
			// Keep walking up the tree.
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return "0.0.0-unknown";
}

export const DEFAULT_TOOL_TIMEOUT_MS = 90_000;
export const DEFAULT_MAX_TEXT_CHARS = 20_000;
export const WAIT_TOOLS = new Set(["waitForText", "waitForURL", "waitForTitle", "waitForElement", "waitUntilElementEnabled", "waitUntilElementDisabled"]);
export const UPSTREAM_COMPUTER_USE_TOOLS = MCP_SERVERS["computer-use"].tools;
export const READ_ONLY_TOOLS = new Set(["list_apps", "get_app_state", "event_stream_status", "computer_history_status", "computer_history_get_settings", ...WAIT_TOOLS]);
export const APP_SCOPED_TOOLS = new Set([
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
export const FEATURE_FLAGS = ["computer_use", "plugins", "tool_call_mcp_elicitation"];
export const PROCESS_REGISTRY_DIR = "/tmp/macuse-appserver";
export const PROCESS_REGISTRY_PREFIX = "macuse-appserver-";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export function validateAuxiliarySafety(tool: string, input: Record<string, JsonValue>): void {
	const note = typeof input.safetyNote === "string" ? input.safetyNote.trim() : "";
	if ((tool === "event_stream_start" || tool === "computer_history_resume") && (input.allowRecording !== true || !note)) throw new Error(`${tool} requires allowRecording:true and a non-empty safetyNote.`);
	if (tool !== "computer_history_update_settings") return;
	if (input.allowPrivacyChange !== true || !note) throw new Error(`${tool} requires allowPrivacyChange:true and a non-empty safetyNote.`);
	const observation = input.observation;
	const validEntries = (value: unknown): boolean => Array.isArray(value) && value.every((entry) => entry && typeof entry === "object" && !Array.isArray(entry)
		&& (((entry as Record<string, unknown>).scope === "app" && typeof (entry as Record<string, unknown>).bundleID === "string" && String((entry as Record<string, unknown>).bundleID).trim())
			|| ((entry as Record<string, unknown>).scope === "url" && typeof (entry as Record<string, unknown>).urlDomain === "string" && String((entry as Record<string, unknown>).urlDomain).trim() && !String((entry as Record<string, unknown>).urlDomain).includes("://") && !String((entry as Record<string, unknown>).urlDomain).includes("/"))));
	if (!observation || typeof observation !== "object" || Array.isArray(observation)) throw new Error(`${tool} requires all Computer History settings fields and valid scope-specific allowlist/blocklist entries.`);
	const settings = observation as Record<string, unknown>;
	if ((settings.defaultApplicationBehavior !== "observe" && settings.defaultApplicationBehavior !== "do_not_observe")
		|| (settings.defaultURLBehavior !== "observe" && settings.defaultURLBehavior !== "do_not_observe")
		|| !validEntries(settings.allowlist)
		|| !validEntries(settings.blocklist)) {
		throw new Error(`${tool} requires all Computer History settings fields and valid scope-specific allowlist/blocklist entries.`);
	}
}

export type TextContentBlock = { type: "text"; text: string; [key: string]: JsonValue };
export type ImageContentBlock = { type: "image"; data: string; mimeType: string; [key: string]: JsonValue };
export type ContentBlock = TextContentBlock | ImageContentBlock | { type: string; [key: string]: JsonValue };

export type ComputerUseToolResult = {
	content?: unknown[];
	isError?: boolean;
	is_error?: boolean;
	_meta?: JsonValue;
	meta?: JsonValue;
};

export type ComputerUseInventory = {
	server: string;
	present: boolean;
	authStatus: string | null;
	toolNames: string[];
	toolCount: number;
	missingTools: string[];
	checkedAt: string | null;
};

export type SavedImageArtifact = {
	path: string;
	bytes: number;
	sha256: string;
	width: number | null;
	height: number | null;
};

export type FilteredToolResult = {
	content: ContentBlock[];
	isError: boolean;
	meta: JsonValue;
	omittedImages: number;
	savedImagePath: string | null;
	savedImageArtifact: SavedImageArtifact | null;
};

export type ApprovalMode = "inherit" | "accept-all" | "accept-once" | "deny";

export type SequenceStep = {
	tool: string;
	arguments: Record<string, JsonValue>;
	label?: string;
	expectText: string[];
	expectAbsentText: string[];
	expectVisibleText: string[];
	allowError: boolean;
	requireStateChange: boolean;
};

export type ListAppsParams = {
	runningOnly?: boolean;
	filter?: string;
	maxTextChars?: number;
	toolTimeoutMs?: number;
};

export type TargetScope = "all" | "main";

export type GetAppStateParams = {
	app: string;
	approval?: ApprovalMode;
	includeImage?: boolean;
	saveImagePath?: string;
	detail?: DetailMode;
	targetScope?: TargetScope;
	trackFocus?: boolean;
	maxTextChars?: number;
	toolTimeoutMs?: number;
};

export type SequenceParams = {
	app?: string;
	steps: unknown;
	approval?: ApprovalMode;
	allowMutating?: boolean;
	allowRecording?: boolean;
	allowPrivacyChange?: boolean;
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

export type DetailMode = "compact" | "full" | "minimal";

export type ElementInfo = {
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

export type MachineElement = Pick<ElementInfo, "index" | "id" | "description" | "role" | "name" | "value" | "disabled" | "tags" | "group" | "secondaryActions"> & { targetHint: string; line: string };

export type StateSummary = {
	app: string | null;
	window: string | null;
	title: string | null;
	url: string | null;
	visibleText: string[];
	targets: MachineElement[];
};

export type ChangeSummary = {
	visibleTextChanged: boolean;
	addedVisibleText: string[];
	removedVisibleText: string[];
	targetsAdded: string[];
	targetsRemoved: string[];
	titleChanged: boolean;
	urlChanged: boolean;
	summary: string[];
};

export type AppMetadata = {
	name: string;
	path: string | null;
	bundleId: string | null;
	flags: string[];
	running: boolean;
	frontmost: boolean;
	lastUsed: string | null;
	line: string;
};

export type FocusSnapshot = {
	frontmost: AppMetadata[];
	frontmostNames: string[];
	changed: boolean | null;
	before: AppMetadata[] | null;
	after: AppMetadata[] | null;
};

export type SequenceFailure = {
	index: number;
	stepNumber: number;
	tool: string;
	label?: string;
	message: string;
};

export type SequencedResult = {
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

export type MousePosition = { x: number; y: number };

export class ComputerUseError extends Error {
	details?: unknown;

	constructor(message: string, details?: unknown) {
		super(message);
		this.name = "ComputerUseError";
		this.details = details;
	}
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function asInt(value: unknown, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.max(1, Math.trunc(value));
}

export function truncateString(value: string, max: number): string {
	if (value.length <= max) return value;
	return `${value.slice(0, max)}…[${value.length} chars]`;
}

export function stripInvisibleBidiMarks(value: string): string {
	return value.replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");
}

export function normalizeStringList(value: unknown, name: string): string[] {
	if (value === undefined || value === null) return [];
	if (typeof value === "string") return [value];
	if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value;
	throw new Error(`${name} must be a string or array of strings.`);
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function bridgeDetails(base: Record<string, unknown>, stderrTail: string): Record<string, unknown> {
	return {
		computerUse: {
			version: VERSION,
			persistentAppServer: true,
			...base,
		},
		stderrTail,
	};
}

