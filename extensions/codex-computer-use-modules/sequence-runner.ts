import { setTimeout as delay } from "node:timers/promises";
import {
	APP_SCOPED_TOOLS, ComputerUseError, DEFAULT_MAX_TEXT_CHARS, DEFAULT_TOOL_TIMEOUT_MS,
	READ_ONLY_TOOLS, WAIT_TOOLS, asInt, bridgeDetails, errorMessage, isRecord, mcpServerForTool, truncateString, validateAuxiliarySafety,
	type ApprovalMode, type ElementInfo, type FilteredToolResult, type ImageContentBlock,
	type JsonValue, type SequenceFailure, type SequenceParams, type SequencedResult, type StateSummary, type TextContentBlock,
} from "./core";
import { AppServerClient } from "./app-server-client";
import { pickUpstreamToolArgs, validateToolArguments } from "./upstream-tool-args.mjs";
import { filterToolResult, toolResultText } from "./content";
import { appendComputerUseDiagnostic, appendImageWarning, failureResult } from "./diagnostics";
import { focusSnapshot } from "./apps";
import { beginFocusObservation, endFocusObservation, macosNative } from "./macos-focus";
import {
	appendText, compactContent, compareState, describeTargetResolution, enrichActionError, hasMutatingSteps,
	hasStableSelector, hasStateSummaryContent, machineElements, normalizeDetail, normalizeToolArguments,
	observedStateChange, resolveElementDescription, resolveElementId, resolveElementRoleName,
	resolveElementTargetFallbacks, stateSummary, targetStateChanged, updateElementCache, validateIndexedTarget,
} from "./elements-state";
import { browserLikeAppName, isWaitTool, normalizeSequenceSteps, sequenceContent, validateStepResult, validateWaitArguments, waitConditionMet } from "./sequence";

