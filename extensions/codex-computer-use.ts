import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { TSchema } from "typebox";
import {
	DEFAULT_MAX_TEXT_CHARS,
	DEFAULT_TOOL_TIMEOUT_MS,
	asInt,
	bridgeDetails,
	type ElementInfo,
	type GetAppStateParams,
	type ImageContentBlock,
	type JsonValue,
	type ListAppsParams,
	type SequenceParams,
	type TargetScope,
	type TextContentBlock,
} from "./codex-computer-use-modules/core";
import { filterToolResult } from "./codex-computer-use-modules/content";
import {
	appendElementStabilityNote,
	compactContent,
	machineElements,
	minimalContent,
	normalizeDetail,
	stateSummary,
	truncateTextContent,
	updateElementCache,
} from "./codex-computer-use-modules/elements-state";
import {
	focusSnapshot,
	focusSummaryText,
	listAppsDisplayContent,
	parseAppListContent,
} from "./codex-computer-use-modules/apps";
import { appendComputerUseDiagnostic, appendImageWarning } from "./codex-computer-use-modules/diagnostics";
import { AppServerClient } from "./codex-computer-use-modules/app-server-client";
import { restartComputerUseRuntime } from "./codex-computer-use-modules/computer-use-recovery";
import { captureFocusSnapshot, executeSequence } from "./codex-computer-use-modules/sequence-runner";

const timeoutParam = Type.Optional(Type.Number({ minimum: 1_000, maximum: 300_000, description: "Tool timeout ms. Default 90000." }));
const maxTextParam = Type.Optional(Type.Number({ minimum: 1_000, maximum: 200_000, description: "Max characters per text block. Default 20000." }));
const approvalParam = Type.Optional(StringEnum(["inherit", "accept-all", "accept-once", "deny"] as const, { description: "App-approval prompt handling. Default inherit auto-accepts, matching Codex's Any App setting." }));
const detailParam = Type.Optional(StringEnum(["minimal", "compact", "full"] as const, { description: "Output detail: minimal (app/window summary + target hints), compact (interactive elements only), full (raw text)." }));
const targetScopeParam = Type.Optional(StringEnum(["all", "main"] as const, { description: "main suppresses likely app/browser chrome and window controls." }));
const appParam = Type.String({ description: "App name, path, or bundle ID, e.g. Activity Monitor or com.apple.ActivityMonitor." });
const elementIndexParam = Type.Union([Type.String(), Type.Number()], { description: "Computer Use element index. Numbers are coerced to strings." });
const bareElementIndexParam = Type.Union([Type.String(), Type.Number()]);
const elementTargetCandidateParam = Type.Object({
	element_index: Type.Optional(bareElementIndexParam),
	element: Type.Optional(bareElementIndexParam),
	elementId: Type.Optional(Type.String()),
	element_id: Type.Optional(Type.String()),
	elementDescription: Type.Optional(Type.String()),
	element_description: Type.Optional(Type.String()),
	role: Type.Optional(Type.String()),
	elementRole: Type.Optional(Type.String()),
	name: Type.Optional(Type.String()),
	elementName: Type.Optional(Type.String()),
}, { additionalProperties: false });
const elementTargetParams = {
	element_index: Type.Optional(elementIndexParam),
	element: Type.Optional(Type.Union([Type.String(), Type.Number()], { description: "Alias for element_index." })),
	elementId: Type.Optional(Type.String({ description: "Stable element ID from get_app_state." })),
	element_id: Type.Optional(Type.String({ description: "Alias for elementId." })),
	elementDescription: Type.Optional(Type.String({ description: "Exact case-insensitive element description from get_app_state." })),
	element_description: Type.Optional(Type.String({ description: "Alias for elementDescription." })),
	role: Type.Optional(Type.String({ description: "Element role, used with name when stable IDs/descriptions are unavailable." })),
	elementRole: Type.Optional(Type.String({ description: "Alias for role." })),
	name: Type.Optional(Type.String({ description: "Element name, used with role." })),
	elementName: Type.Optional(Type.String({ description: "Alias for name." })),
	targets: Type.Optional(Type.Array(elementTargetCandidateParam, { description: "Ordered fallback targets resolved against fresh app state." })),
	expectedRole: Type.Optional(Type.String({ description: "Fail-closed stale guard for raw element_index." })),
	expectedName: Type.Optional(Type.String({ description: "Stale guard, as expectedRole." })),
	expectedDescription: Type.Optional(Type.String({ description: "Stale guard, as expectedRole." })),
	expectedId: Type.Optional(Type.String({ description: "Stale guard, as expectedRole." })),
	expectedValue: Type.Optional(Type.String({ description: "Stale guard, as expectedRole." })),
};
const directMutationParams = {
	allowMutating: Type.Boolean({ description: "Must be true. Explicitly authorizes this guarded app mutation." }),
	safetyNote: Type.String({ minLength: 20, description: "Target app, intended effect, and stop boundary." }),
	approval: approvalParam,
	requireStateChange: Type.Optional(Type.Boolean({ description: "Fail closed when post-action readback shows no observable change." })),
	includeImage: Type.Optional(Type.Boolean({ description: "Attach post-action screenshot blocks when supported." })),
	saveImagePath: Type.Optional(Type.String({ description: "Save a post-action screenshot artifact to this path." })),
	detail: detailParam,
	targetScope: targetScopeParam,
	maxTextChars: maxTextParam,
	toolTimeoutMs: timeoutParam,
};

