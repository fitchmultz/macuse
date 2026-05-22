import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const BRIDGE_RELATIVE_PATH = "tools/codex-computer-use-appserver.mjs";
const DEFAULT_TOOL_TIMEOUT_MS = 90_000;
const DEFAULT_MAX_TEXT_CHARS = 20_000;
const MAX_STDIO_BYTES = 5 * 1024 * 1024;

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

type ContentBlock =
	| { type: "text"; text: string; [key: string]: JsonValue }
	| { type: "image"; data: string; mimeType: string; [key: string]: JsonValue }
	| { type: string; [key: string]: JsonValue };

type BridgeOutput = {
	ok: boolean;
	mode: string;
	tool?: string;
	threadId?: string;
	elicitationCount?: number;
	acceptedElicitations?: number;
	result?: {
		content?: ContentBlock[];
		isError?: boolean;
		meta?: JsonValue;
		omittedImages?: number;
		savedImagePath?: string | null;
	};
	status?: JsonValue;
	error?: string;
	exitCode?: number;
	[key: string]: JsonValue | undefined;
};

function bridgeScriptPath(): string {
	const fromCwd = path.resolve(process.cwd(), BRIDGE_RELATIVE_PATH);
	if (existsSync(fromCwd)) return fromCwd;
	// Project-local extensions are normally loaded from .pi/extensions.
	// __dirname is available in pi's extension runtime through jiti/CommonJS wrapping.
	if (typeof __dirname !== "undefined") {
		const fromExtension = path.resolve(__dirname, "../..", BRIDGE_RELATIVE_PATH);
		if (existsSync(fromExtension)) return fromExtension;
	}
	return fromCwd;
}

function asInt(value: unknown, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.max(1, Math.trunc(value));
}

function summarizeContent(content: ContentBlock[] | undefined): string {
	if (!content || content.length === 0) return "No content returned.";
	const text = content
		.filter((block): block is { type: "text"; text: string } => block.type === "text" && typeof (block as any).text === "string")
		.map((block) => block.text)
		.join("\n");
	const images = content.filter((block) => block.type === "image").length;
	if (text && images > 0) return `${text}\n\n[${images} image block${images === 1 ? "" : "s"} attached]`;
	if (text) return text;
	if (images > 0) return `[${images} image block${images === 1 ? "" : "s"} attached]`;
	return JSON.stringify(content.slice(0, 3));
}

function normalizeContent(content: ContentBlock[] | undefined): ContentBlock[] {
	if (!content || content.length === 0) return [{ type: "text", text: "No content returned." }];
	return content.map((block) => {
		if (block.type === "text" && typeof (block as any).text === "string") return block;
		if (block.type === "image" && typeof (block as any).data === "string" && typeof (block as any).mimeType === "string") return block;
		return { type: "text", text: JSON.stringify(block) };
	});
}

function runBridge(args: string[], signal: AbortSignal | undefined, timeoutMs: number): Promise<{ output: BridgeOutput; stderr: string; command: string[] }> {
	const script = bridgeScriptPath();
	const command = [process.execPath, script, ...args];
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [script, ...args], {
			cwd: process.cwd(),
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let settled = false;
		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			fn();
		};
		const fail = (message: string) => finish(() => reject(new Error(message)));
		const onAbort = () => {
			child.kill("SIGTERM");
			setTimeout(() => child.kill("SIGKILL"), 2_000).unref?.();
			fail("Codex Computer Use bridge call was aborted.");
		};
		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			setTimeout(() => child.kill("SIGKILL"), 2_000).unref?.();
			fail(`Codex Computer Use bridge timed out after ${timeoutMs}ms.`);
		}, timeoutMs);
		signal?.addEventListener("abort", onAbort, { once: true });
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
			if (stdout.length > MAX_STDIO_BYTES) fail("Codex Computer Use bridge stdout exceeded safety limit.");
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
			if (stderr.length > MAX_STDIO_BYTES) stderr = stderr.slice(-MAX_STDIO_BYTES);
		});
		child.on("error", (error) => fail(`Failed to start Codex Computer Use bridge: ${error.message}`));
		child.on("exit", (code, exitSignal) => {
			finish(() => {
				let output: BridgeOutput;
				try {
					output = JSON.parse(stdout || "{}");
				} catch (error: any) {
					reject(new Error(`Codex Computer Use bridge returned invalid JSON: ${error.message}\n${stderr.slice(-4000)}`));
					return;
				}
				if (code !== 0 || output.ok === false) {
					reject(new Error(output.error || `Codex Computer Use bridge exited with code ${code ?? exitSignal}`));
					return;
				}
				resolve({ output, stderr, command });
			});
		});
	});
}

function bridgeDetails(output: BridgeOutput, stderr: string, command: string[]): Record<string, unknown> {
	return {
		bridge: {
			mode: output.mode,
			tool: output.tool,
			threadId: output.threadId,
			elicitationCount: output.elicitationCount,
			acceptedElicitations: output.acceptedElicitations,
			isError: output.result?.isError,
			omittedImages: output.result?.omittedImages,
			savedImagePath: output.result?.savedImagePath,
			status: output.status,
		},
		command,
		stderrTail: stderr.slice(-4000),
	};
}

