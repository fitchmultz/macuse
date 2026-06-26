import path from "node:path";
import { truncateString, type FilteredToolResult, type JsonValue } from "./core";
import { toolResultText } from "./content";
import { appendText } from "./elements-state";

export function appendSavedImageArtifact(result: FilteredToolResult): void {
	const artifact = result.savedImageArtifact;
	if (!artifact) return;
	const size = artifact.width && artifact.height ? `${artifact.width}x${artifact.height}` : "unknown size";
	appendText(result, `Saved image artifact: ${artifact.path} (${artifact.bytes} bytes, ${size}, sha256=${artifact.sha256})`);
}

export function appendImageWarning(result: FilteredToolResult, opts: { includeImage?: boolean; saveImagePath?: string }): void {
	appendSavedImageArtifact(result);
	if (!opts.includeImage) return;
	appendText(result, `Image blocks were requested. Display depends on the current model and pi host support; use saveImagePath for reliable screenshot artifacts${opts.saveImagePath ? ` (saved first image to ${path.resolve(opts.saveImagePath)})` : ""}.`);
}

export function computerUseDiagnostic(result: FilteredToolResult, tool: string, args: Record<string, JsonValue>): string | null {
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

export function appendComputerUseDiagnostic(result: FilteredToolResult, tool: string, args: Record<string, JsonValue>): string | null {
	const diagnostic = computerUseDiagnostic(result, tool, args);
	if (diagnostic) {
		appendText(result, diagnostic);
		if (/no active state session|refused/i.test(diagnostic)) result.isError = true;
	}
	return diagnostic;
}

export function failureResult(message: string, maxTextChars: number): FilteredToolResult {
	return {
		content: [{ type: "text", text: truncateString(message, maxTextChars) }],
		isError: true,
		meta: null,
		omittedImages: 0,
		savedImagePath: null,
		savedImageArtifact: null,
	};
}