const sequenceStepParam = Type.Object({
	tool: Type.Optional(Type.String({ description: "Computer Use tool name or wait helper." })),
	arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Tool arguments. Stable target selectors and stale guards are supported." })),
	value: Type.Optional(Type.Unknown({ description: "Shorthand for set_value when arguments.value is omitted." })),
	label: Type.Optional(Type.String()),
	expectText: Type.Optional(Type.Array(Type.String())),
	expectAbsentText: Type.Optional(Type.Array(Type.String())),
	expectVisibleText: Type.Optional(Type.Array(Type.String())),
	allowError: Type.Optional(Type.Boolean()),
	requireStateChange: Type.Optional(Type.Boolean()),
}, { additionalProperties: true });

const listAppsParam = Type.Object({
	runningOnly: Type.Optional(Type.Boolean({ description: "Return only currently running apps. Default false." })),
	filter: Type.Optional(Type.String({ description: "Case-insensitive substring filter across app name, path, and bundle ID." })),
	maxTextChars: maxTextParam,
	toolTimeoutMs: timeoutParam,
}, { additionalProperties: false });
const getAppStateParam = Type.Object({
	app: appParam,
	approval: approvalParam,
	includeImage: Type.Optional(Type.Boolean({ description: "Attach the screenshot image when supported. saveImagePath is the reliable artifact path." })),
	saveImagePath: Type.Optional(Type.String()),
	detail: detailParam,
	targetScope: targetScopeParam,
	trackFocus: Type.Optional(Type.Boolean({ description: "Capture native frontmost-app focus before and after this read." })),
	maxTextChars: maxTextParam,
	toolTimeoutMs: timeoutParam,
}, { additionalProperties: false });
const sequenceParam = Type.Object({
	app: Type.Optional(appParam),
	steps: Type.Array(sequenceStepParam, { minItems: 1 }),
	approval: approvalParam,
	allowMutating: Type.Optional(Type.Boolean({ description: "Required when any step mutates app state." })),
	allowPointerClick: Type.Optional(Type.Boolean({ description: "Required for pointer click steps." })),
	allowPointerDrag: Type.Optional(Type.Boolean({ description: "Required for pointer drag steps." })),
	safetyNote: Type.Optional(Type.String({ description: "Required for mutations; state target app, intended effect, and stop boundary." })),
	includeImage: Type.Optional(Type.Boolean()),
	saveImagePath: Type.Optional(Type.String()),
	screenshotStep: Type.Optional(StringEnum(["first", "final"] as const)),
	detail: detailParam,
	targetScope: targetScopeParam,
	maxTextChars: maxTextParam,
	toolTimeoutMs: timeoutParam,
}, { additionalProperties: false });
const restartParam = Type.Object({
	reason: Type.Optional(Type.String()),
	toolTimeoutMs: timeoutParam,
}, { additionalProperties: false });

