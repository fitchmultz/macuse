/**
 * Purpose: Expose Codex Computer Use as native pi tools through the Codex app-server bridge.
 * Responsibilities: Manage one persistent app-server session, register read-only and guarded mutating Computer Use tools, normalize stable element targets, and clean up session resources on reload/shutdown.
 * Scope: Pi extension runtime only; CLI smoke tests and install helpers live under tools/.
 * Usage: Loaded by pi through package.json#pi.extensions for global/local package installs.
 * Invariants/Assumptions: ChatGPT.app is installed locally with the bundled Codex app-server and Computer Use plugin, Computer Use is macOS-only, mutating actions remain explicitly gated, and the persistent app-server thread is extension-owned.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import {
	APP_SCOPED_TOOLS,
	ComputerUseError,
	DEFAULT_CODEX_BIN,
	DEFAULT_MAX_TEXT_CHARS,
	DEFAULT_TOOL_TIMEOUT_MS,
	FEATURE_FLAGS,
	PROCESS_REGISTRY_DIR,
	PROCESS_REGISTRY_PREFIX,
	READ_ONLY_TOOLS,
	UPSTREAM_COMPUTER_USE_TOOLS,
	VERSION,
	WAIT_TOOLS,
	asInt,
	isRecord,
	normalizeStringList,
	stripInvisibleBidiMarks,
	truncateString,
	type AppMetadata,
	type ApprovalMode,
	type ChangeSummary,
	type ComputerUseInventory,
	type ComputerUseToolResult,
	type ContentBlock,
	type DetailMode,
	type ElementInfo,
	type FilteredToolResult,
	type FocusSnapshot,
	type GetAppStateParams,
	type ImageContentBlock,
	type JsonValue,
	type ListAppsParams,
	type MachineElement,
	type MousePosition,
	type SavedImageArtifact,
	type SequenceFailure,
	type SequenceParams,
	type SequenceStep,
	type SequencedResult,
	type StateSummary,
	type TargetScope,
	type TextContentBlock,
	errorMessage,
	bridgeDetails,
} from "./codex-computer-use-modules/core";
import {
	filterToolResult,
	isImageBlock,
	isTextBlock,
	normalizeContent,
	summarizeContent,
	toolResultText,
} from "./codex-computer-use-modules/content";
import {
	appendElementStabilityNote,
	appendText,
	assertionContentText,
	compactContent,
	compareState,
	contentIncludesMultilineValue,
	contentText,
	describeTargetResolution,
	elementLineWithTargetHint,
	enrichActionError,
	hasElementTarget,
	hasMutatingSteps,
	hasStableSelector,
	hasStateSummaryContent,
	machineElements,
	normalizeAssertionText,
	normalizeDetail,
	normalizeToolArguments,
	minimalContent,
	observedStateChange,
	resolveElementDescription,
	resolveElementId,
	resolveElementRoleName,
	resolveElementTargetFallbacks,
	stateSummary,
	stripSelectorOnlyKeys,
	targetStateChanged,
	truncateTextContent,
	updateElementCache,
	validateIndexedTarget,
	visibleAssertionValues,
} from "./codex-computer-use-modules/elements-state";
import {
	listAppsDisplayContent,
	focusSnapshot,
	focusSummaryText,
	parseAppListContent,
} from "./codex-computer-use-modules/apps";
import {
	appendComputerUseDiagnostic,
	appendImageWarning,
	failureResult,
} from "./codex-computer-use-modules/diagnostics";
import { AppServerClient } from "./codex-computer-use-modules/app-server-client";
import {
	browserLikeAppName,
	isWaitTool,
	normalizeSequenceSteps,
	sequenceContent,
	validateStepResult,
	validateWaitArguments,
	waitConditionMet,
} from "./codex-computer-use-modules/sequence";
import { restartComputerUseRuntime } from "./codex-computer-use-modules/computer-use-recovery";
import { captureFocusSnapshot, executeSequence } from "./codex-computer-use-modules/sequence-runner";

const timeoutParam = Type.Optional(Type.Number({ minimum: 1_000, maximum: 300_000, description: "Tool timeout in milliseconds. Default 90000." }));
const maxTextParam = Type.Optional(Type.Number({ minimum: 1_000, maximum: 200_000, description: "Maximum characters per returned text block. Default 20000." }));
const approvalParam = Type.Optional(StringEnum(["inherit", "accept-all", "accept-once", "deny"] as const, { description: "How to answer Computer Use app-approval prompts. Default inherit, which auto-accepts app approvals to match Codex's Any App setting." }));
const detailParam = Type.Optional(StringEnum(["minimal", "compact", "full"] as const, { description: "Output detail. minimal returns app/window, visible text, and concise target hints; compact trims accessibility trees to interactive element lines; full returns the raw Computer Use text." }));

/**
 * Permissive object schema for one macuse action=sequence step. It advertises the
 * supported step fields to the model (vs. an opaque {}), but stays loose
 * (additionalProperties: true, all fields optional) so the runtime validator
 * normalizeSequenceSteps() remains the single hard gate on step shape.
 */
