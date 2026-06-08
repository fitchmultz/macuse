import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const VERSION = "0.2.0";
const DEFAULT_CODEX_BIN = "/Applications/Codex.app/Contents/Resources/codex";
const DEFAULT_TOOL_TIMEOUT_MS = 90_000;
const DEFAULT_MAX_TEXT_CHARS = 20_000;
const READ_ONLY_TOOLS = new Set(["list_apps", "get_app_state"]);
const FEATURE_FLAGS = ["computer_use", "plugins", "tool_call_mcp_elicitation"];

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

type ContentBlock =
	| { type: "text"; text: string; [key: string]: JsonValue }
	| { type: "image"; data: string; mimeType: string; [key: string]: JsonValue }
	| { type: string; [key: string]: JsonValue };

type ComputerUseToolResult = {
	content?: ContentBlock[];
	isError?: boolean;
	is_error?: boolean;
	_meta?: JsonValue;
	meta?: JsonValue;
};

type FilteredToolResult = {
	content: ContentBlock[];
	isError: boolean;
	meta: JsonValue;
	omittedImages: number;
	savedImagePath: string | null;
};

type SequenceStep = {
	tool: string;
	arguments: Record<string, JsonValue>;
	label?: string;
	expectText: string[];
	expectAbsentText: string[];
	allowError: boolean;
};

type DetailMode = "compact" | "full";

type ElementInfo = {
	index: string;
	id?: string;
	line: string;
	secondaryActions: string[];
};

type SequencedResult = {
	index: number;
	label?: string;
	tool: string;
	arguments: Record<string, JsonValue>;
	durationMs: number;
	result: FilteredToolResult;
	expectText: string[];
	expectAbsentText: string[];
	allowError: boolean;
	acceptedElicitations: number;
	elicitationCount: number;
};

type MousePosition = { x: number; y: number };

class ComputerUseError extends Error {
	details?: unknown;

	constructor(message: string, details?: unknown) {
		super(message);
		this.name = "ComputerUseError";
		this.details = details;
	}
}

function asInt(value: unknown, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.max(1, Math.trunc(value));
}

function truncateString(value: string, max: number): string {
	if (value.length <= max) return value;
	return `${value.slice(0, max)}…[${value.length} chars]`;
}

function normalizeStringList(value: unknown, name: string): string[] {
	if (value === undefined || value === null) return [];
	if (typeof value === "string") return [value];
	if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value;
	throw new Error(`${name} must be a string or array of strings.`);
}

function normalizeContent(content: ContentBlock[] | undefined): ContentBlock[] {
	if (!content || content.length === 0) return [{ type: "text", text: "No content returned." }];
	return content.map((block) => {
		if (block.type === "text" && typeof (block as any).text === "string") return block;
		if (block.type === "image" && typeof (block as any).data === "string" && typeof (block as any).mimeType === "string") return block;
		return { type: "text", text: JSON.stringify(block) };
	});
}

function summarizeContent(content: ContentBlock[] | undefined): string {
	const normalized = normalizeContent(content);
	const text = normalized
		.filter((block): block is { type: "text"; text: string } => block.type === "text" && typeof (block as any).text === "string")
		.map((block) => block.text)
		.join("\n");
	const images = normalized.filter((block) => block.type === "image").length;
	if (text && images > 0) return `${text}\n\n[${images} image block${images === 1 ? "" : "s"} attached]`;
	if (text) return text;
	if (images > 0) return `[${images} image block${images === 1 ? "" : "s"} attached]`;
	return JSON.stringify(normalized.slice(0, 3));
}

function toolResultText(result: FilteredToolResult): string {
	return (result.content || [])
		.filter((block) => block.type === "text" && typeof (block as any).text === "string")
		.map((block: any) => block.text)
		.join("\n");
}

function filterToolResult(result: ComputerUseToolResult, opts: { includeImage?: boolean; saveImagePath?: string; maxTextChars: number }): FilteredToolResult {
	const content: ContentBlock[] = [];
	let omittedImages = 0;
	let savedImagePath: string | null = null;
	for (const block of result?.content || []) {
		if (block?.type === "text" && typeof (block as any).text === "string") {
			content.push({ ...block, text: truncateString((block as any).text, opts.maxTextChars) });
		} else if (block?.type === "image") {
			if (opts.saveImagePath && !savedImagePath && typeof (block as any).data === "string") {
				const outPath = path.resolve(opts.saveImagePath);
				mkdirSync(path.dirname(outPath), { recursive: true });
				writeFileSync(outPath, Buffer.from((block as any).data, "base64"));
				savedImagePath = outPath;
			}
			if (opts.includeImage) content.push(block);
			else omittedImages += 1;
		} else {
			content.push(block);
		}
	}
	return {
		content: normalizeContent(content),
		isError: Boolean(result?.isError ?? result?.is_error ?? false),
		meta: (result?._meta ?? result?.meta ?? null) as JsonValue,
		omittedImages,
		savedImagePath,
	};
}