const observationEntryParam = Type.Object({
	scope: StringEnum(["app", "url"] as const),
	bundleID: Type.Optional(Type.String({ description: "Required only for app rules." })),
	urlDomain: Type.Optional(Type.String({ description: "Required only for URL rules. Use a bare domain without scheme or path." })),
}, { additionalProperties: false });
const observationParam = Type.Object({
	defaultApplicationBehavior: StringEnum(["observe", "do_not_observe"] as const),
	defaultURLBehavior: StringEnum(["observe", "do_not_observe"] as const),
	allowlist: Type.Array(observationEntryParam),
	blocklist: Type.Array(observationEntryParam),
}, { additionalProperties: false });

const mutationToolSpecs = [
	{
		name: "perform_secondary_action",
		label: "Computer Use Secondary Action",
		description: "Invoke an accessibility secondary action on an element. Prefer action:Press over pointer click. Stable targets are refreshed before execution.",
		promptSnippet: "Invoke a guarded accessibility action in a macOS app",
		parameters: Type.Object({ app: appParam, ...elementTargetParams, action: Type.String(), ...directMutationParams }, { additionalProperties: false }),
	},
	{
		name: "press_key",
		label: "Computer Use Press Key",
		description: "Press a key or key combination in a target macOS app. Call get_app_state first to verify the app/window.",
		promptSnippet: "Press a guarded key combination in a macOS app",
		parameters: Type.Object({ app: appParam, key: Type.String(), modifiers: Type.Optional(Type.Array(Type.String())), ...directMutationParams }, { additionalProperties: false }),
	},
	{
		name: "type_text",
		label: "Computer Use Type Text",
		description: "Type literal text into the currently focused control in a target macOS app. Call get_app_state first.",
		promptSnippet: "Type guarded literal text in a macOS app",
		parameters: Type.Object({ app: appParam, text: Type.String(), ...directMutationParams }, { additionalProperties: false }),
	},
	{
		name: "set_value",
		label: "Computer Use Set Value",
		description: "Set a settable accessibility element value. Stable targets are refreshed; empty search values can use the conservative clear-control fallback.",
		promptSnippet: "Set a guarded accessibility field value in a macOS app",
		parameters: Type.Object({ app: appParam, ...elementTargetParams, value: Type.String(), ...directMutationParams }, { additionalProperties: false }),
	},
	{
		name: "select_text",
		label: "Computer Use Select Text",
		description: "Select text in a text element or place its cursor before/after the exact text. Stable targets are refreshed.",
		promptSnippet: "Select text or position a cursor in a macOS app",
		parameters: Type.Object({ app: appParam, ...elementTargetParams, text: Type.String(), prefix: Type.Optional(Type.String()), suffix: Type.Optional(Type.String()), selection: Type.Optional(StringEnum(["text", "cursor_before", "cursor_after"] as const)), ...directMutationParams }, { additionalProperties: false }),
	},
	{
		name: "scroll",
		label: "Computer Use Scroll",
		description: "Scroll an accessibility element by direction and page count. Stable targets are refreshed.",
		promptSnippet: "Scroll a guarded macOS app element",
		parameters: Type.Object({ app: appParam, ...elementTargetParams, direction: StringEnum(["up", "down", "left", "right"] as const), pages: Type.Optional(Type.Number()), ...directMutationParams }, { additionalProperties: false }),
	},
	{
		name: "click",
		label: "Computer Use Click",
		description: "Pointer click by stable target, element index, or screenshot coordinates. Requires allowPointer:true and restores mouse position. Prefer perform_secondary_action.",
		promptSnippet: "Perform an explicitly authorized pointer click in a macOS app",
		parameters: Type.Object({ app: appParam, ...elementTargetParams, x: Type.Optional(Type.Number()), y: Type.Optional(Type.Number()), mouse_button: Type.Optional(StringEnum(["left", "right", "middle"] as const)), click_count: Type.Optional(Type.Integer()), allowPointer: Type.Boolean(), ...directMutationParams }, { additionalProperties: false }),
	},
	{
		name: "drag",
		label: "Computer Use Drag",
		description: "Pointer drag using screenshot coordinates. Requires allowPointer:true and restores mouse position.",
		promptSnippet: "Perform an explicitly authorized pointer drag in a macOS app",
		parameters: Type.Object({ app: appParam, from_x: Type.Number(), from_y: Type.Number(), to_x: Type.Number(), to_y: Type.Number(), allowPointer: Type.Boolean(), ...directMutationParams }, { additionalProperties: false }),
	},
] as const;

