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

export function computerUseDiagnostic(result: FilteredToolResult, tool: string, args: Record<string, JsonValue>, outcome?: { dispatched?: boolean }): string | null {
	if (!result.isError) return null;
	const text = toolResultText(result);
	const app = typeof args.app === "string" ? args.app : "the target app";
	if (result.isError && /Computer Use application session is stopped/i.test(text)) {
		return `Diagnostic: upstream Computer Use says the application session for ${app} is stopped and returned no app state. macuse treats this as a normal tool error, not an instruction to end the agent turn. Restart or re-approve Computer Use, then retry.`;
	}
	if (result.isError && /NSOSStatusErrorDomain Code=-(?:609|1712)|Computer Use server error -1743|connectionInvalid|errAETimeout|ACCESS DENIED|kTCCServiceAppleEvents/i.test(text)) {
		return `Diagnostic: macOS Automation/TCC blocked the external macuse host while Computer Use tried to talk to its helper for ${app}. ChatGPT.app can still work because it has its own Automation entitlement and TCC grants; macuse runs under the current host app. Run node tools/macuse-repair.mjs --repair-tcc --responsible auto for the exact responsible launcher, then apply it from a host with Full Disk Access or relaunch a signed host that has com.apple.security.automation.apple-events.`;
	}
	if (/keyNotFound\("?([^"\n)]+)"?\)/i.test(text)) {
		return `Diagnostic: upstream press_key rejected the key name for ${app}. macuse sends xdotool-style key names; Command-, is normalized to key="super+comma" from either key=",", modifiers=["COMMAND"] or key="Command+,".`;
	}
	if (/noWindowsAvailable/i.test(text)) {
		return `Diagnostic: ${tool} returned noWindowsAvailable for ${app}. After a close action this can mean the last window closed successfully. The error alone does not prove whether the action ran; inspect native window state before retrying. Do not activate the app or replay a close just to obtain a screenshot.`;
	}
	if (/while waiting for the previous request; no new action was sent/i.test(text)) {
		return `Diagnostic: ${tool} did not leave the queue; no action was dispatched for this request. The previous pending RPC still owns the queue until it settles or you explicitly stop the owned session with /macuse-stop. Then get_app_state again before deciding the next action. Stopping the owned session does not prove cancellation of the previous action; no global helper restart is required.`;
	}
	if (/timeoutReached|timed out after|timed out while/i.test(text)) {
		if (outcome?.dispatched === false) return `Diagnostic: ${tool} timed out for ${app} before this action was dispatched. If an earlier RPC is pending, it still owns the queue until settlement or explicit owned-session /macuse-stop; then get_app_state again. Do not replay an earlier dispatched action automatically.`;
		return `Diagnostic: upstream ${tool} timed out for ${app}. A dispatched action may already have taken effect; timeout does not mean cancellation. Wait for the pending operation to settle and inspect current state before another mutation. A larger toolTimeoutMs may help; detail:"minimal" only limits presentation and cannot shorten upstream work.`;
	}
	if (/Computer Use is not active .*first must call get_app_state|first must call get_app_state/i.test(text)) {
		return `Diagnostic: upstream Computer Use refused ${tool} because ${app} has no active state session. No mutation was performed by macuse. A successful get_app_state call for the same app is required first; if that state call times out, this is an upstream Computer Use blocker rather than a target-selection problem.`;
	}
	return null;
}

export function appendComputerUseDiagnostic(result: FilteredToolResult, tool: string, args: Record<string, JsonValue>, outcome?: { dispatched?: boolean }): string | null {
	const diagnostic = computerUseDiagnostic(result, tool, args, outcome);
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

