import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const VERSION = resolveMacuseVersion();
export const DEFAULT_CHATGPT_RESOURCES = "/Applications/ChatGPT.app/Contents/Resources";
export const DEFAULT_CODEX_BIN = path.join(DEFAULT_CHATGPT_RESOURCES, "codex");
export const DEFAULT_BUNDLED_COMPUTER_USE_PLUGIN_DIR = path.join(DEFAULT_CHATGPT_RESOURCES, "plugins/openai-bundled/plugins/computer-use");
export const DEFAULT_BUNDLED_COMPUTER_USE_CLIENT = path.join(DEFAULT_BUNDLED_COMPUTER_USE_PLUGIN_DIR, "Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient");

export const MCP_SERVERS = {
	"computer-use": { args: ["mcp"], tools: ["click", "drag", "get_app_state", "list_apps", "perform_secondary_action", "press_key", "scroll", "select_text", "set_value", "type_text"] },
	"event-stream": { args: ["event-stream", "mcp"], tools: ["event_stream_start", "event_stream_status", "event_stream_stop"] },
	skysight: { args: ["skysight", "mcp"], tools: ["skysight_list_exclusions", "skysight_start", "skysight_status", "skysight_stop", "skysight_update_exclusion"] },
} as const;
export type McpServerName = keyof typeof MCP_SERVERS;

export function mcpServerConfigs() {
	return Object.fromEntries(Object.entries(MCP_SERVERS).map(([name, server]) => [name, {
		command: DEFAULT_BUNDLED_COMPUTER_USE_CLIENT,
		args: [...server.args],
		cwd: DEFAULT_BUNDLED_COMPUTER_USE_PLUGIN_DIR,
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
export const READ_ONLY_TOOLS = new Set(["list_apps", "get_app_state", ...WAIT_TOOLS]);
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