const auxiliaryToolSpecs = [
	{
		name: "event_stream_start",
		server: "event-stream",
		label: "Record & Replay Start",
		description: "Start Record & Replay activity recording. Requires exact user intent, allowRecording:true, and a safety note.",
		promptSnippet: "Start explicitly authorized Record & Replay activity recording",
		parameters: Type.Object({ allowRecording: Type.Boolean(), safetyNote: Type.String({ minLength: 1 }), toolTimeoutMs: timeoutParam }, { additionalProperties: false }),
	},
	{
		name: "event_stream_status",
		server: "event-stream",
		label: "Record & Replay Status",
		description: "Read Record & Replay status. Read-only, but exposes activity and artifact metadata.",
		promptSnippet: "Read Record & Replay recording status",
		parameters: Type.Object({ toolTimeoutMs: timeoutParam }, { additionalProperties: false }),
	},
	{
		name: "event_stream_stop",
		server: "event-stream",
		label: "Record & Replay Stop",
		description: "Stop Record & Replay activity recording.",
		promptSnippet: "Stop Record & Replay activity recording",
		parameters: Type.Object({ toolTimeoutMs: timeoutParam }, { additionalProperties: false }),
	},
	{
		name: "computer_history_pause",
		server: "computer-history",
		label: "Computer History Pause",
		description: "Pause Computer History recording.",
		promptSnippet: "Pause Computer History recording",
		parameters: Type.Object({ toolTimeoutMs: timeoutParam }, { additionalProperties: false }),
	},
	{
		name: "computer_history_resume",
		server: "computer-history",
		label: "Computer History Resume",
		description: "Resume Computer History recording. Requires exact user intent, allowRecording:true, and a safety note.",
		promptSnippet: "Resume explicitly authorized Computer History recording",
		parameters: Type.Object({ allowRecording: Type.Boolean(), safetyNote: Type.String({ minLength: 1 }), toolTimeoutMs: timeoutParam }, { additionalProperties: false }),
	},
	{
		name: "computer_history_status",
		server: "computer-history",
		label: "Computer History Status",
		description: "Read Computer History status. Read-only, but exposes activity metadata.",
		promptSnippet: "Read Computer History status",
		parameters: Type.Object({ toolTimeoutMs: timeoutParam }, { additionalProperties: false }),
	},
	{
		name: "computer_history_get_settings",
		server: "computer-history",
		label: "Computer History Settings",
		description: "Read all Computer History settings. Read-only, but exposes privacy metadata; call immediately before update_settings.",
		promptSnippet: "Read Computer History privacy settings",
		parameters: Type.Object({ toolTimeoutMs: timeoutParam }, { additionalProperties: false }),
	},
	{
		name: "computer_history_update_settings",
		server: "computer-history",
		label: "Computer History Update Settings",
		description: "Replace all Computer History settings. Read current settings first and preserve every unchanged field, including showMenuBarIcon. Requires exact approval, allowPrivacyChange:true, and a safety note.",
		promptSnippet: "Replace explicitly authorized Computer History privacy settings",
		parameters: Type.Object({ observation: observationParam, showMenuBarIcon: Type.Optional(Type.Boolean()), allowPrivacyChange: Type.Boolean(), safetyNote: Type.String({ minLength: 1 }), toolTimeoutMs: timeoutParam }, { additionalProperties: false }),
	},
] as const;

const lazyToolNames = [
	"perform_secondary_action",
	"press_key",
	"type_text",
	"set_value",
	"select_text",
	"scroll",
	"click",
	"drag",
	"event_stream_start",
	"event_stream_status",
	"event_stream_stop",
	"computer_history_pause",
	"computer_history_resume",
	"computer_history_status",
	"computer_history_get_settings",
	"computer_history_update_settings",
	"macuse_restart",
] as const;
const lazyToolNameSet = new Set<string>(lazyToolNames);
const loadToolsParam = Type.Object({
	tools: Type.Array(StringEnum(lazyToolNames), { minItems: 1, uniqueItems: true, description: "Exact macuse tools to enable for this session." }),
}, { additionalProperties: false });