const sequenceStepParam = Type.Object(
	{
		tool: Type.Optional(Type.String({ description: "Computer Use tool name, e.g. get_app_state, perform_secondary_action, press_key, type_text, set_value, select_text, scroll, click, drag, or a wait helper (waitForText, waitForURL, waitForTitle, waitForElement, waitUntilElementEnabled, waitUntilElementDisabled)." })),
		arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Arguments object for the tool. Element targets accept element_index (string/number), element alias, elementId/element_id, elementDescription/element_description, role/name selectors, or arguments.targets fallback objects; raw index targets may pass expectedRole/expectedName/expectedDescription/expectedId/expectedValue stale guards. press_key accepts xdotool-style key combos or key plus modifiers, e.g. key:\",\", modifiers:[\"COMMAND\"] -> super+comma. set_value accepts value; wait helpers accept timeoutMs, intervalMs, toolTimeoutMs, visibleOnly, title, url." })),
		value: Type.Optional(Type.Unknown({ description: "Shorthand for set_value when arguments.value is omitted." })),
		label: Type.Optional(Type.String({ description: "Optional human-readable label for this step." })),
		expectText: Type.Optional(Type.Array(Type.String(), { description: "App content text/value substrings that must appear after this step (ignores macuse/upstream metadata)." })),
		expectAbsentText: Type.Optional(Type.Array(Type.String(), { description: "App content text substrings that must NOT appear after this step." })),
		expectVisibleText: Type.Optional(Type.Array(Type.String(), { description: "UI-visible substrings (visible text, window titles, visible control labels, exposed field values) that must appear after this step." })),
		allowError: Type.Optional(Type.Boolean({ description: "If true, continue the sequence even when this step errors or fails a guard." })),
		requireStateChange: Type.Optional(Type.Boolean({ description: "If true, fail this step closed when a post-action readback shows no observable title/URL/visible-text/target change." })),
	},
	{ additionalProperties: true, description: "One Computer Use tool call. Must include a non-empty tool string and an arguments object; see the tool description for targeting, waits, and set_value shorthand." },
);

const listAppsPayloadParam = Type.Object({
	runningOnly: Type.Optional(Type.Boolean({ description: "Return only currently running apps. Default false." })),
	filter: Type.Optional(Type.String({ description: "Optional case-insensitive substring filter across each app list line." })),
	maxTextChars: maxTextParam,
	toolTimeoutMs: timeoutParam,
});

const getAppStatePayloadParam = Type.Object({
	app: Type.String({ description: "App name, full app path, or unambiguous bundle identifier, e.g. Activity Monitor or com.apple.ActivityMonitor." }),
	approval: approvalParam,
	includeImage: Type.Optional(Type.Boolean({ description: "Attach the screenshot image returned by Computer Use when the current model/host supports image blocks. Use saveImagePath for reliable screenshot artifacts. Default false to keep turns light." })),
	saveImagePath: Type.Optional(Type.String({ description: "Optional filesystem path where the screenshot should be saved." })),
	detail: detailParam,
	targetScope: Type.Optional(StringEnum(["all", "main"] as const, { description: "Output target scope. all includes app/window/chrome targets; main prioritizes likely app/page content controls." })),
	trackFocus: Type.Optional(Type.Boolean({ description: "Capture native frontmost-app focus before/after. Default false; set true when focus evidence matters for this read. Mutating sequences always capture native focus." })),
	maxTextChars: maxTextParam,
	toolTimeoutMs: timeoutParam,
});

const restartComputerUsePayloadParam = Type.Object({
	reason: Type.Optional(Type.String({ description: "Optional reason recorded in recovery details. Default: user/requested macuse restart." })),
	toolTimeoutMs: timeoutParam,
});