function getMousePosition(): MousePosition | null {
	const script = "import CoreGraphics; if let e = CGEvent(source: nil) { let p = e.location; print(Int(p.x), Int(p.y)) }";
	const result = spawnSync("swift", ["-e", script], { encoding: "utf8", timeout: 10_000 });
	if (result.status !== 0) return null;
	const [x, y] = result.stdout.trim().split(/\s+/).map((part) => Number(part));
	if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
	return { x, y };
}

function restoreMousePosition(position: MousePosition | null): boolean {
	if (!position) return false;
	const script = `import CoreGraphics; CGWarpMouseCursorPosition(CGPoint(x: ${Math.trunc(position.x)}, y: ${Math.trunc(position.y)})); CGAssociateMouseAndMouseCursorPosition(1)`;
	const result = spawnSync("swift", ["-e", script], { encoding: "utf8", timeout: 10_000 });
	return result.status === 0;
}

function hasMutatingSteps(steps: Array<{ tool: string }>): boolean {
	return steps.some((step) => !READ_ONLY_TOOLS.has(step.tool));
}

function contentText(content: ContentBlock[] | undefined): string {
	return normalizeContent(content)
		.filter((block): block is { type: "text"; text: string } => block.type === "text" && typeof (block as any).text === "string")
		.map((block) => block.text)
		.join("\n");
}

function parseElementInfo(text: string): ElementInfo[] {
	const elements: ElementInfo[] = [];
	for (const rawLine of text.split("\n")) {
		const match = rawLine.match(/^\s*(\d+)\s+(.+)$/);
		if (!match) continue;
		const line = match[0].trim();
		const id = line.match(/(?:^|,\s*)ID:\s*([^,\n]+)/)?.[1]?.trim();
		const secondaryActions = line.match(/Secondary Actions:\s*([^\n]+)/)?.[1]
			?.split(",")
			.map((item) => item.trim())
			.filter(Boolean) ?? [];
		elements.push({ index: match[1], id, line, secondaryActions });
	}
	return elements;
}

function compactText(text: string): string {
	const lines = text.split("\n");
	const header = lines.filter((line) => /^(Computer Use state|<app_state>|App=|Window:)/.test(line.trim())).slice(0, 4);
	const interactive = parseElementInfo(text).filter((element) =>
		/\b(button|text|field|menu|row|checkbox|radio|slider|scroll area|combo box|tab|link)\b/i.test(element.line) ||
		element.secondaryActions.length > 0 ||
		Boolean(element.id),
	);
	const body = interactive.map((element) => element.line);
	return [...header, ...body].join("\n") || truncateString(text, DEFAULT_MAX_TEXT_CHARS);
}

function compactContent(content: ContentBlock[]): ContentBlock[] {
	return content.map((block) => {
		if (block.type === "text" && typeof (block as any).text === "string") return { ...block, text: compactText((block as any).text) };
		return block;
	});
}

function normalizeDetail(value: unknown, fallback: DetailMode): DetailMode {
	if (value === undefined || value === null) return fallback;
	if (value === "compact" || value === "full") return value;
	throw new Error('detail must be "compact" or "full".');
}

function normalizeToolArguments(args: Record<string, JsonValue>): Record<string, JsonValue> {
	const normalized: Record<string, JsonValue> = { ...args };
	if (normalized.element_index === undefined && normalized.element !== undefined) {
		normalized.element_index = normalized.element;
		delete normalized.element;
	}
	if (normalized.element_index !== undefined && normalized.element_index !== null) normalized.element_index = String(normalized.element_index);
	return normalized;
}

function elementSummary(elements: ElementInfo[], limit = 40): string {
	if (elements.length === 0) return "No cached elements for this app.";
	const shown = elements.slice(0, limit).map((element) => element.line).join("\n");
	const remaining = elements.length > limit ? `\n…${elements.length - limit} more elements omitted` : "";
	return `${shown}${remaining}`;
}

function resolveElementId(args: Record<string, JsonValue>, cache: Map<string, ElementInfo[]>): Record<string, JsonValue> {
	const normalized = normalizeToolArguments(args);
	const elementId = normalized.elementId ?? normalized.element_id;
	if (typeof elementId !== "string" || normalized.element_index !== undefined) return normalized;
	if (typeof normalized.app !== "string") throw new Error("elementId targeting requires an app argument.");
	const elements = cache.get(normalized.app) ?? [];
	const match = elements.find((element) => element.id === elementId);
	if (!match) {
		const knownIds = elements.map((element) => element.id).filter(Boolean).join(", ");
		throw new Error(`No elementId ${elementId} found for ${normalized.app}.${knownIds ? ` Known IDs: ${knownIds}.` : ""}\nAvailable elements:\n${elementSummary(elements)}`);
	}
	normalized.element_index = match.index;
	delete normalized.elementId;
	delete normalized.element_id;
	return normalized;
}

function updateElementCache(cache: Map<string, ElementInfo[]>, app: JsonValue | undefined, content: ContentBlock[]): void {
	if (typeof app !== "string") return;
	const elements = parseElementInfo(contentText(content));
	if (elements.length > 0) cache.set(app, elements);
}