type ToolSpec<TParams extends TSchema = TSchema> = {
	name: string;
	label: string;
	description: string;
	promptSnippet: string;
	parameters: TParams;
};

let client: AppServerClient | null = null;
const sessionElementCache = new Map<string, ElementInfo[]>();

function getClient(): AppServerClient {
	if (!client) client = new AppServerClient();
	return client;
}

function validateComputerHistoryObservation(input: Record<string, JsonValue>, tool: string): void {
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

async function executeListApps(input: ListAppsParams, signal: AbortSignal | undefined, onUpdate?: (update: { content: TextContentBlock[]; details: Record<string, unknown> }) => void) {
	onUpdate?.({ content: [{ type: "text", text: "Calling Computer Use list_apps..." }], details: {} });
	const toolTimeoutMs = asInt(input.toolTimeoutMs, DEFAULT_TOOL_TIMEOUT_MS);
	const maxTextChars = asInt(input.maxTextChars, DEFAULT_MAX_TEXT_CHARS);
	const call = await getClient().callTool("list_apps", {}, { approval: "inherit", timeoutMs: toolTimeoutMs, signal });
	const result = filterToolResult(call.result, { maxTextChars });
	const diagnostics = [appendComputerUseDiagnostic(result, "list_apps", {})].filter((item): item is string => Boolean(item));
	const apps = result.isError ? [] : parseAppListContent(result.content, { runningOnly: Boolean(input.runningOnly), filter: input.filter });
	return {
		content: listAppsDisplayContent(result, { runningOnly: Boolean(input.runningOnly), filter: input.filter, maxTextChars }) as (TextContentBlock | ImageContentBlock)[],
		details: bridgeDetails({ tool: "list_apps", computerUseTool: "list_apps", threadId: getClient().status().threadId, isError: result.isError, omittedImages: result.omittedImages, runningOnly: Boolean(input.runningOnly), filter: input.filter ?? null, apps, frontmostApps: apps.filter((app) => app.frontmost), diagnostics, acceptedElicitations: call.acceptedElicitations, elicitationCount: call.elicitationCount, durationMs: call.durationMs, computerUseRecoveryEvents: getClient().status().computerUseRecoveryEvents }, getClient().status().stderrTail),
	};
}

async function executeGetAppState(input: GetAppStateParams, signal: AbortSignal | undefined, onUpdate?: (update: { content: TextContentBlock[]; details: Record<string, unknown> }) => void) {
	const app = input.app;
	const approval = input.approval || "inherit";
	onUpdate?.({ content: [{ type: "text", text: `Calling Computer Use get_app_state for ${app} with approval=${approval}...` }], details: {} });
	const toolTimeoutMs = asInt(input.toolTimeoutMs, DEFAULT_TOOL_TIMEOUT_MS);
	const maxTextChars = asInt(input.maxTextChars, DEFAULT_MAX_TEXT_CHARS);
	const detail = normalizeDetail(input.detail, "full");
	const targetScope: TargetScope = input.targetScope === "main" ? "main" : "all";
	const trackFocus = input.trackFocus === true;
	const frontmostBefore = trackFocus ? await captureFocusSnapshot() : null;
	const call = await getClient().callTool("get_app_state", { app }, { approval, timeoutMs: toolTimeoutMs, signal });
	const frontmostAfter = trackFocus ? await captureFocusSnapshot() : null;
	const result = filterToolResult(call.result, { includeImage: Boolean(input.includeImage), saveImagePath: input.saveImagePath, maxTextChars });
	updateElementCache(sessionElementCache, app, result.content);
	const diagnostics = [appendComputerUseDiagnostic(result, "get_app_state", { app })].filter((item): item is string => Boolean(item));
	if (detail === "full") appendElementStabilityNote(result);
	appendImageWarning(result, { includeImage: Boolean(input.includeImage), saveImagePath: input.saveImagePath });
	const focus = focusSnapshot(frontmostBefore, frontmostAfter);
	const transformedContent = detail === "minimal" ? minimalContent(result.content, targetScope) : detail === "compact" ? compactContent(result.content, targetScope) : result.content;
	const focusLine = trackFocus ? { type: "text" as const, text: focusSummaryText(focus, app) } : null;
	return {
		content: truncateTextContent(focusLine ? [...transformedContent, focusLine] : transformedContent, maxTextChars) as (TextContentBlock | ImageContentBlock)[],
		details: bridgeDetails({ tool: "get_app_state", computerUseTool: "get_app_state", threadId: getClient().status().threadId, isError: result.isError, omittedImages: result.omittedImages, savedImagePath: result.savedImagePath, savedImageArtifact: result.savedImageArtifact, imageSupportNote: input.includeImage ? "Image rendering is model/host dependent; saveImagePath is the reliable screenshot artifact path." : null, detail, targetScope, ...stateSummary(result.content, targetScope), focus, diagnostics, elements: machineElements(result.content, targetScope), acceptedElicitations: call.acceptedElicitations, elicitationCount: call.elicitationCount, durationMs: call.durationMs, computerUseRecoveryEvents: getClient().status().computerUseRecoveryEvents }, getClient().status().stderrTail),
	};
}

async function executeDirectMutation(tool: string, input: Record<string, JsonValue>, signal: AbortSignal | undefined, onUpdate?: (update: { content: TextContentBlock[]; details: Record<string, unknown> }) => void) {
	const {
		allowMutating,
		safetyNote,
		allowPointer,
		approval,
		requireStateChange,
		includeImage,
		saveImagePath,
		detail,
		targetScope,
		maxTextChars,
		toolTimeoutMs,
		...argumentsForTool
	} = input;
	return executeSequence({
		app: typeof argumentsForTool.app === "string" ? argumentsForTool.app : undefined,
		steps: [{ tool, arguments: argumentsForTool, requireStateChange: requireStateChange === true }],
		allowMutating: allowMutating === true,
		safetyNote: typeof safetyNote === "string" ? safetyNote : undefined,
		allowPointerClick: tool === "click" ? allowPointer === true : undefined,
		allowPointerDrag: tool === "drag" ? allowPointer === true : undefined,
		approval,
		includeImage: includeImage === true,
		saveImagePath: typeof saveImagePath === "string" ? saveImagePath : undefined,
		detail,
		targetScope,
		maxTextChars,
		toolTimeoutMs,
	} as SequenceParams, signal, onUpdate, getClient, sessionElementCache, tool);
}

async function executeAuxiliaryTool(tool: string, server: "event-stream" | "computer-history", input: Record<string, JsonValue>, signal: AbortSignal | undefined) {
	const note = typeof input.safetyNote === "string" ? input.safetyNote.trim() : "";
	if ((tool === "event_stream_start" || tool === "computer_history_resume") && (input.allowRecording !== true || !note)) throw new Error(`${tool} requires allowRecording:true and a non-empty safetyNote.`);
	if (tool === "computer_history_update_settings") {
		if (input.allowPrivacyChange !== true || !note) throw new Error(`${tool} requires allowPrivacyChange:true and a non-empty safetyNote.`);
		validateComputerHistoryObservation(input, tool);
	}
	const args = { ...input };
	delete args.allowRecording;
	delete args.allowPrivacyChange;
	delete args.safetyNote;
	delete args.toolTimeoutMs;
	const call = await getClient().callTool(tool, args, { approval: "inherit", timeoutMs: asInt(input.toolTimeoutMs, DEFAULT_TOOL_TIMEOUT_MS), signal, server });
	const result = filterToolResult(call.result, { maxTextChars: DEFAULT_MAX_TEXT_CHARS });
	return {
		content: result.content as (TextContentBlock | ImageContentBlock)[],
		details: bridgeDetails({ tool, auxiliaryTool: tool, threadId: getClient().status().threadId, isError: result.isError, durationMs: call.durationMs, acceptedElicitations: call.acceptedElicitations, elicitationCount: call.elicitationCount, computerUseRecoveryEvents: getClient().status().computerUseRecoveryEvents }, getClient().status().stderrTail),
	};
}

function registerMutationTool(pi: ExtensionAPI, spec: ToolSpec): void {
	pi.registerTool({
		...spec,
		executionMode: "sequential",
		promptGuidelines: [
			`Use ${spec.name} only after get_app_state has identified the exact target app/window; pass allowMutating:true and a concrete safetyNote.`,
			...(spec.name === "click" ? ["Prefer perform_secondary_action with action:Press over click when accessibility exposes it; click also requires allowPointer:true."] : []),
			...(spec.name === "drag" ? ["drag requires allowPointer:true and restores mouse position after the call."] : []),
		],
		async execute(_toolCallId, params, signal, onUpdate) {
			const forwardUpdate = onUpdate ? (update: { content: TextContentBlock[]; details: Record<string, unknown> }) => onUpdate(update) : undefined;
			return executeDirectMutation(spec.name, params as unknown as Record<string, JsonValue>, signal, forwardUpdate);
		},
	});
}

function registerAuxiliaryTool(pi: ExtensionAPI, spec: ToolSpec & { server: "event-stream" | "computer-history" }): void {
	pi.registerTool({
		name: spec.name,
		label: spec.label,
		description: spec.description,
		promptSnippet: spec.promptSnippet,
		parameters: spec.parameters,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal) {
			return executeAuxiliaryTool(spec.name, spec.server, params as unknown as Record<string, JsonValue>, signal);
		},
	});
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", () => {
		sessionElementCache.clear();
		pi.setActiveTools(pi.getActiveTools().filter((name) => !lazyToolNameSet.has(name)));
	});
	pi.on("session_shutdown", async () => {
		sessionElementCache.clear();
		if (client) await client.stop();
		client = null;
	});

	pi.registerCommand("macuse-status", {
		description: "Show Codex Computer Use persistent app-server status without starting it",
		handler: async (_args, ctx) => {
			if (!client) {
				if (ctx.hasUI) ctx.ui.notify("macuse stopped; app-server has not been started in this pi session. It starts lazily on the first Computer Use tool call.", "warning");
				return;
			}
			const status = client.status();
			const reaped = status.staleReapSummary.filter((item) => item.action === "reaped-orphan").length;
			const inventories = status.inventories ? Object.values(status.inventories).map((inventory) => `${inventory.server}=${inventory.present ? `${inventory.toolCount} tools` : "missing"}${inventory.missingTools.length ? ` missing=${inventory.missingTools.join(",")}` : ""}`).join(" ") : "";
			if (ctx.hasUI) ctx.ui.notify(`macuse ${status.running ? "running" : "stopped"}${status.threadId ? ` thread=${status.threadId}` : ""}${status.processPid ? ` pid=${status.processPid}` : ""}${status.watchdogPid ? ` watchdog=${status.watchdogPid}` : ""}${inventories ? ` ${inventories}` : ""}${reaped ? ` reaped=${reaped}` : ""}`, status.running ? "info" : "warning");
		},
	});
	pi.registerCommand("macuse-stop", {
		description: "Stop the persistent Codex Computer Use app-server session",
		handler: async (_args, ctx) => {
			sessionElementCache.clear();
			if (client) await client.stop();
			client = null;
			if (ctx.hasUI) ctx.ui.notify("macuse Computer Use app-server stopped; it will restart lazily on the next tool call.", "info");
		},
	});
	pi.registerCommand("macuse-restart", {
		description: "Restart the persistent Codex Computer Use app-server session and Computer Use runtime helpers",
		handler: async (_args, ctx) => {
			sessionElementCache.clear();
			const recovery = restartComputerUseRuntime("/macuse-restart command");
			await getClient().restart();
			if (ctx.hasUI) ctx.ui.notify(`macuse Computer Use runtime restarted (${recovery.targets.length} helper signal event${recovery.targets.length === 1 ? "" : "s"}); app-server will restart on the next tool call.`, "info");
		},
	});

	pi.registerTool({
		name: "list_apps",
		label: "Computer Use List Apps",
		description: "List apps known to Codex Computer Use. Read-only; supports running-only and substring filtering.",
		promptSnippet: "List local macOS apps available to Computer Use",
		promptGuidelines: ["Use list_apps to discover the exact app name, bundle ID, or path before get_app_state when the target is uncertain."],
		parameters: listAppsParam,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, onUpdate) {
			const forwardUpdate = onUpdate ? (update: { content: TextContentBlock[]; details: Record<string, unknown> }) => onUpdate(update) : undefined;
			return executeListApps(params, signal, forwardUpdate);
		},
	});
	pi.registerTool({
		name: "get_app_state",
		label: "Computer Use App State",
		description: "Start or refresh a Computer Use session for a macOS app and return its accessibility tree plus optional screenshot. Read-only but may reveal visible app content.",
		promptSnippet: "Inspect a local macOS app window with Computer Use",
		promptGuidelines: ["Use get_app_state before any mutating Computer Use tool; prefer elementId, then elementDescription, then unique role/name, then guarded element_index."],
		parameters: getAppStateParam,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, onUpdate) {
			const forwardUpdate = onUpdate ? (update: { content: TextContentBlock[]; details: Record<string, unknown> }) => onUpdate(update) : undefined;
			return executeGetAppState(params, signal, forwardUpdate);
		},
	});
	for (const spec of mutationToolSpecs) registerMutationTool(pi, spec);
	for (const spec of auxiliaryToolSpecs) registerAuxiliaryTool(pi, spec);

	pi.registerTool({
		name: "macuse_sequence",
		label: "macuse Sequence",
		description: "Run an ordered multi-step Computer Use flow with assertions, waits, stable target resolution, mutation gates, focus evidence, and resumable failure details.",
		promptSnippet: "Run a guarded multi-step macOS Computer Use workflow",
		promptGuidelines: [
			"Use macuse_sequence for multi-step native-app flows; start with get_app_state or call it first, keep mutations narrow, set allowMutating:true, and include a concrete safetyNote.",
			"Prefer perform_secondary_action, press_key, set_value, select_text, or scroll over pointer click/drag in macuse_sequence; pointer steps require their explicit pointer flags.",
		],
		parameters: sequenceParam,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, onUpdate) {
			const forwardUpdate = onUpdate ? (update: { content: TextContentBlock[]; details: Record<string, unknown> }) => onUpdate(update) : undefined;
			return executeSequence(params, signal, forwardUpdate, getClient, sessionElementCache);
		},
	});
	pi.registerTool({
		name: "macuse_tools",
		label: "macuse Tools",
		description: "Enable exact registered macuse tools for this session. Load only the tools needed for the current task.",
		promptSnippet: "Enable inactive macuse tools for direct Computer Use, recording, history, or recovery",
		promptGuidelines: ["Use macuse_tools to enable only the exact inactive macuse tools needed; enabled tools stay active for the session."],
		parameters: loadToolsParam,
		executionMode: "sequential",
		async execute(_toolCallId, params) {
			const active = pi.getActiveTools();
			const added = params.tools.filter((name) => !active.includes(name));
			if (added.length) pi.setActiveTools([...active, ...added]);
			return {
				content: [{ type: "text" as const, text: added.length ? `Enabled macuse tools: ${added.join(", ")}` : "Requested macuse tools are already enabled." }],
				details: { added },
			};
		},
	});
	pi.registerTool({
		name: "macuse_restart",
		label: "macuse Restart",
		description: "Restart Computer Use runtime helpers and the extension-owned app-server session, then leave the tool ready for retry.",
		promptSnippet: "Restart a stopped or transport-broken Computer Use runtime",
		parameters: restartParam,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, onUpdate) {
			onUpdate?.({ content: [{ type: "text", text: "Restarting macuse Computer Use runtime helpers..." }], details: {} });
			const reason = typeof params.reason === "string" && params.reason.trim() ? params.reason.trim() : "macuse_restart tool";
			sessionElementCache.clear();
			const recovery = await getClient().recoverComputerUseSession(reason, asInt(params.toolTimeoutMs, DEFAULT_TOOL_TIMEOUT_MS), signal);
			return {
				content: [{ type: "text" as const, text: `Computer Use runtime restarted. Helper signal events: ${recovery.targets.length}. App-server thread is ready for retry.` }],
				details: bridgeDetails({ tool: "macuse_restart", computerUseTool: null, threadId: getClient().status().threadId, recovery }, getClient().status().stderrTail),
			};
		},
	});
}
