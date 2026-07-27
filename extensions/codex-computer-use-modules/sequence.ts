import {
	ComputerUseError,
	DEFAULT_MAX_TEXT_CHARS,
	READ_ONLY_TOOLS,
	WAIT_TOOLS,
	isRecord,
	normalizeStringList,
	truncateString,
	type ChangeSummary,
	type ContentBlock,
	type DetailMode,
	type ElementInfo,
	type FilteredToolResult,
	type FocusSnapshot,
	type JsonValue,
	type MachineElement,
	type MousePosition,
	type SequenceFailure,
	type SequenceStep,
	type SequencedResult,
	type StateSummary,
	type TargetScope,
} from "./core";
import { summarizeContent, toolResultText } from "./content";
import { focusSummaryText } from "./apps";
import {
	assertionContentText,
	elementLineWithTargetHint,
	hasElementTarget,
	hasStableSelector,
	normalizeAssertionText,
	resolveElementDescription,
	resolveElementId,
	resolveElementRoleName,
	resolveElementTargetFallbacks,
	stateSummary,
	validateIndexedTarget,
	visibleAssertionValues,
} from "./elements-state";

export function isWaitTool(tool: string): boolean {
	return WAIT_TOOLS.has(tool);
}

export function validateWaitArguments(tool: string, args: Record<string, JsonValue>): void {
	if (typeof args.app !== "string") throw new Error(`${tool} requires an app argument or sequence-level app default.`);
	if (tool === "waitForText" && typeof args.text !== "string") throw new Error("waitForText requires arguments.text.");
	if (tool === "waitForURL" && typeof args.url !== "string") throw new Error("waitForURL requires arguments.url.");
	if (tool === "waitForTitle" && typeof args.title !== "string") throw new Error("waitForTitle requires arguments.title.");
	if (["waitForElement", "waitUntilElementEnabled", "waitUntilElementDisabled"].includes(tool) && !hasElementTarget(args) && !Array.isArray(args.targets)) throw new Error(`${tool} requires an element target such as elementId, elementDescription, role/name, or targets.`);
}

export function waitConditionMet(tool: string, args: Record<string, JsonValue>, result: FilteredToolResult, cache: Map<string, ElementInfo[]>): string | null {
	const app = typeof args.app === "string" ? args.app : "";
	const summary = stateSummary(result.content);
	const visible = visibleAssertionValues(result.content);
	const raw = normalizeAssertionText(assertionContentText(result.content));
	const normalizedTitle = typeof args.title === "string" ? normalizeAssertionText(args.title) : "";
	const normalizedUrl = typeof args.url === "string" ? normalizeAssertionText(args.url) : "";
	if (normalizedTitle && !(summary.title && normalizeAssertionText(summary.title).includes(normalizedTitle))) return null;
	const urlScopeHaystack = normalizeAssertionText([summary.url, raw].filter(Boolean).join("\n"));
	if (normalizedUrl && !urlScopeHaystack.includes(normalizedUrl)) return null;
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


export function normalizeSequenceSteps(value: unknown): SequenceStep[] {
	if (!Array.isArray(value) || value.length === 0) throw new Error("macuse_sequence requires at least one step.");
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

export function validateStepResult(step: SequencedResult): void {
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

export function assertionSummary(step: SequencedResult): string | null {
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

export function browserLikeAppName(value: JsonValue | undefined): boolean {
	return typeof value === "string" && /\b(?:brave|chrome|chromium|safari|firefox|browser)\b/i.test(value);
}

export function sequenceTargetMethod(step: SequencedResult): string {
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

export function sequenceRunSummary(steps: SequencedResult[], failed: SequenceFailure | null, focus?: FocusSnapshot, mousePreservation?: { before: MousePosition; after: MousePosition | null; restored: boolean }): string {
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
		...(mousePreservation ? [`- pointer mouse: restored=${mousePreservation.restored}`] : []),
		...(failed ? [`- failure: step ${failed.stepNumber} ${failed.tool}: ${failed.message}`] : []),
		...(readbackDrift.length ? [`- anomaly hints: ${readbackDrift.join("; ")}`] : []),
	];
	return lines.join("\n");
}

export function sequenceContent(steps: SequencedResult[], includeImages = false, failed: SequenceFailure | null = null, totalSteps = steps.length, detail: DetailMode = "compact", maxTextChars = DEFAULT_MAX_TEXT_CHARS, focus?: FocusSnapshot, targetApp?: string, mousePreservation?: { before: MousePosition; after: MousePosition | null; restored: boolean }): ContentBlock[] {
	if (steps.length === 0) return [{ type: "text", text: "Computer Use sequence returned no steps." }];
	const completedStepCount = failed ? failed.index : steps.length;
	const summary = failed
		? `Sequence failed at step ${failed.stepNumber} of ${totalSteps} (index ${failed.index}, ${failed.tool}). Completed ${completedStepCount} step${completedStepCount === 1 ? "" : "s"}. To resume, start a new sequence from step index ${failed.index} against current app state.`
		: `Sequence completed ${steps.length} of ${totalSteps} step${totalSteps === 1 ? "" : "s"}.`;
	const focusLine = focus ? `\n${focusSummaryText(focus, targetApp)}` : "";
	const mouseLine = mousePreservation ? `\nPointer mouse preservation: before=(${mousePreservation.before.x},${mousePreservation.before.y}); after=(${mousePreservation.after?.x ?? "unknown"},${mousePreservation.after?.y ?? "unknown"}); restored=${mousePreservation.restored}` : "";
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