function appendText(result: FilteredToolResult, text: string): void {
	result.content = [...result.content, { type: "text", text }];
}

function enrichActionError(result: FilteredToolResult, args: Record<string, JsonValue>, cache: Map<string, ElementInfo[]>): void {
	if (!result.isError || typeof args.app !== "string" || typeof args.element_index !== "string") return;
	const element = (cache.get(args.app) ?? []).find((item) => item.index === args.element_index);
	if (!element) return;
	const actions = element.secondaryActions.length > 0 ? element.secondaryActions.join(", ") : "none listed";
	appendText(result, `Target element ${element.index}: ${element.line}\nValid secondary actions: ${actions}`);
}

function filterAppListContent(content: ContentBlock[], opts: { runningOnly?: boolean; filter?: string; maxTextChars: number }): ContentBlock[] {
	return content.map((block) => {
		if (block.type !== "text" || typeof (block as any).text !== "string") return block;
		let lines = (block as any).text.split("\n").filter(Boolean);
		if (opts.runningOnly) lines = lines.filter((line: string) => /\[(?:[^\]]*,\s*)?(?:frontmost,\s*)?running(?:[,\]])/.test(line) || line.includes("[frontmost, running"));
		if (opts.filter) {
			const needle = opts.filter.toLowerCase();
			lines = lines.filter((line: string) => line.toLowerCase().includes(needle));
		}
		const text = lines.join("\n") || "No apps matched the requested filter.";
		return { ...block, text: truncateString(text, opts.maxTextChars) };
	});
}

