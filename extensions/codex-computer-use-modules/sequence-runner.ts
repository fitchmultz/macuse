import {
	APP_SCOPED_TOOLS,
	ComputerUseError,
	DEFAULT_MAX_TEXT_CHARS,
	DEFAULT_TOOL_TIMEOUT_MS,
	READ_ONLY_TOOLS,
	WAIT_TOOLS,
	asInt,
	bridgeDetails,
	errorMessage,
	truncateString,
	type AppMetadata,
	type ApprovalMode,
	type ChangeSummary,
	type ElementInfo,
	type FilteredToolResult,
	type ImageContentBlock,
	type JsonValue,
	type MachineElement,
	type SequenceFailure,
	type SequenceParams,
	type SequenceStep,
	type SequencedResult,
	type StateSummary,
	type TargetScope,
	type TextContentBlock,
} from "./core";
import { AppServerClient } from "./app-server-client";
import { pickUpstreamToolArgs } from "./upstream-tool-args.mjs";
import { filterToolResult, isTextBlock, toolResultText } from "./content";
import { appendComputerUseDiagnostic, appendImageWarning, failureResult } from "./diagnostics";
import { focusSnapshot } from "./apps";
import { getMousePosition, nativeFrontmostApps, restoreMousePosition } from "./macos-focus";
import {
	appendElementStabilityNote,
	appendText,
	assertionContentText,
	compactContent,
	compareState,
	contentIncludesMultilineValue,
	describeTargetResolution,
	elementLineWithTargetHint,
	enrichActionError,
	hasMutatingSteps,
	hasStableSelector,
	hasStateSummaryContent,
	machineElements,
	normalizeAssertionText,
	normalizeDetail,
	normalizeToolArguments,
	observedStateChange,
	resolveElementDescription,
	resolveElementId,
	resolveElementRoleName,
	resolveElementTargetFallbacks,
	stateSummary,
	targetStateChanged,
	updateElementCache,
	validateIndexedTarget,
} from "./elements-state";
import {
	browserLikeAppName,
	isWaitTool,
	normalizeSequenceSteps,
	sequenceContent,
	validateStepResult,
	validateWaitArguments,
	waitConditionMet,
} from "./sequence";

export async function captureFocusSnapshot(): Promise<AppMetadata[] | null> {
	return nativeFrontmostApps();
}

async function runWaitStep(step: SequenceStep, args: Record<string, JsonValue>, opts: { getClient: () => AppServerClient; sessionElementCache: Map<string, ElementInfo[]>; approval: ApprovalMode; timeoutMs: number; maxTextChars: number; signal?: AbortSignal; cache: Map<string, ElementInfo[]>; beforeState: StateSummary | null; scope: TargetScope }): Promise<{ result: FilteredToolResult; durationMs: number; targetResolution?: string; elements: MachineElement[]; visibleText: string[]; changed: ChangeSummary | null; nextActions: string[] }> {
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
		const call = await opts.getClient().callTool("get_app_state", { app: args.app }, { approval: opts.approval, timeoutMs: callTimeoutMs, signal: opts.signal });
		const result = filterToolResult(call.result, { maxTextChars: opts.maxTextChars });
		appendComputerUseDiagnostic(result, "get_app_state", { app: args.app });
		updateElementCache(opts.cache, args.app, result.content);
		updateElementCache(opts.sessionElementCache, args.app, result.content);
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
	const message = `${step.tool} timed out after ${waitTimeoutMs}ms: ${lastMessage}. Next action: call get_app_state with detail:"minimal" for ${args.app}. Transport get_app_state calls used up to ${perPollToolTimeoutMs}ms each, with the final sub-1000ms remainder handled by the wait predicate instead of issuing a tiny transport call.`;
	if (last) appendText(last, message);
	else last = failureResult(message, opts.maxTextChars);
	last.isError = true;
	throw new ComputerUseError(message, last);
}