const sequencePayloadParam = Type.Object({
	app: Type.Optional(Type.String({ description: "Optional default app name/bundle/path applied to steps whose arguments omit app." })),
	steps: Type.Array(sequenceStepParam, { minItems: 1, description: "Ordered Computer Use tool calls to run in one persistent app-server thread." }),
	approval: approvalParam,
	allowMutating: Type.Optional(Type.Boolean({ description: "Required when any step is not list_apps or get_app_state." })),
	allowPointerClick: Type.Optional(Type.Boolean({ description: "Required to use the pointer-based click tool. Prefer perform_secondary_action action=Press when possible." })),
	allowPointerDrag: Type.Optional(Type.Boolean({ description: "Required to use the pointer-based drag tool. Pointer tools restore the mouse position afterward." })),
	safetyNote: Type.Optional(Type.String({ description: "Required for mutating steps. State target app, intended effect, and stop boundary." })),
	includeImage: Type.Optional(Type.Boolean({ description: "Attach screenshot image blocks returned by sequence steps when the current model/host supports image blocks. Use saveImagePath for reliable screenshot artifacts. Default false." })),
	saveImagePath: Type.Optional(Type.String({ description: "Optional filesystem path where a sequence screenshot should be saved. Use screenshotStep to choose first or final state. Default first for backward compatibility." })),
	screenshotStep: Type.Optional(StringEnum(["first", "final"] as const, { description: "Which sequence step may save saveImagePath. Default first; use final to capture final visual state." })),
	detail: Type.Optional(StringEnum(["minimal", "compact", "full"] as const, { description: "Output detail. Default compact for sequences. minimal suppresses successful non-state action bodies; full returns full accessibility trees for every step." })),
	targetScope: Type.Optional(StringEnum(["all", "main"] as const, { description: "Output target scope for parsed targets. main suppresses likely app/browser chrome and window controls where possible." })),
	maxTextChars: maxTextParam,
	toolTimeoutMs: timeoutParam,
});

type RestartComputerUseParams = {
	reason?: string;
	toolTimeoutMs?: number;
};

type MacuseAction = "list_apps" | "get_app_state" | "sequence" | "restart_computer_use";
type MacuseParams = {
	action: MacuseAction;
	listApps?: ListAppsParams;
	getAppState?: GetAppStateParams;
	sequence?: SequenceParams;
	restartComputerUse?: RestartComputerUseParams;
};

const actionPayloadKey: Record<MacuseAction, "listApps" | "getAppState" | "sequence" | "restartComputerUse"> = {
	list_apps: "listApps",
	get_app_state: "getAppState",
	sequence: "sequence",
	restart_computer_use: "restartComputerUse",
};

function actionPayload<T>(input: MacuseParams): T {
	const key = actionPayloadKey[input.action];
	if (!key) throw new Error("macuse action must be one of list_apps, get_app_state, sequence, or restart_computer_use.");
	const payloadKeys = (["listApps", "getAppState", "sequence", "restartComputerUse"] as const).filter((item) => (input as Record<string, unknown>)[item] !== undefined);
	if (payloadKeys.length !== 1 || payloadKeys[0] !== key) throw new Error(`macuse action=${input.action} requires exactly one ${key} payload object and no other action payloads.`);
	const payload = input[key];
	if (!isRecord(payload)) throw new Error(`macuse action=${input.action} requires ${key} to be an object.`);
	return payload as T;
}

let client: AppServerClient | null = null;
const sessionElementCache = new Map<string, ElementInfo[]>();

function getClient(): AppServerClient {
	if (!client) client = new AppServerClient();
	return client;
}