function failureResult(message: string, maxTextChars: number): FilteredToolResult {
	return {
		content: [{ type: "text", text: truncateString(message, maxTextChars) }],
		isError: true,
		meta: null,
		omittedImages: 0,
		savedImagePath: null,
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function bridgeDetails(base: Record<string, unknown>, stderrTail: string): Record<string, unknown> {
	return {
		computerUse: {
			version: VERSION,
			persistentAppServer: true,
			...base,
		},
		stderrTail,
	};
}

class AppServerClient {
	private proc: ChildProcessWithoutNullStreams | null = null;
	private nextId = 1;
	private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout; method: string; onAbort?: () => void }>();
	private buffer = "";
	private queue: Promise<unknown> = Promise.resolve();
	private initializing: Promise<void> | null = null;
	private initialized: unknown = null;
	private thread: any = null;
	private currentApproval: "inherit" | "accept-all" | "accept-once" | "deny" = "inherit";
	private acceptedThisCall = 0;
	private acceptedElicitations = 0;
	private elicitationCount = 0;
	private notifications: Array<{ method: string; params?: unknown }> = [];
	private stderr = "";

	constructor(private readonly codexBin = process.env.CODEX_BIN || DEFAULT_CODEX_BIN, private readonly cwd = process.cwd()) {}

	status() {
		return {
			version: VERSION,
			codexBin: this.codexBin,
			cwd: this.cwd,
			running: Boolean(this.proc && this.proc.exitCode === null && this.proc.signalCode === null),
			threadId: this.thread?.id ?? null,
			acceptedElicitations: this.acceptedElicitations,
			elicitationCount: this.elicitationCount,
			notifications: this.notifications.slice(-10),
			stderrTail: this.stderr.slice(-4000),
		};
	}

	async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.queue.then(fn, fn);
		this.queue = run.catch(() => undefined);
		return run;
	}

	async ensureReady(timeoutMs: number, signal?: AbortSignal): Promise<void> {
		if (this.proc && this.proc.exitCode === null && this.proc.signalCode === null && this.thread?.id) return;
		if (this.initializing) return this.initializing;
		this.initializing = this.start(timeoutMs, signal).catch(async (error) => {
			await this.stop();
			throw error;
		}).finally(() => {
			this.initializing = null;
		});
		return this.initializing;
	}

	private async start(timeoutMs: number, signal?: AbortSignal): Promise<void> {
		if (!existsSync(this.codexBin)) throw new ComputerUseError(`Codex app-server binary not found: ${this.codexBin}`);
		const args = ["app-server"];
		for (const flag of FEATURE_FLAGS) args.push("--enable", flag);
		this.proc = spawn(this.codexBin, args, {
			cwd: this.cwd,
			env: process.env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.proc.stdout.setEncoding("utf8");
		this.proc.stderr.setEncoding("utf8");
		this.proc.stdout.on("data", (chunk) => this.onStdout(String(chunk)));
		this.proc.stderr.on("data", (chunk) => {
			this.stderr += String(chunk);
			if (this.stderr.length > 20_000) this.stderr = this.stderr.slice(-20_000);
		});
		this.proc.on("exit", (code, exitSignal) => this.onExit(code, exitSignal));
		this.proc.on("error", (error) => this.onExit(null, null, error));

		this.initialized = await this.request("initialize", {
			clientInfo: { name: "pi-macuse-computer-use", version: VERSION },
			capabilities: { experimental_api: true, mcp_elicitations: true },
		}, Math.min(timeoutMs, 15_000), signal);
		this.notify("notifications/initialized");
		const threadStart = await this.request("thread/start", {
			cwd: this.cwd,
			ephemeral: true,
			approvalPolicy: "on-request",
			sandbox: "workspace-write",
			config: {
				features: {
					computer_use: true,
					plugins: true,
					tool_call_mcp_elicitation: true,
				},
			},
		}, Math.min(Math.max(timeoutMs, 45_000), 120_000), signal);
		this.thread = threadStart?.thread;
		if (!this.thread?.id) throw new ComputerUseError("thread/start response did not include thread.id", threadStart);
	}

	private onStdout(chunk: string): void {
		this.buffer += chunk;
		for (;;) {
			const idx = this.buffer.indexOf("\n");
			if (idx === -1) break;
			const line = this.buffer.slice(0, idx).trim();
			this.buffer = this.buffer.slice(idx + 1);
			if (line) this.onLine(line);
		}
	}

	private onLine(line: string): void {
		let message: any;
		try {
			message = JSON.parse(line);
		} catch {
			this.stderr += `\n[invalid app-server JSON] ${line.slice(0, 500)}`;
			return;
		}
		if (Object.prototype.hasOwnProperty.call(message, "id") && (Object.prototype.hasOwnProperty.call(message, "result") || Object.prototype.hasOwnProperty.call(message, "error")) && this.pending.has(message.id)) {
			const pending = this.pending.get(message.id)!;
			clearTimeout(pending.timer);
			if (pending.onAbort) pending.onAbort();
			this.pending.delete(message.id);
			if (message.error) pending.reject(new ComputerUseError(`${pending.method} failed: ${message.error.message || "JSON-RPC error"}`, message.error));
			else pending.resolve(message.result);
			return;
		}
		if (Object.prototype.hasOwnProperty.call(message, "id") && message.method) {
			this.onServerRequest(message);
			return;
		}
		if (message.method) {
			this.notifications.push({ method: message.method, params: message.params });
			if (this.notifications.length > 50) this.notifications.shift();
		}
	}

	private onServerRequest(request: any): void {
		if (request.method === "mcpServer/elicitation/request") {
			this.elicitationCount += 1;
			const decision = this.decideElicitation();
			this.write({ jsonrpc: "2.0", id: request.id, result: decision });
			return;
		}
		this.write({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: `pi macuse bridge does not implement ${request.method}` } });
	}

	private decideElicitation() {
		if (this.currentApproval === "inherit" || this.currentApproval === "accept-all") {
			this.acceptedElicitations += 1;
			return { action: "accept", content: {}, _meta: null };
		}
		if (this.currentApproval === "accept-once" && this.acceptedThisCall < 1) {
			this.acceptedThisCall += 1;
			this.acceptedElicitations += 1;
			return { action: "accept", content: {}, _meta: null };
		}
		return { action: "decline", content: null, _meta: null };
	}

	private onExit(code: number | null, signal: NodeJS.Signals | null, error?: Error): void {
		const message = error?.message || `Codex app-server exited code=${code} signal=${signal}`;
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			if (pending.onAbort) pending.onAbort();
			pending.reject(new ComputerUseError(message));
		}
		this.pending.clear();
		this.proc = null;
		this.thread = null;
		this.initialized = null;
	}

	private write(message: unknown): void {
		if (!this.proc || !this.proc.stdin.writable) throw new ComputerUseError("Codex app-server stdin is not writable");
		this.proc.stdin.write(`${JSON.stringify(message)}\n`);
	}

	private notify(method: string, params: Record<string, unknown> = {}): void {
		this.write({ jsonrpc: "2.0", method, params });
	}

	private request(method: string, params: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<any> {
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			let onAbort: (() => void) | undefined;
			const cleanup = () => {
				clearTimeout(timer);
				if (onAbort) signal?.removeEventListener("abort", onAbort);
			};
			const timer = setTimeout(() => {
				this.pending.delete(id);
				if (onAbort) signal?.removeEventListener("abort", onAbort);
				reject(new ComputerUseError(`${method} timed out after ${timeoutMs}ms`, { method, id }));
			}, timeoutMs);
			onAbort = () => {
				this.pending.delete(id);
				cleanup();
				reject(new ComputerUseError(`${method} was aborted`, { method, id }));
			};
			if (signal?.aborted) {
				cleanup();
				reject(new ComputerUseError(`${method} was aborted`, { method, id }));
				return;
			}
			signal?.addEventListener("abort", onAbort, { once: true });
			this.pending.set(id, { resolve, reject, timer, method, onAbort: cleanup });
			try {
				this.write({ jsonrpc: "2.0", id, method, params });
			} catch (error: any) {
				this.pending.delete(id);
				cleanup();
				reject(error);
			}
		});
	}

	async callTool(tool: string, args: Record<string, JsonValue>, opts: { approval: "inherit" | "accept-all" | "accept-once" | "deny"; timeoutMs: number; signal?: AbortSignal }): Promise<{ result: ComputerUseToolResult; durationMs: number; acceptedElicitations: number; elicitationCount: number }> {
		return this.runExclusive(async () => {
			await this.ensureReady(opts.timeoutMs, opts.signal);
			const acceptedBefore = this.acceptedElicitations;
			const elicitationBefore = this.elicitationCount;
			this.currentApproval = opts.approval;
			this.acceptedThisCall = 0;
			const started = Date.now();
			try {
				const result = await this.request("mcpServer/tool/call", {
					threadId: this.thread.id,
					server: "computer-use",
					tool,
					arguments: args,
				}, opts.timeoutMs, opts.signal);
				return {
					result,
					durationMs: Date.now() - started,
					acceptedElicitations: this.acceptedElicitations - acceptedBefore,
					elicitationCount: this.elicitationCount - elicitationBefore,
				};
			} finally {
				this.currentApproval = "inherit";
				this.acceptedThisCall = 0;
			}
		});
	}

	async stop(): Promise<void> {
		const proc = this.proc;
		if (!proc) return;
		this.proc = null;
		this.thread = null;
		if (proc.exitCode !== null || proc.signalCode !== null) return;
		proc.kill("SIGTERM");
		await new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
				resolve();
			}, 3_000);
			proc.once("exit", () => {
				clearTimeout(timer);
				resolve();
			});
		});
	}

	async restart(): Promise<void> {
		await this.stop();
	}
}