export async function executeSequence(
	params: unknown,
	signal: AbortSignal | undefined,
	onUpdate: ((update: { content: TextContentBlock[]; details: Record<string, unknown> }) => void) | undefined,
	getClient: () => AppServerClient,
	sessionElementCache: Map<string, ElementInfo[]>,
	resultTool = "macuse_sequence",
): Promise<{ content: (TextContentBlock | ImageContentBlock)[]; details: Record<string, unknown> }> {
		const input = params as SequenceParams;
		const toolName = resultTool;
		const pointerClickFlag = resultTool === "macuse_sequence" ? "allowPointerClick" : "allowPointer";
		const defaultApp = typeof input.app === "string" ? input.app : undefined;
		const steps = normalizeSequenceSteps(input.steps).map((step) => {
			if (!defaultApp || step.arguments.app !== undefined || !APP_SCOPED_TOOLS.has(step.tool)) return step;
			return { ...step, arguments: { app: defaultApp, ...step.arguments } };
		});
		const mutating = hasMutatingSteps(steps);
		const hasPointerClick = steps.some((step) => step.tool === "click");
		const hasPointerDrag = steps.some((step) => step.tool === "drag");
		if (hasPointerClick && !input.allowPointerClick) {
			throw new Error(`${toolName} pointer click requires ${toolName === "click" ? "allowPointer=true" : "allowPointerClick=true"}. Prefer perform_secondary_action with action=Press when possible to preserve mouse focus.`);
		}
		if (hasPointerDrag && !input.allowPointerDrag) {
			throw new Error(`${toolName} pointer drag requires ${toolName === "drag" ? "allowPointer=true" : "allowPointerDrag=true"}. Pointer drag can move the user's cursor; the extension restores mouse position afterward.`);
		}
		if (mutating) {
			if (!input.allowMutating) throw new Error(`${toolName} mutations require allowMutating=true.`);
			const safetyNote = String(input.safetyNote || "").trim();
			if (safetyNote.length < 20) throw new Error(`${toolName} mutations require a safetyNote describing target, intended effect, and stop boundary.`);
		}
		for (const step of steps) if (!WAIT_TOOLS.has(step.tool)) pickUpstreamToolArgs(step.tool, step.arguments);
		const approval = input.approval || "inherit";
		onUpdate?.({ content: [{ type: "text", text: `Running ${toolName} through persistent Codex Computer Use (${steps.length} step${steps.length === 1 ? "" : "s"}, mutating=${mutating})...` }], details: {} });
		const toolTimeoutMs = asInt(input.toolTimeoutMs, DEFAULT_TOOL_TIMEOUT_MS);
		const maxTextChars = asInt(input.maxTextChars, DEFAULT_MAX_TEXT_CHARS);
		const detail = normalizeDetail(input.detail, "compact");
		const targetScope: TargetScope = input.targetScope === "main" ? "main" : "all";
		const screenshotStep = input.screenshotStep === "final" ? "final" : "first";
		const preserveMouse = hasPointerClick || hasPointerDrag;
		const mouseBefore = preserveMouse ? getMousePosition() : null;
		let mouseRestored = false;
		const frontmostBefore = await captureFocusSnapshot();
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
				let beforeState = typeof stepArgs.app === "string" ? stateCache.get(stepArgs.app) ?? null : null;
				try {
					if (isWaitTool(step.tool)) {
						const waited = await runWaitStep(step, stepArgs, { getClient, sessionElementCache, approval, timeoutMs: toolTimeoutMs, maxTextChars, signal, cache: elementCache, beforeState, scope: targetScope });
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
						const refresh = await getClient().callTool("get_app_state", { app: stepArgs.app }, { approval, timeoutMs: toolTimeoutMs, signal });
						const refreshed = filterToolResult(refresh.result, { maxTextChars });
						updateElementCache(elementCache, stepArgs.app, refreshed.content);
						updateElementCache(sessionElementCache, stepArgs.app, refreshed.content);
						beforeState = stateSummary(refreshed.content, targetScope);
						stateCache.set(stepArgs.app, beforeState);
						implicitRefreshes += 1;
					}
					if (!beforeState && step.requireStateChange && step.tool !== "get_app_state" && step.tool !== "list_apps" && typeof stepArgs.app === "string") {
						const refresh = await getClient().callTool("get_app_state", { app: stepArgs.app }, { approval, timeoutMs: toolTimeoutMs, signal });
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
					let callArgs = stepArgs;
					if (step.tool === "set_value" && stepArgs.value === "" && typeof stepArgs.app === "string") {
						const setValueTarget = (elementCache.get(stepArgs.app) ?? []).find((element) => element.index === stepArgs.element_index);
						const targetCanUseClearControl = Boolean(setValueTarget && (setValueTarget.role === "search" || setValueTarget.tags.includes("search-field")));
						const targetIndex = Number(setValueTarget?.index);
						const clearCandidates = targetCanUseClearControl && Number.isFinite(targetIndex) ? (elementCache.get(stepArgs.app) ?? []).filter((element) => {
							const clearIndex = Number(element.index);
							return element.role === "button" &&
								element.tags.includes("clear-control") &&
								!element.tags.includes("risk-sensitive-control") &&
								Number.isFinite(clearIndex) &&
								Math.abs(clearIndex - targetIndex) <= 3;
						}) : [];
						if (clearCandidates.length === 1) {
							const clearTarget = clearCandidates[0];
							callTool = "perform_secondary_action";
							callArgs = { app: stepArgs.app, element_index: clearTarget.index, action: "Press" };
							targetResolution = `${targetResolution ?? "resolved target"}; empty set_value fallback used clear-control button element_index ${clearTarget.index} (${elementLineWithTargetHint(clearTarget)})`;
						}
					}
					const saveImageForStep = screenshotStep === "first" ? index === 0 : index === steps.length - 1;
					const call = await getClient().callTool(callTool, callArgs, { approval, timeoutMs: toolTimeoutMs, signal });
					let filtered = filterToolResult(call.result, {
						includeImage: Boolean(input.includeImage),
						saveImagePath: saveImageForStep ? input.saveImagePath : undefined,
						maxTextChars,
					});
					let postActionNoChange = false;
					let postActionReadbackDone = false;
					let actionErrorRecoveredByStateChange = false;
					const hasAssertions = step.expectText.length > 0 || step.expectAbsentText.length > 0 || step.expectVisibleText.length > 0;
					const needsStateReadback = step.requireStateChange || hasAssertions || Boolean((input.includeImage || input.saveImagePath) && saveImageForStep);
					if (filtered.isError && step.requireStateChange && typeof stepArgs.app === "string") {
						const verify = await getClient().callTool("get_app_state", { app: stepArgs.app }, { approval, timeoutMs: toolTimeoutMs, signal });
						const verified = filterToolResult(verify.result, {
							includeImage: Boolean(input.includeImage),
							saveImagePath: saveImageForStep ? input.saveImagePath : undefined,
							maxTextChars,
						});
						appendComputerUseDiagnostic(verified, "get_app_state", { app: stepArgs.app });
						const verifiedState = stateSummary(verified.content, targetScope);
						const errorReadbackChange = compareState(beforeState, verifiedState);
						const changedDespiteError = targetStateChanged(beforeState, verifiedState, stepArgs);
						if (changedDespiteError) {
							actionErrorRecoveredByStateChange = true;
							appendText(verified, `Warning: actionReportedErrorButStateChanged — ${step.tool} returned an upstream error, but requireStateChange was satisfied by post-action get_app_state readback. Treat the action as dispatched, then inspect final state before continuing. Original error output: ${truncateString(toolResultText(filtered), 800)}`);
							updateElementCache(elementCache, stepArgs.app, verified.content);
							updateElementCache(sessionElementCache, stepArgs.app, verified.content);
							filtered = verified;
							postActionReadbackDone = true;
						}
					}
					if (needsStateReadback && step.tool === "set_value" && typeof stepArgs.value === "string" && stepArgs.value.length > 0 && typeof stepArgs.app === "string") {
						const verify = await getClient().callTool("get_app_state", { app: stepArgs.app }, { approval, timeoutMs: toolTimeoutMs, signal });
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
					if (needsStateReadback && !postActionReadbackDone && !filtered.isError && !isStateTool && typeof stepArgs.app === "string") {
						const verify = await getClient().callTool("get_app_state", { app: stepArgs.app }, { approval, timeoutMs: toolTimeoutMs, signal });
						let verified = filterToolResult(verify.result, {
							includeImage: Boolean(input.includeImage),
							saveImagePath: saveImageForStep ? input.saveImagePath : undefined,
							maxTextChars,
						});
						appendComputerUseDiagnostic(verified, "get_app_state", { app: stepArgs.app });
						let verifiedState = stateSummary(verified.content, targetScope);
						let readbackChange = compareState(beforeState, verifiedState);
						postActionNoChange = !observedStateChange(readbackChange);
						if (postActionNoChange && step.requireStateChange) {
							await new Promise((resolve) => setTimeout(resolve, 600));
							const delayedVerify = await getClient().callTool("get_app_state", { app: stepArgs.app }, { approval, timeoutMs: toolTimeoutMs, signal });
							const delayed = filterToolResult(delayedVerify.result, {
								includeImage: Boolean(input.includeImage),
								saveImagePath: saveImageForStep ? input.saveImagePath : undefined,
								maxTextChars,
							});
							appendComputerUseDiagnostic(delayed, "get_app_state", { app: stepArgs.app });
							const delayedState = stateSummary(delayed.content, targetScope);
							const delayedChange = compareState(beforeState, delayedState);
							const delayedNoChange = !observedStateChange(delayedChange);
							if (!delayedNoChange) {
								appendText(delayed, "requireStateChange verified after delayed post-action readback; transient UI was not visible on the first readback.");
								verified = delayed;
								verifiedState = delayedState;
								readbackChange = delayedChange;
								postActionNoChange = false;
							}
						}
						if (postActionNoChange) {
							appendText(verified, `Warning: actionDispatchedButNoStateChange — ${step.tool} returned success, but a post-action get_app_state readback did not show observable title, URL, visible-text, or target changes. If the target should have opened/navigated, treat this as a failed UI action; retry after a fresh state read or escalate to guarded pointer click using ${pointerClickFlag} when the target/window is unambiguous.`);
						}
						if (step.requireStateChange && postActionNoChange) verified.isError = true;
						updateElementCache(elementCache, stepArgs.app, verified.content);
						updateElementCache(sessionElementCache, stepArgs.app, verified.content);
						filtered = verified;
					}
					const diagnostics = [appendComputerUseDiagnostic(filtered, step.tool, stepArgs)].filter((item): item is string => Boolean(item));
					const hasStateContent = hasStateSummaryContent(filtered.content);
					const afterState = hasStateContent ? stateSummary(filtered.content, targetScope) : null;
					if (hasStateContent) {
						updateElementCache(elementCache, stepArgs.app, filtered.content);
						updateElementCache(sessionElementCache, stepArgs.app, filtered.content);
						if (typeof stepArgs.app === "string" && afterState) stateCache.set(stepArgs.app, afterState);
					}
					if (detail === "full") appendElementStabilityNote(filtered);
					appendImageWarning(filtered, { includeImage: Boolean(input.includeImage), saveImagePath: saveImageForStep ? input.saveImagePath : undefined });
					enrichActionError(filtered, stepArgs, elementCache);
					const changed = compareState(beforeState, afterState);
					const rawIndexTarget = originalStepArgs.element_index !== undefined || originalStepArgs.element !== undefined;
					const browserTextInput = browserLikeAppName(stepArgs.app) && ["set_value", "type_text"].includes(step.tool);
					const browserInputChangedNavigationState = browserTextInput && Boolean(changed && (changed.urlChanged || changed.titleChanged));
					if (browserInputChangedNavigationState) {
						appendText(filtered, `Warning: browserInputChangedNavigationState — ${step.tool} in a browser changed URL/title state. Treat address/search fields as navigation controls even without pressing Return; verify no unintended external request or tab navigation occurred before continuing.`);
					}
					const nextActions = [
						...(rawIndexTarget && changed && (changed.urlChanged || changed.titleChanged || changed.visibleTextChanged) && !step.tool.startsWith("get_app_state") ? [`If the UI rerendered or navigated, call get_app_state for ${JSON.stringify(stepArgs.app)} with detail:"minimal" before using raw element_index targets.`] : []),
						...(!hasStateContent && filtered.isError ? [`No app-state readback was available from this failed step, so changed-state summaries are intentionally suppressed to avoid false deltas. Re-run get_app_state before deciding whether the UI actually changed.`] : []),
						...(diagnostics.length > 0 ? [`Resolve upstream Computer Use state for ${JSON.stringify(stepArgs.app)} before retrying mutating actions; use agent_browser for web/Chrome if Computer Use state keeps timing out.`] : []),
						...(postActionNoChange ? [`AX action dispatched but no observable state change was seen. If a click/open was expected, retry with a fresh state read; use a pointer click fallback only with ${pointerClickFlag} and an unambiguous target/window.`] : []),
						...(actionErrorRecoveredByStateChange ? [`Upstream reported an error, but post-action state changed. Inspect the final state carefully before issuing another mutating step.`] : []),
						...(browserTextInput && step.tool === "type_text" ? [`type_text sends keys to the browser's current focus, which may be page content rather than the address bar. Prefer set_value on a verified address/search target only when navigation is allowed, or verify focused UI before typing.`] : []),
						...(browserInputChangedNavigationState ? [`Browser text input changed URL/title state. Audit final browser state and close/restore any scratch tab before continuing.`] : []),
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
						elements: (step.tool === "get_app_state" || resultTool !== "macuse_sequence") && hasStateContent ? machineElements(filtered.content, targetScope) : [],
						visibleText: afterState?.visibleText ?? [],
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
					if (targetResolution && step.requireStateChange && !READ_ONLY_TOOLS.has(step.tool) && typeof stepArgs.app === "string") {
						try {
							const verify = await getClient().callTool("get_app_state", { app: stepArgs.app }, { approval, timeoutMs: toolTimeoutMs, signal });
							const verified = filterToolResult(verify.result, { maxTextChars });
							appendComputerUseDiagnostic(verified, "get_app_state", { app: stepArgs.app });
							const afterState = stateSummary(verified.content, targetScope);
							const changed = compareState(beforeState, afterState);
							const changedTarget = targetStateChanged(beforeState, afterState, stepArgs);
							updateElementCache(elementCache, stepArgs.app, verified.content);
							updateElementCache(sessionElementCache, stepArgs.app, verified.content);
							if (changedTarget) {
								verified.isError = false;
								appendText(verified, `Warning: actionReportedErrorButStateChanged — ${step.tool} returned an upstream transport/tool error, but requireStateChange was satisfied by post-error get_app_state readback. Original error output: ${truncateString(message, 800)}`);
								const row: SequencedResult = {
									index,
									label: step.label,
									tool: step.tool,
									arguments: stepArgs,
									durationMs: verify.durationMs,
									result: verified,
									expectText: step.expectText,
									expectAbsentText: step.expectAbsentText,
									expectVisibleText: step.expectVisibleText,
									allowError: step.allowError,
									targetResolution,
									targetWarnings: [],
									elements: machineElements(verified.content, targetScope),
									visibleText: afterState.visibleText,
									changed,
									nextActions: ["Upstream reported an error, but post-error app state changed. Inspect final state before issuing another mutating step."],
									acceptedElicitations: verify.acceptedElicitations,
									elicitationCount: verify.elicitationCount,
								};
								validateStepResult(row);
								if (detail === "compact") row.result.content = compactContent(row.result.content, targetScope);
								results.push(row);
								if (typeof stepArgs.app === "string") stateCache.set(stepArgs.app, afterState);
								continue;
							}
						} catch {
							// Fall through to the original failure; readback recovery is best-effort.
						}
					}
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
						nextActions: ["Inspect the failed-step diagnostic, then re-run get_app_state with detail:\"minimal\" before retrying any raw element_index target."],
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
		const frontmostAfter = await captureFocusSnapshot();
		const focus = focusSnapshot(frontmostBefore, frontmostAfter);
		const mousePreservation = mouseBefore ? { before: mouseBefore, after: mouseAfter, restored: mouseRestored } : undefined;
		const content = sequenceContent(results, Boolean(input.includeImage), failed, steps.length, detail, maxTextChars, focus, defaultApp, mousePreservation);
		const details = bridgeDetails({
			tool: toolName,
			computerUseTool: resultTool === "macuse_sequence" ? "sequence" : resultTool,
			threadId: getClient().status().threadId,
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
			imageSupportNote: input.includeImage || input.saveImagePath ? "Image rendering is model/host dependent; saveImagePath is the reliable screenshot artifact path." : null,
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
			computerUseRecoveryEvents: getClient().status().computerUseRecoveryEvents,
		}, getClient().status().stderrTail);
		// Resumable partial failure (>=1 step completed before a hard failure): keep
		// the rich content/details so the agent can resume from failedStepIndex.
		// Zero-progress hard failure (no step completed) or a wait-step timeout on
		// step 0: surface as a tool error so pi marks the result failed, carrying
		// the run summary as the error message and the structured details.
		const completedStepCount = failed ? failed.index : results.length;
		if (failed && completedStepCount === 0) {
			// pi discards thrown error `details`, so the error message must be
			// self-contained: include the run summary text so the model can
			// diagnose the zero-progress failure from the message alone.
			const summaryBlock = content.find(isTextBlock);
			throw new ComputerUseError(`${toolName} failed at step 1 (index 0, ${failed.tool}): ${failed.message}.\n\n${truncateString(summaryBlock?.text ?? "", 4000)}`, details);
		}
		return { content: content as (TextContentBlock | ImageContentBlock)[], details };
	
}