const appKey = (app: string) => app.replace(/\/+$/, "");
const appPid = (state: StateSummary | undefined) => Number(state?.app?.match(/\bpid\s+(\d+)/)?.[1]) || undefined;
const appIdentity = (state: StateSummary) => appPid(state) ?? state.app?.match(/bundleID\s+([^,\s)]+)/)?.[1] ?? state.app?.replace(/\s+\(.*/, "").replace(/\/+$/, "");

export function rememberAppState(cache: Map<string, StateSummary>, app: string, state: StateSummary): void {
	const bundle = state.app?.match(/bundleID\s+([^,\s)]+)/)?.[1];
	const path = state.app?.split(/\s+\(/)[0]?.trim();
	// Read snapshots name the app by path; action snapshots use its bundle ID.
	for (const [key, previous] of cache) if (appIdentity(previous) === appIdentity(state)) cache.set(key, state);
	for (const key of [app, bundle, path]) if (key) cache.set(appKey(key), state);
}

function documentChanged(previous: StateSummary, current: StateSummary): boolean {
	return appIdentity(previous) !== appIdentity(current) || (previous.url || current.url ? previous.url !== current.url : previous.title !== current.title);
}

export function assertSameDocument(previous: StateSummary | undefined, current: StateSummary, args: Record<string, JsonValue>): void {
	if (typeof args.expectedTitle === "string" && current.title !== args.expectedTitle) throw new Error(`Window guard failed: expected title ${JSON.stringify(args.expectedTitle)}, found ${JSON.stringify(current.title)}. No mutation performed.`);
	if (typeof args.expectedUrl === "string" && current.url !== args.expectedUrl) throw new Error(`Document guard failed: expected URL ${JSON.stringify(args.expectedUrl)}, found ${JSON.stringify(current.url)}. No mutation performed.`);
	if (!previous) return;
	if (documentChanged(previous, current)) throw new Error(`Target document changed since the last observed state: ${JSON.stringify(previous.url ?? previous.title)} → ${JSON.stringify(current.url ?? current.title)}. No mutation performed. Call get_app_state and inspect the intended document before retrying.`);
}

function resolvedTarget(before: StateSummary, after: StateSummary, args: Record<string, JsonValue>) {
	const original = before.targets.find((target) => target.index === args.element_index);
	if (!original) return undefined;
	const matches = after.targets.filter((target) => original.id ? target.id === original.id
		: original.description ? target.role === original.role && target.description === original.description
		: target.role === original.role && target.name === original.name);
	return matches.length === 1 ? matches[0] : undefined;
}

function assertEditedValue(before: StateSummary, after: StateSummary, args: Record<string, JsonValue>): void {
	if (documentChanged(before, after)) throw new Error("set_value was dispatched, but readback belongs to a different document. Its edit outcome is unknown; inspect the original document without replaying the edit.");
	const target = resolvedTarget(before, after, args);
	if (!target || target.value === undefined || target.value.normalize("NFC") !== String(args.value).normalize("NFC")) {
		throw new Error(`set_value was dispatched but the resolved field did not expose the requested value. Do not replay automatically. Expected ${JSON.stringify(truncateString(String(args.value), 200))}; observed ${JSON.stringify(target?.value === undefined ? null : truncateString(target.value, 200))}.`);
	}
}

function actionChanged(before: StateSummary, after: StateSummary, args: Record<string, JsonValue>, tool: string): boolean {
	if (typeof args.element_index !== "string") return observedStateChange(compareState(before, after));
	if (targetStateChanged(before, after, args) || before.title !== after.title || before.url !== after.url) return true;
	if (tool === "set_value") return false;
	if (tool === "scroll") return after.targets.some((target) => target.role === "scroll bar" && before.targets.some((old) => old.index === target.index && old.value !== target.value));
	// Opening a menu/popover can leave the pressed button unchanged; a clock elsewhere is not evidence.
	const control = (role: string) => /button|field|entry area|menu|checkbox|switch|dialog/.test(role);
	const identity = (target: StateSummary["targets"][number]) => `${target.role}:${target.id ?? target.description ?? target.name}`;
	const oldControls = new Set(before.targets.filter((target) => control(target.role)).map(identity));
	return after.targets.some((target) => control(target.role) && !oldControls.has(identity(target)));
}

function isWindowClose(tool: string, args: Record<string, JsonValue>, before: StateSummary | undefined): boolean {
	if (tool === "press_key") return args.key === "super+w" || args.key === "super+shift+w";
	const target = before?.targets.find((element) => element.index === args.element_index);
	return (tool === "click" || (tool === "perform_secondary_action" && args.action === "Press")) && Boolean(target && (target.role === "close button" || /^close(?: tab| window)?$/i.test(target.description ?? target.name)));
}

export async function executeSequence(
	params: unknown,
	signal: AbortSignal | undefined,
	onUpdate: ((update: { content: TextContentBlock[]; details: Record<string, unknown> }) => void) | undefined,
	getClient: () => AppServerClient,
	sessionElementCache: Map<string, ElementInfo[]>,
	resultTool = "macuse_sequence",
	sessionStateCache = new Map<string, StateSummary>(),
): Promise<{ content: (TextContentBlock | ImageContentBlock)[]; details: Record<string, unknown> }> {
	const started = Date.now();
	const input = params as SequenceParams;
	const defaultApp = typeof input.app === "string" ? input.app : undefined;
	const steps = normalizeSequenceSteps(input.steps).map((step) => !defaultApp || step.arguments.app !== undefined || !APP_SCOPED_TOOLS.has(step.tool)
		? step : { ...step, arguments: { app: defaultApp, ...step.arguments } });
	const mutating = hasMutatingSteps(steps);
	const pointerClick = steps.some((step) => step.tool === "click");
	const pointerDrag = steps.some((step) => step.tool === "drag");
	if (pointerClick && !input.allowPointerClick) throw new Error(`${resultTool} pointer click requires ${resultTool === "click" ? "allowPointer=true" : "allowPointerClick=true"}. Prefer perform_secondary_action when possible.`);
	if (pointerDrag && !input.allowPointerDrag) throw new Error(`${resultTool} pointer drag requires ${resultTool === "drag" ? "allowPointer=true" : "allowPointerDrag=true"}.`);
	if (mutating && input.allowMutating !== true) throw new Error(`${resultTool} mutations require allowMutating=true.`);
	if (mutating && String(input.safetyNote || "").trim().length < 20) throw new Error(`${resultTool} mutations require a safetyNote describing target, intended effect, and stop boundary.`);
	// Validate the entire flow before dispatching its first action.
	for (const step of steps) {
		if (Object.hasOwn(step.arguments, "approval")) throw new Error(`${resultTool} step arguments cannot set approval; use the top-level approval option.`);
		validateAuxiliarySafety(step.tool, { ...step.arguments, allowRecording: input.allowRecording === true, allowPrivacyChange: input.allowPrivacyChange === true, safetyNote: input.safetyNote ?? "" });
		if (WAIT_TOOLS.has(step.tool)) validateWaitArguments(step.tool, step.arguments);
		else {
			validateToolArguments(step.tool, step.arguments);
			pickUpstreamToolArgs(step.tool, step.arguments);
		}
	}
	signal?.throwIfAborted();
	const approval: ApprovalMode = input.approval || "inherit";
	const toolTimeoutMs = asInt(input.toolTimeoutMs, DEFAULT_TOOL_TIMEOUT_MS);
	const maxTextChars = asInt(input.maxTextChars, DEFAULT_MAX_TEXT_CHARS);
	const detail = normalizeDetail(input.detail, "compact");
	const targetScope = input.targetScope === "main" ? "main" : "all";
	const screenshotStep = input.screenshotStep === "final" ? "final" : "first";
	const knownPids = [...new Set(steps.map((step) => typeof step.arguments.app === "string" ? appPid(sessionStateCache.get(appKey(step.arguments.app))) : undefined).filter((pid): pid is number => pid !== undefined))];
	const observation = await beginFocusObservation(knownPids).catch(() => null);
	const results: SequencedResult[] = [];
	let failed: SequenceFailure | null = null;
	let implicitRefreshes = 0;

	const remember = (app: string, result: FilteredToolResult) => {
		if (result.isError) return;
		updateElementCache(sessionElementCache, app, result.content);
		rememberAppState(sessionStateCache, app, stateSummary(result.content));
	};
	const call = async (tool: string, args: Record<string, JsonValue>, timeoutMs = toolTimeoutMs, image = false) => {
		signal?.throwIfAborted();
		const response = await getClient().callTool(tool, args, { approval, timeoutMs, signal });
		const result = filterToolResult(response.result, { includeImage: Boolean(input.includeImage) && image, saveImagePath: image ? input.saveImagePath : undefined });
		return { response, result };
	};

	for (const [index, step] of steps.entries()) {
		const stepStarted = Date.now();
		let args = normalizeToolArguments(step.arguments);
		const app = typeof args.app === "string" ? args.app : undefined;
		const guiMutation = !isWaitTool(step.tool) && mcpServerForTool(step.tool) === "computer-use" && !READ_ONLY_TOOLS.has(step.tool);
		let before = app ? sessionStateCache.get(appKey(app)) : undefined;
		let dispatchPending = false;
		let verifyAssertions = false;
		let row: SequencedResult = {
			index, tool: step.tool, label: step.label, arguments: args, durationMs: 0, dispatched: false, outcome: "reported",
			result: failureResult("Step did not run.", maxTextChars), expectText: step.expectText, expectAbsentText: step.expectAbsentText,
			expectVisibleText: step.expectVisibleText, allowError: step.allowError, targetWarnings: [], elements: [], visibleText: [], changed: null,
			nextActions: [], acceptedElicitations: 0, elicitationCount: 0,
		};
		onUpdate?.({ content: [{ type: "text", text: `${resultTool}: step ${index + 1}/${steps.length} ${step.tool}${app ? ` (${app})` : ""}...` }], details: {} });
		try {
			signal?.throwIfAborted();
			if (isWaitTool(step.tool)) {
				const deadline = Date.now() + asInt(args.timeoutMs, toolTimeoutMs);
				const interval = Math.max(100, Math.min(asInt(args.intervalMs, 750), 10_000));
				let matched: string | null = null;
				let lastMessage = "condition did not match";
				while (Date.now() < deadline) {
					const remaining = deadline - Date.now();
					if (remaining < 1_000) break;
					const read = await call("get_app_state", { app: app! }, Math.min(asInt(args.toolTimeoutMs, toolTimeoutMs), remaining));
					row.result = read.result;
					if (row.result.isError) throw new ComputerUseError(toolResultText(row.result));
					remember(app!, row.result);
					try { matched = waitConditionMet(step.tool, args, row.result, sessionElementCache); }
					catch (error) {
						lastMessage = errorMessage(error);
						if (/Guard failed|Stale element_index/.test(lastMessage)) throw error;
					}
					if (matched) break;
					await delay(Math.max(0, Math.min(interval, deadline - Date.now())), undefined, { signal });
				}
				if (!matched) throw new Error(`${step.tool} timed out after ${asInt(args.timeoutMs, toolTimeoutMs)}ms: ${lastMessage}.`);
				row.targetResolution = matched;
				appendText(row.result, matched);
				row.outcome = "verified";
			} else {
				if (guiMutation && app) {
					const refresh = await call("get_app_state", { app });
					if (refresh.result.isError) throw new ComputerUseError(`Fresh app-state preflight failed before ${step.tool}: ${toolResultText(refresh.result)}`);
					const freshState = stateSummary(refresh.result.content);
					if (!freshState.app) throw new Error("Fresh app-state preflight did not identify an app. No mutation performed.");
					before ??= [...sessionStateCache.values()].find((state) => appIdentity(state) === appIdentity(freshState));
					assertSameDocument(before, freshState, args);
					remember(app, refresh.result);
					before = freshState;
					implicitRefreshes++;
				}
				args = resolveElementTargetFallbacks(args, sessionElementCache);
				args = resolveElementId(args, sessionElementCache);
				args = resolveElementDescription(args, sessionElementCache);
				args = resolveElementRoleName(args, sessionElementCache);
				row.arguments = args;
				row.targetWarnings = validateIndexedTarget(args, sessionElementCache, hasStableSelector(step.arguments));
				row.targetResolution = describeTargetResolution(step.arguments, args, sessionElementCache);
				const image = screenshotStep === "final" ? index === steps.length - 1 : index === 0;
				let nativeTextVerified = false;
				let lastWindowClosed = false;
				if (step.tool === "type_text" && before && appPid(before)) {
					const native = await macosNative.inspectApp(appPid(before)!).catch(() => null);
					if (native?.focusedWindow && native.focusedElement?.selectedTextSettable) {
						const window = native.focusedWindow;
						const matches = window.document && before.url ? window.document === before.url : window.title === before.title;
						if (!matches) throw new Error("Native text target no longer matches the inspected document. No mutation performed; inspect the intended window again.");
						signal?.throwIfAborted();
						row.dispatched = true;
						row.outcome = "unknown";
						let insertion;
						try {
							insertion = await macosNative.replaceSelectedText({ pid: native.pid, expected: { windowToken: window.token, windowTitle: window.title, document: window.document, elementToken: native.focusedElement.token }, text: String(args.text) });
						} catch (error) {
							await macosNative.stop();
							throw error;
						}
						row.dispatched = insertion.mutationAttempted;
						if (insertion.status === "guard_failed" || insertion.status === "unverified") throw new Error(insertion.reason);
						if (insertion.status === "applied") {
							nativeTextVerified = true;
							row.outcome = "verified";
							row.result = { ...failureResult("Text inserted and verified through native Accessibility; no clipboard or global keyboard input used.", maxTextChars), isError: false };
						}
					}
				}
				if (!nativeTextVerified) {
					if (step.tool === "type_text" && /[^\x00-\x7f]/.test(String(args.text))) throw new Error("This focused control does not support verified native text insertion. No text was dispatched: upstream keyboard typing corrupts Unicode here. Use set_value on a verified settable field instead.");
					let dispatchTool = step.tool;
					let dispatchArgs = args;
					if (step.tool === "set_value" && args.value === "") {
						const target = before?.targets.find((element) => element.index === args.element_index);
						const clears = target?.tags.includes("search-field") ? before!.targets.filter((element) => element.role === "button" && element.tags.includes("clear-control") && !element.tags.includes("risk-sensitive-control") && Math.abs(Number(element.index) - Number(target.index)) <= 3) : [];
						if (clears.length === 1) {
							dispatchTool = "perform_secondary_action";
							dispatchArgs = { app: app!, element_index: clears[0].index, action: "Press" };
							row.targetResolution += `; empty set_value used clear-control ${clears[0].index}`;
						}
					}
					signal?.throwIfAborted();
					row.dispatched = !READ_ONLY_TOOLS.has(step.tool);
					row.outcome = row.dispatched ? "unknown" : "reported";
					dispatchPending = true;
					const dispatched = await call(dispatchTool, dispatchArgs, toolTimeoutMs, image);
					dispatchPending = false;
					row.result = dispatched.result;
					row.acceptedElicitations += dispatched.response.acceptedElicitations;
					row.elicitationCount += dispatched.response.elicitationCount;
				}
				const closeAction = isWindowClose(step.tool, args, before);
				if (closeAction && (!row.result.isError || /noWindowsAvailable/.test(toolResultText(row.result))) && appPid(before)) {
					const native = await macosNative.inspectApp(appPid(before)!).catch(() => null);
					if (native?.windowsCount === 0) {
						lastWindowClosed = true;
						row.result = { ...row.result, isError: false, content: [{ type: "text", text: `App=${before!.app}\nNo windows remain. Native Accessibility verified that the last window closed; do not replay the close.` }] };
						row.outcome = "verified";
					}
				}
				if (closeAction && step.requireStateChange && !lastWindowClosed) throw new Error("Close was dispatched, but native inspection did not verify the last window closed. No reopening readback was attempted; inspect current windows without replaying the close.");
				const assertions = step.expectText.length + step.expectAbsentText.length + step.expectVisibleText.length > 0;
				const needsReadback = guiMutation && app && !closeAction && (step.tool === "set_value" || step.tool === "type_text" || step.requireStateChange || assertions || (image && (input.includeImage || input.saveImagePath)));
				if (needsReadback && !lastWindowClosed) {
					const actionError = row.result.isError ? toolResultText(row.result) : null;
					let readback = await call("get_app_state", { app }, toolTimeoutMs, image);
					if (readback.result.isError) throw new ComputerUseError(`Action dispatched, but post-action state is unavailable: ${toolResultText(readback.result)}`);
					let after = stateSummary(readback.result.content);
					if (step.requireStateChange && before && !actionChanged(before, after, args, step.tool)) {
						await delay(600, undefined, { signal });
						readback = await call("get_app_state", { app }, toolTimeoutMs, image);
						if (readback.result.isError) throw new ComputerUseError(`Action dispatched, but delayed readback failed: ${toolResultText(readback.result)}`);
						after = stateSummary(readback.result.content);
					}
					row.result = readback.result;
					remember(app, row.result);
					if (step.tool === "set_value" && before) assertEditedValue(before, after, args);
					if (step.requireStateChange && before && !actionChanged(before, after, args, step.tool)) throw new Error("actionDispatchedButNoStateChange: no relevant target or document change was observed. Do not replay automatically; inspect the intended outcome.");
					if (actionError && step.tool !== "set_value" && !(step.requireStateChange && before && actionChanged(before, after, args, step.tool)) && !assertions) throw new Error(`Action returned an error and its intended outcome was not verified: ${actionError}`);
					row.outcome = nativeTextVerified || step.tool === "set_value" || step.requireStateChange ? "verified" : assertions ? "unknown" : "reported";
					verifyAssertions = assertions;
					if (actionError) appendText(row.result, `The intended outcome was verified despite an upstream error: ${truncateString(actionError, 300)}`);
				} else if (!row.result.isError && row.outcome !== "verified") row.outcome = "reported";
			}
			appendComputerUseDiagnostic(row.result, step.tool, args);
			if (hasStateSummaryContent(row.result.content)) {
				const after = stateSummary(row.result.content);
				if (app) remember(app, row.result);
				row.visibleText = after.visibleText;
				row.elements = machineElements(row.result.content, targetScope);
				row.changed = compareState(before ?? null, after);
			}
			if (browserLikeAppName(args.app) && ["set_value", "type_text"].includes(step.tool) && (row.changed?.urlChanged || row.changed?.titleChanged)) {
				row.nextActions.push("Browser text input changed URL/title state. Treat navigation fields as submission controls and inspect the destination before continuing.");
			}
			validateStepResult(row);
			if (verifyAssertions) row.outcome = "verified";
		} catch (error) {
			if (dispatchPending && error instanceof ComputerUseError && isRecord(error.details) && error.details.dispatched === false) row.dispatched = false;
			const message = errorMessage(error);
			row.result.isError = true;
			appendText(row.result, message);
			row.nextActions.push(row.dispatched ? "The action was dispatched and may already have taken effect. Inspect current state; do not replay automatically." : "No action was dispatched. Inspect the target and retry only the failed step.");
			if (!step.allowError || signal?.aborted) failed = { index, stepNumber: index + 1, tool: step.tool, label: step.label, message, dispatched: row.dispatched };
		}
		row.durationMs = Date.now() - stepStarted;
		enrichActionError(row.result, args, sessionElementCache);
		appendImageWarning(row.result, { includeImage: Boolean(input.includeImage), saveImagePath: (screenshotStep === "final" ? index === steps.length - 1 : index === 0) ? input.saveImagePath : undefined });
		if (detail === "compact" && !row.result.isError) row.result.content = compactContent(row.result.content, targetScope);
		results.push(row);
		if (failed) break;
	}
	const observed = observation ? await endFocusObservation(observation.id).catch(() => null) : null;
	const focus = { ...focusSnapshot(observed?.before ?? null, observed?.after ?? null), ...observed, observationAvailable: Boolean(observed?.coverage.applicationActivation), observedChanges: observed?.transitions.length };
	if (observed?.transitions.some((event) => event.kind === "activation")) focus.changed = true;
	const content = sequenceContent(results, Boolean(input.includeImage), failed, steps.length, detail, maxTextChars, focus, defaultApp);
	const details = bridgeDetails({
		tool: resultTool, computerUseTool: resultTool === "macuse_sequence" ? "sequence" : resultTool,
		threadId: getClient().status().threadId, detail, targetScope, isError: Boolean(failed), failed,
		failedStepIndex: failed?.index ?? null, failedStepNumber: failed?.stepNumber ?? null, failedStepLabel: failed?.label ?? null,
		completedStepCount: failed ? failed.index : results.length, resumeFromStepIndex: failed && !failed.dispatched ? failed.index : null,
		defaultApp: defaultApp ?? null, implicitRefreshes, durationMs: Date.now() - started, screenshotStep, focus,
		pointerToolsUsed: pointerClick || pointerDrag,
		steps: results.map(({ result, ...step }) => ({ ...step, isError: result.isError, omittedImages: result.omittedImages, savedImagePath: result.savedImagePath, savedImageArtifact: result.savedImageArtifact })),
		computerUseRecoveryEvents: getClient().status().computerUseRecoveryEvents,
	}, getClient().status().stderrTail);
	return { content: content as (TextContentBlock | ImageContentBlock)[], details };
}