function normalizeSequenceSteps(value: unknown): SequenceStep[] {
	if (!Array.isArray(value) || value.length === 0) throw new Error("codex_cu_sequence requires at least one step.");
	return value.map((step: any, index) => {
		if (!step || typeof step !== "object" || Array.isArray(step)) throw new Error(`sequence step ${index} must be an object.`);
		if (typeof step.tool !== "string" || step.tool.length === 0) throw new Error(`sequence step ${index} requires a non-empty tool string.`);
		const args = step.arguments || {};
		if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error(`sequence step ${index} arguments must be an object.`);
		return {
			tool: step.tool,
			arguments: args,
			label: typeof step.label === "string" ? step.label : undefined,
			expectText: normalizeStringList(step.expectText, `sequence step ${index} expectText`),
			expectAbsentText: normalizeStringList(step.expectAbsentText, `sequence step ${index} expectAbsentText`),
			allowError: step.allowError === true,
		};
	});
}

function validateStepResult(step: SequencedResult): void {
	if (step.result.isError && !step.allowError) {
		throw new ComputerUseError(`sequence step ${step.index} ${step.tool} returned tool error`, step.result);
	}
	const text = toolResultText(step.result);
	for (const expected of step.expectText || []) {
		if (!text.includes(expected)) throw new ComputerUseError(`sequence step ${step.index} ${step.tool} missing expected text: ${expected}`, { expected, textPreview: truncateString(text, 1000) });
	}
	for (const unexpected of step.expectAbsentText || []) {
		if (text.includes(unexpected)) throw new ComputerUseError(`sequence step ${step.index} ${step.tool} contained forbidden text: ${unexpected}`, { unexpected, textPreview: truncateString(text, 1000) });
	}
}

function sequenceContent(steps: SequencedResult[], includeImages = false): ContentBlock[] {
	if (steps.length === 0) return [{ type: "text", text: "Computer Use sequence returned no steps." }];
	const text = steps.map((step) => {
		const body = summarizeContent(step.result.content);
		return `Step ${step.index}: ${step.tool} (${step.durationMs}ms, isError=${step.result.isError}, elicitations=${step.elicitationCount}, accepted=${step.acceptedElicitations})\n${body}`;
	}).join("\n\n---\n\n");
	const content: ContentBlock[] = [{ type: "text", text }];
	if (includeImages) {
		for (const step of steps) {
			for (const block of step.result.content || []) {
				if (block.type === "image") content.push(block);
			}
		}
	}
	return content;
}

const timeoutParam = Type.Optional(Type.Number({ minimum: 1_000, maximum: 300_000, description: "Tool timeout in milliseconds. Default 90000." }));
const maxTextParam = Type.Optional(Type.Number({ minimum: 1_000, maximum: 200_000, description: "Maximum characters per returned text block. Default 20000." }));
const approvalParam = Type.Optional(Type.Union([
	Type.Literal("inherit"),
	Type.Literal("accept-all"),
	Type.Literal("accept-once"),
	Type.Literal("deny"),
], { description: "How to answer Computer Use app-approval prompts. Default inherit, which auto-accepts app approvals to match Codex's Any App setting." }));
const detailParam = Type.Optional(Type.Union([
	Type.Literal("compact"),
	Type.Literal("full"),
], { description: "Output detail. compact trims accessibility trees to interactive element lines; full returns the raw Computer Use text." }));

const client = new AppServerClient();
const sessionElementCache = new Map<string, ElementInfo[]>();