const timeoutParam = Type.Optional(Type.Number({ minimum: 1_000, maximum: 300_000, description: "Bridge/tool timeout in milliseconds. Default 90000." }));
const maxTextParam = Type.Optional(Type.Number({ minimum: 1_000, maximum: 200_000, description: "Maximum characters per returned text block. Default 20000." }));
const approvalParam = Type.Optional(Type.Union([
	Type.Literal("ask"),
	Type.Literal("accept-once"),
	Type.Literal("deny"),
], { description: "How to answer the Computer Use app-approval prompt. Default ask." }));

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "codex_cu_list_apps",
		label: "Codex CU List Apps",
		description: "Read-only: list apps known to OpenAI Codex Computer Use through Codex app-server.",
		promptSnippet: "List local macOS apps available to Codex Computer Use.",
		promptGuidelines: [
			"Use codex_cu_list_apps to discover the exact app name, bundle ID, or path before using codex_cu_get_app_state.",
			"codex_cu_list_apps is read-only; it does not click, type, drag, scroll, or mutate GUI state.",
		],
		parameters: Type.Object({
			maxTextChars: maxTextParam,
			toolTimeoutMs: timeoutParam,
		}),
		async execute(_toolCallId, params, signal, onUpdate) {
			onUpdate?.({ content: [{ type: "text", text: "Starting Codex app-server and calling Computer Use list_apps..." }] });
			const toolTimeoutMs = asInt((params as any).toolTimeoutMs, DEFAULT_TOOL_TIMEOUT_MS);
			const maxTextChars = asInt((params as any).maxTextChars, DEFAULT_MAX_TEXT_CHARS);
			const { output, stderr, command } = await runBridge([
				"list-apps",
				"--quiet",
				"--tool-timeout-ms", String(toolTimeoutMs),
				"--max-text-chars", String(maxTextChars),
			], signal, toolTimeoutMs + 15_000);
			const content = normalizeContent(output.result?.content);
			return {
				content,
				details: bridgeDetails(output, stderr, command),
			};
		},
	});

	pi.registerTool({
		name: "codex_cu_get_app_state",
		label: "Codex CU Get App State",
		description: "Read-only: get a target macOS app's accessibility tree and optional screenshot through OpenAI Codex Computer Use.",
		promptSnippet: "Inspect a local macOS app window with Codex Computer Use.",
		promptGuidelines: [
			"Use codex_cu_get_app_state for read-only inspection of a local macOS app when file, CLI, or browser tools are insufficient.",
			"codex_cu_get_app_state can reveal visible app contents and may launch or foreground the app; keep the target app and scope explicit.",
			"Do not use mutating Computer Use actions such as click, type, drag, scroll, key press, or set value unless the user explicitly approves a safety policy for that task.",
		],
		parameters: Type.Object({
			app: Type.String({ description: "App name, full app path, or unambiguous bundle identifier, e.g. Calculator or com.apple.calculator." }),
			approval: approvalParam,
			includeImage: Type.Optional(Type.Boolean({ description: "Attach the screenshot image returned by Computer Use. Default false to keep turns light." })),
			saveImagePath: Type.Optional(Type.String({ description: "Optional filesystem path where the screenshot should be saved." })),
			maxTextChars: maxTextParam,
			toolTimeoutMs: timeoutParam,
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const app = (params as any).app;
			let approval = ((params as any).approval || "ask") as "ask" | "accept-once" | "deny";
			if (approval === "ask") {
				const ok = await ctx.ui.confirm(
					"Allow read-only Codex Computer Use?",
					`Allow Codex Computer Use to inspect ${app}? This can reveal visible app contents and may launch or foreground the app.`,
				);
				approval = ok ? "accept-once" : "deny";
			}
			onUpdate?.({ content: [{ type: "text", text: `Calling Computer Use get_app_state for ${app} with approval=${approval}...` }] });
			const toolTimeoutMs = asInt((params as any).toolTimeoutMs, DEFAULT_TOOL_TIMEOUT_MS);
			const maxTextChars = asInt((params as any).maxTextChars, DEFAULT_MAX_TEXT_CHARS);
			const args = [
				"get-state",
				"--app", app,
				"--approval", approval,
				"--quiet",
				"--tool-timeout-ms", String(toolTimeoutMs),
				"--max-text-chars", String(maxTextChars),
			];
			if ((params as any).includeImage) args.push("--include-image");
			if ((params as any).saveImagePath) args.push("--save-image", (params as any).saveImagePath);
			const { output, stderr, command } = await runBridge(args, signal, toolTimeoutMs + 15_000);
			const content = normalizeContent(output.result?.content);
			if (output.result?.isError && content.every((block) => block.type !== "text")) {
				content.unshift({ type: "text", text: summarizeContent(output.result?.content) });
			}
			return {
				content,
				details: bridgeDetails(output, stderr, command),
			};
		},
	});
}