export default function (pi: ExtensionAPI) {
	// Reset per-session state on every session_start. Pi may reuse this module
	// across same-process session switches (which fire session_start rather than
	// session_shutdown), so cached element snapshots would otherwise go stale.
	pi.on("session_start", () => {
		sessionElementCache.clear();
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
				if (ctx.hasUI) ctx.ui.notify("macuse stopped; app-server has not been started in this pi session. It starts lazily on the first macuse tool call.", "warning");
				return;
			}
			const status = client.status();
			const reaped = status.staleReapSummary.filter((item) => item.action === "reaped-orphan").length;
			const computerUse = status.computerUse ? ` computer-use=${status.computerUse.present ? `${status.computerUse.toolCount} tools` : "missing"}${status.computerUse.missingTools.length ? ` missing=${status.computerUse.missingTools.join(",")}` : ""}` : "";
			if (ctx.hasUI) ctx.ui.notify(`macuse ${status.running ? "running" : "stopped"}${status.threadId ? ` thread=${status.threadId}` : ""}${status.processPid ? ` pid=${status.processPid}` : ""}${status.watchdogPid ? ` watchdog=${status.watchdogPid}` : ""}${computerUse}${reaped ? ` reaped=${reaped}` : ""}`, status.running ? "info" : "warning");
		},
	});

	pi.registerCommand("macuse-stop", {
		description: "Stop the persistent Codex Computer Use app-server session; it restarts lazily on the next macuse tool call",
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
		name: "macuse",
		label: "macuse",
		description: "Use macuse, backed by OpenAI Codex Computer Use, to list local macOS apps, inspect app state, or run guarded native-app action sequences through one persistent Codex app-server session.",
		promptSnippet: "Inspect or safely operate local macOS apps with macuse",
		promptGuidelines: [
			"Use macuse action=list_apps to discover the exact app name, bundle ID, or path before app-state inspection when the target app is uncertain.",
			"Use macuse action=get_app_state for read-only local macOS app inspection when file, CLI, or browser DOM tools are insufficient.",
			"If Computer Use reports an application session stopped or transport-closed state, macuse auto-recovers read-only calls once; use action=restart_computer_use to explicitly restart Computer Use without user input before retrying.",
			"Use macuse action=sequence only after get_app_state has identified the target app/window or when the first sequence step is get_app_state.",
			"For mutating macuse sequences, keep the flow narrow, include a concrete safetyNote, set allowMutating=true, and stop before purchases, sends, deletes, credential changes, account/security/privacy changes, or ambiguous windows.",
			"Prefer macuse sequence steps using perform_secondary_action with action=Press, press_key, set_value, select_text, or element-targeted scroll over pointer click when possible to preserve mouse/system focus.",
			"For macuse element targeting, prefer stable elementId values from get_app_state when present, then exact elementDescription, then unique role/name, then guarded element_index.",
		],
		parameters: Type.Object({
			action: StringEnum(["list_apps", "get_app_state", "sequence", "restart_computer_use"] as const, { description: "macuse operation to run." }),
			listApps: Type.Optional(listAppsPayloadParam),
			getAppState: Type.Optional(getAppStatePayloadParam),
			sequence: Type.Optional(sequencePayloadParam),
			restartComputerUse: Type.Optional(restartComputerUsePayloadParam),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, onUpdate, _ctx) {
			const input = params as MacuseParams;
			if (input.action === "restart_computer_use") {
				const payload = actionPayload<RestartComputerUseParams>(input);
				onUpdate?.({ content: [{ type: "text", text: "Restarting macuse Computer Use runtime helpers..." }], details: {} });
				const toolTimeoutMs = asInt(payload.toolTimeoutMs, DEFAULT_TOOL_TIMEOUT_MS);
				const reason = typeof payload.reason === "string" && payload.reason.trim() ? payload.reason.trim() : "macuse action=restart_computer_use";
				sessionElementCache.clear();
				const recovery = await getClient().recoverComputerUseSession(reason, toolTimeoutMs, signal);
				return {
					content: [{ type: "text" as const, text: `Computer Use runtime restarted. Helper signal events: ${recovery.targets.length}. macuse app-server thread is ready for retry.` }],
					details: bridgeDetails({
						tool: "macuse",
						action: "restart_computer_use",
						computerUseTool: null,
						threadId: getClient().status().threadId,
						recovery,
					}, getClient().status().stderrTail),
				};
			}
			if (input.action === "list_apps") {
				const payload = actionPayload<ListAppsParams>(input);
				onUpdate?.({ content: [{ type: "text", text: "Calling macuse list_apps..." }], details: {} });
				const toolTimeoutMs = asInt(payload.toolTimeoutMs, DEFAULT_TOOL_TIMEOUT_MS);
				const maxTextChars = asInt(payload.maxTextChars, DEFAULT_MAX_TEXT_CHARS);
				const call = await getClient().callTool("list_apps", {}, { approval: "inherit", timeoutMs: toolTimeoutMs, signal });
				const result = filterToolResult(call.result, { maxTextChars });
				const diagnostics = [appendComputerUseDiagnostic(result, "list_apps", {})].filter((item): item is string => Boolean(item));
				const appMetadata = result.isError ? [] : parseAppListContent(result.content, { runningOnly: Boolean(payload.runningOnly), filter: payload.filter });
				const outputContent = listAppsDisplayContent(result, { runningOnly: Boolean(payload.runningOnly), filter: payload.filter, maxTextChars });
				return {
					content: outputContent as (TextContentBlock | ImageContentBlock)[],
					details: bridgeDetails({
						tool: "macuse",
						action: "list_apps",
						computerUseTool: "list_apps",
						threadId: getClient().status().threadId,
						isError: result.isError,
						omittedImages: result.omittedImages,
						runningOnly: Boolean(payload.runningOnly),
						filter: payload.filter ?? null,
						apps: appMetadata,
						frontmostApps: appMetadata.filter((app) => app.frontmost),
						diagnostics,
						acceptedElicitations: call.acceptedElicitations,
						elicitationCount: call.elicitationCount,
						durationMs: call.durationMs,
						computerUseRecoveryEvents: getClient().status().computerUseRecoveryEvents,
					}, getClient().status().stderrTail),
				};
			}
			if (input.action === "get_app_state") {
				const payload = actionPayload<GetAppStateParams>(input);
				const app = payload.app;
				const approval = payload.approval || "inherit";
				onUpdate?.({ content: [{ type: "text", text: `Calling macuse get_app_state for ${app} with approval=${approval}...` }], details: {} });
				const toolTimeoutMs = asInt(payload.toolTimeoutMs, DEFAULT_TOOL_TIMEOUT_MS);
				const maxTextChars = asInt(payload.maxTextChars, DEFAULT_MAX_TEXT_CHARS);
				const detail = normalizeDetail(payload.detail, "full");
				const targetScope: TargetScope = payload.targetScope === "main" ? "main" : "all";
				const trackFocus = payload.trackFocus === true;
				const frontmostBefore = trackFocus ? await captureFocusSnapshot() : null;
				const call = await getClient().callTool("get_app_state", { app }, { approval, timeoutMs: toolTimeoutMs, signal });
				const frontmostAfter = trackFocus ? await captureFocusSnapshot() : null;
				const result = filterToolResult(call.result, {
					includeImage: Boolean(payload.includeImage),
					saveImagePath: payload.saveImagePath,
					maxTextChars,
				});
				updateElementCache(sessionElementCache, app, result.content);
				const diagnostics = [appendComputerUseDiagnostic(result, "get_app_state", { app })].filter((item): item is string => Boolean(item));
				if (detail === "full") appendElementStabilityNote(result);
				appendImageWarning(result, { includeImage: Boolean(payload.includeImage), saveImagePath: payload.saveImagePath });
				const focus = focusSnapshot(frontmostBefore, frontmostAfter);
				const transformedContent = detail === "minimal" ? minimalContent(result.content, targetScope) : detail === "compact" ? compactContent(result.content, targetScope) : result.content;
				const focusLine = trackFocus ? { type: "text" as const, text: focusSummaryText(focus, app) } : null;
				const outputContent = truncateTextContent(focusLine ? [...transformedContent, focusLine] : transformedContent, maxTextChars);
				return {
					content: outputContent as (TextContentBlock | ImageContentBlock)[],
					details: bridgeDetails({
						tool: "macuse",
						action: "get_app_state",
						computerUseTool: "get_app_state",
						threadId: getClient().status().threadId,
						isError: result.isError,
						omittedImages: result.omittedImages,
						savedImagePath: result.savedImagePath,
						savedImageArtifact: result.savedImageArtifact,
						imageSupportNote: payload.includeImage ? "Image rendering is model/host dependent; saveImagePath is the reliable screenshot artifact path." : null,
						detail,
						targetScope,
						...stateSummary(result.content, targetScope),
						focus,
						diagnostics,
						elements: machineElements(result.content, targetScope),
						acceptedElicitations: call.acceptedElicitations,
						elicitationCount: call.elicitationCount,
						durationMs: call.durationMs,
						computerUseRecoveryEvents: getClient().status().computerUseRecoveryEvents,
					}, getClient().status().stderrTail),
				};
			}
			if (input.action === "sequence") {
				const payload = actionPayload<SequenceParams>(input);
				return executeSequence(payload, signal, onUpdate, getClient, sessionElementCache);
			}
			throw new Error("macuse action must be one of list_apps, get_app_state, sequence, or restart_computer_use.");
		},
	});
}