export default function (pi: ExtensionAPI) {
	pi.on("session_shutdown", async () => {
		sessionElementCache.clear();
		await client.stop();
	});

	pi.registerCommand("macuse-status", {
		description: "Show Codex Computer Use persistent app-server status",
		handler: async (_args, ctx) => {
			const status = client.status();
			ctx.ui.notify(`macuse ${status.running ? "running" : "stopped"}${status.threadId ? ` thread=${status.threadId}` : ""}`, status.running ? "info" : "warning");
		},
	});

	pi.registerCommand("macuse-restart", {
		description: "Restart the persistent Codex Computer Use app-server session",
		handler: async (_args, ctx) => {
			sessionElementCache.clear();
			await client.restart();
			ctx.ui.notify("macuse Computer Use session stopped; it will restart on the next tool call.", "info");
		},
	});

	pi.registerTool({
		name: "codex_cu_list_apps",
		label: "Codex CU List Apps",
		description: "Read-only: list apps known to OpenAI Codex Computer Use through a persistent Codex app-server session. Use runningOnly:true to return only currently running apps, and filter to substring-match app names, paths, or bundle IDs.",
		promptSnippet: "List local macOS apps available to Codex Computer Use.",
		promptGuidelines: [
			"Use codex_cu_list_apps to discover the exact app name, bundle ID, or path before using codex_cu_get_app_state.",
			"codex_cu_list_apps is read-only; it does not click, type, drag, scroll, or mutate GUI state.",
		],
		parameters: Type.Object({
			runningOnly: Type.Optional(Type.Boolean({ description: "Return only currently running apps. Default false." })),
			filter: Type.Optional(Type.String({ description: "Optional case-insensitive substring filter across each app list line." })),
			maxTextChars: maxTextParam,
			toolTimeoutMs: timeoutParam,
		}),
		async execute(_toolCallId, params, signal, onUpdate) {
			onUpdate?.({ content: [{ type: "text", text: "Calling persistent Codex Computer Use list_apps..." }] });
			const toolTimeoutMs = asInt((params as any).toolTimeoutMs, DEFAULT_TOOL_TIMEOUT_MS);
			const maxTextChars = asInt((params as any).maxTextChars, DEFAULT_MAX_TEXT_CHARS);
			const call = await client.callTool("list_apps", {}, { approval: "inherit", timeoutMs: toolTimeoutMs, signal });
			const result = filterToolResult(call.result, { maxTextChars });
			const outputContent = filterAppListContent(result.content, { runningOnly: Boolean((params as any).runningOnly), filter: (params as any).filter, maxTextChars });
			return {
				content: outputContent,
				details: bridgeDetails({
					tool: "list_apps",
					threadId: client.status().threadId,
					isError: result.isError,
					omittedImages: result.omittedImages,
					runningOnly: Boolean((params as any).runningOnly),
					filter: (params as any).filter ?? null,
					acceptedElicitations: call.acceptedElicitations,
					elicitationCount: call.elicitationCount,
					durationMs: call.durationMs,
				}, client.status().stderrTail),
			};
		},
	});

	pi.registerTool({
		name: "codex_cu_get_app_state",
		label: "Codex CU Get App State",
		description: "Read-only: get a target macOS app's accessibility tree and optional screenshot through persistent OpenAI Codex Computer Use. Pass detail:'compact' for interactive elements only, or detail:'full' for the raw tree.",
		promptSnippet: "Inspect a local macOS app window with Codex Computer Use.",
		promptGuidelines: [
			"Use codex_cu_get_app_state for read-only inspection of a local macOS app when file, CLI, or browser tools are insufficient.",
			"App approval defaults to inherit, matching Codex's Any App setting by auto-accepting app approvals.",
			"Use codex_cu_sequence for mutating Computer Use actions, with before/after get_app_state evidence, allowMutating=true, and a concrete safetyNote.",
		],
		parameters: Type.Object({
			app: Type.String({ description: "App name, full app path, or unambiguous bundle identifier, e.g. Calculator or com.apple.calculator." }),
			approval: approvalParam,
			includeImage: Type.Optional(Type.Boolean({ description: "Attach the screenshot image returned by Computer Use. Default false to keep turns light." })),
			saveImagePath: Type.Optional(Type.String({ description: "Optional filesystem path where the screenshot should be saved." })),
			detail: detailParam,
			maxTextChars: maxTextParam,
			toolTimeoutMs: timeoutParam,
		}),
		async execute(_toolCallId, params, signal, onUpdate) {
			const app = (params as any).app;
			const approval = ((params as any).approval || "inherit") as "inherit" | "accept-all" | "accept-once" | "deny";
			onUpdate?.({ content: [{ type: "text", text: `Calling persistent Computer Use get_app_state for ${app} with approval=${approval}...` }] });
			const toolTimeoutMs = asInt((params as any).toolTimeoutMs, DEFAULT_TOOL_TIMEOUT_MS);
			const maxTextChars = asInt((params as any).maxTextChars, DEFAULT_MAX_TEXT_CHARS);
			const detail = normalizeDetail((params as any).detail, "full");
			const call = await client.callTool("get_app_state", { app }, { approval, timeoutMs: toolTimeoutMs, signal });
			const result = filterToolResult(call.result, {
				includeImage: Boolean((params as any).includeImage),
				saveImagePath: (params as any).saveImagePath,
				maxTextChars,
			});
			updateElementCache(sessionElementCache, app, result.content);
			const outputContent = detail === "compact" ? compactContent(result.content) : result.content;
			return {
				content: outputContent,
				details: bridgeDetails({
					tool: "get_app_state",
					app,
					threadId: client.status().threadId,
					isError: result.isError,
					omittedImages: result.omittedImages,
					savedImagePath: result.savedImagePath,
					detail,
					acceptedElicitations: call.acceptedElicitations,
					elicitationCount: call.elicitationCount,
					durationMs: call.durationMs,
				}, client.status().stderrTail),
			};
		},
	});

	pi.registerTool({
		name: "codex_cu_sequence",
		label: "Codex CU Sequence",
		description: "Run Codex Computer Use calls in one persistent app-server thread. Valid tools: list_apps, get_app_state, perform_secondary_action, press_key, type_text, set_value, select_text, scroll, click, drag. Element targets use element_index as a string; numbers are coerced, element is accepted as an alias, and elementId (for IDs like One or AllClear from get_app_state) resolves against the latest tree in the sequence. Example step: {tool:'perform_secondary_action', arguments:{app:'Calculator', elementId:'One', action:'Press'}}.",
		promptSnippet: "Run a sequence of local macOS Computer Use actions.",
		promptGuidelines: [
			"Use codex_cu_sequence only after codex_cu_get_app_state has identified the target app/window or when the first sequence step is get_app_state.",
			"For mutating codex_cu_sequence steps, keep the flow narrow, include an explicit safetyNote, set allowMutating=true, and stop before purchases, sends, deletes, credential changes, account/security/privacy changes, or ambiguous windows.",
			"App approval defaults to inherit, matching Codex's Any App setting by auto-accepting app approvals.",
			"Prefer perform_secondary_action with action=Press, press_key, set_value, select_text, or element-targeted scroll over pointer click when possible to preserve mouse/system focus.",
			"press_key uses xdotool-style key names. Examples: '5', 'Return', 'Escape', 'Tab', 'space', 'plus', 'minus', 'equal', 'ctrl+c'. For text entry, prefer type_text unless a real key event is required.",
			"For element targeting, prefer stable elementId values from get_app_state when present. Otherwise pass element_index as a string; numeric element_index and element aliases are coerced for convenience.",
		],
		parameters: Type.Object({
			steps: Type.Array(Type.Object({
				tool: Type.String({ description: "Computer Use tool name: list_apps, get_app_state, perform_secondary_action, press_key, type_text, set_value, select_text, scroll, click, or drag. press_key keys use xdotool-style names such as '5', 'Return', 'Escape', 'plus', 'minus', 'equal', or 'ctrl+c'." }),
				arguments: Type.Optional(Type.Any({ description: "Tool arguments object. Element-targeted tools accept element_index as string or number, element as an alias, or elementId/element_id resolved from the latest get_app_state tree for that app." })),
				label: Type.Optional(Type.String({ description: "Optional human-readable step label." })),
				expectText: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())], { description: "Text that must appear in this step's text result." })),
				expectAbsentText: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())], { description: "Text that must not appear in this step's text result." })),
				allowError: Type.Optional(Type.Boolean({ description: "Allow this step to return isError without aborting the sequence." })),
			}), { minItems: 1, description: "Ordered Computer Use tool calls to run in one persistent app-server thread." }),
			approval: approvalParam,
			allowMutating: Type.Optional(Type.Boolean({ description: "Required when any step is not list_apps or get_app_state." })),
			allowPointerClick: Type.Optional(Type.Boolean({ description: "Required to use the pointer-based click tool. Prefer perform_secondary_action action=Press when possible." })),
			allowPointerDrag: Type.Optional(Type.Boolean({ description: "Required to use the pointer-based drag tool. The extension restores the mouse position afterward." })),
			safetyNote: Type.Optional(Type.String({ description: "Required for mutating steps. State target app, intended effect, and stop boundary." })),
			includeImage: Type.Optional(Type.Boolean({ description: "Attach screenshot image blocks returned by sequence steps. Default false." })),
			saveImagePath: Type.Optional(Type.String({ description: "Optional filesystem path where the first returned screenshot should be saved." })),
			detail: Type.Optional(Type.Union([Type.Literal("compact"), Type.Literal("full")], { description: "Output detail. Default compact for sequences. full returns full accessibility trees for every step." })),
			maxTextChars: maxTextParam,
			toolTimeoutMs: timeoutParam,
		}),
		async execute(_toolCallId, params, signal, onUpdate) {
			const steps = normalizeSequenceSteps((params as any).steps);
			const mutating = hasMutatingSteps(steps);
			const hasPointerClick = steps.some((step) => step.tool === "click");
			const hasPointerDrag = steps.some((step) => step.tool === "drag");
			if (hasPointerClick && !(params as any).allowPointerClick) {
				throw new Error("codex_cu_sequence pointer click steps require allowPointerClick=true. Prefer perform_secondary_action with action=Press when possible to preserve mouse focus.");
			}
			if (hasPointerDrag && !(params as any).allowPointerDrag) {
				throw new Error("codex_cu_sequence pointer drag steps require allowPointerDrag=true. Pointer drag can move the user's cursor; the extension restores mouse position afterward.");
			}
			if (mutating) {
				if (!(params as any).allowMutating) throw new Error("codex_cu_sequence mutating steps require allowMutating=true.");
				const safetyNote = String((params as any).safetyNote || "").trim();
				if (safetyNote.length < 20) throw new Error("codex_cu_sequence mutating steps require a safetyNote describing target, intended effect, and stop boundary.");
			}
			const approval = ((params as any).approval || "inherit") as "inherit" | "accept-all" | "accept-once" | "deny";
			onUpdate?.({ content: [{ type: "text", text: `Running persistent Codex Computer Use sequence (${steps.length} steps, mutating=${mutating})...` }] });
			const toolTimeoutMs = asInt((params as any).toolTimeoutMs, DEFAULT_TOOL_TIMEOUT_MS);
			const maxTextChars = asInt((params as any).maxTextChars, DEFAULT_MAX_TEXT_CHARS);
			const detail = normalizeDetail((params as any).detail, "compact");
			const mouseBefore = hasPointerClick || hasPointerDrag ? getMousePosition() : null;
			const results: SequencedResult[] = [];
			const elementCache = new Map(sessionElementCache);
			let failed: { index: number; tool: string; message: string } | null = null;
			let implicitRefreshes = 0;
			try {
				for (const [index, step] of steps.entries()) {
					let stepArgs = normalizeToolArguments(step.arguments);
					try {
						const elementId = stepArgs.elementId ?? stepArgs.element_id;
						if (typeof elementId === "string" && stepArgs.element_index === undefined && typeof stepArgs.app === "string") {
							try {
								stepArgs = resolveElementId(stepArgs, elementCache);
							} catch {
								const refresh = await client.callTool("get_app_state", { app: stepArgs.app }, { approval, timeoutMs: toolTimeoutMs, signal });
								const refreshed = filterToolResult(refresh.result, { maxTextChars });
								updateElementCache(elementCache, stepArgs.app, refreshed.content);
								updateElementCache(sessionElementCache, stepArgs.app, refreshed.content);
								implicitRefreshes += 1;
								stepArgs = resolveElementId(stepArgs, elementCache);
							}
						} else {
							stepArgs = resolveElementId(stepArgs, elementCache);
						}
						const call = await client.callTool(step.tool, stepArgs, { approval, timeoutMs: toolTimeoutMs, signal });
						const filtered = filterToolResult(call.result, {
							includeImage: Boolean((params as any).includeImage),
							saveImagePath: index === 0 ? (params as any).saveImagePath : undefined,
							maxTextChars,
						});
						updateElementCache(elementCache, stepArgs.app, filtered.content);
						updateElementCache(sessionElementCache, stepArgs.app, filtered.content);
						enrichActionError(filtered, stepArgs, elementCache);
						const row: SequencedResult = {
							index,
							label: step.label,
							tool: step.tool,
							arguments: stepArgs,
							durationMs: call.durationMs,
							result: filtered,
							expectText: step.expectText,
							expectAbsentText: step.expectAbsentText,
							allowError: step.allowError,
							acceptedElicitations: call.acceptedElicitations,
							elicitationCount: call.elicitationCount,
						};
						try {
							validateStepResult(row);
						} catch (error) {
							row.result.isError = true;
							appendText(row.result, `Sequence stopped: ${errorMessage(error)}`);
							failed = { index, tool: step.tool, message: errorMessage(error) };
						}
						if (detail === "compact") row.result.content = compactContent(row.result.content);
						results.push(row);
						if (failed) break;
					} catch (error) {
						const message = errorMessage(error);
						failed = { index, tool: step.tool, message };
						results.push({
							index,
							label: step.label,
							tool: step.tool,
							arguments: stepArgs,
							durationMs: 0,
							result: failureResult(`Sequence stopped before completing step ${index} (${step.tool}):\n${message}`, maxTextChars),
							expectText: step.expectText,
							expectAbsentText: step.expectAbsentText,
							allowError: step.allowError,
							acceptedElicitations: 0,
							elicitationCount: 0,
						});
						break;
					}
				}
			} finally {
				if (mouseBefore) restoreMousePosition(mouseBefore);
			}
			const mouseAfter = mouseBefore ? getMousePosition() : null;
			return {
				content: sequenceContent(results, Boolean((params as any).includeImage)),
				details: bridgeDetails({
					tool: "sequence",
					threadId: client.status().threadId,
					detail,
					failed,
					implicitRefreshes,
					steps: results.map((step) => ({
						index: step.index,
						tool: step.tool,
						arguments: step.arguments,
						durationMs: step.durationMs,
						isError: step.result.isError,
						omittedImages: step.result.omittedImages,
						savedImagePath: step.result.savedImagePath,
						acceptedElicitations: step.acceptedElicitations,
						elicitationCount: step.elicitationCount,
					})),
					mousePreservation: mouseBefore ? { before: mouseBefore, restored: mouseAfter } : null,
				}, client.status().stderrTail),
			};
		},
	});
}
