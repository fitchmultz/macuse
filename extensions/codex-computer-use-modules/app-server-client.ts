import { createHash } from "node:crypto";
import { spawn, spawnSync, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pickUpstreamToolArgs } from "./upstream-tool-args.mjs";
import {
	ComputerUseError,
	DEFAULT_CODEX_BIN,
	FEATURE_FLAGS,
	PROCESS_REGISTRY_DIR,
	PROCESS_REGISTRY_PREFIX,
	MCP_SERVERS,
	VERSION,
	mcpServerConfigs,
	mcpServerForTool,
	type McpServerName,
	errorMessage,
	isRecord,
	type ApprovalMode,
	type ComputerUseInventory,
	type ComputerUseToolResult,
	type JsonValue,
} from "./core";
import { appServerSessionRecoverySummary, restartComputerUseRuntime, sanitizeRecoverableComputerUseText, withReadOnlyComputerUseRecovery, type ComputerUseRestartSummary } from "./computer-use-recovery";

type ProcessRecord = {
	version: string;
	nonce: string;
	cwd: string;
	codexBin: string;
	ownerPid: number;
	ownerStart: string | null;
	appServerPid: number;
	appServerStart: string | null;
	pidFile: string;
	createdAt: string;
};

type ReapSummary = {
	pidFile: string;
	appServerPid?: number;
	ownerPid?: number;
	action: "removed-dead" | "reaped-orphan" | "kept-active" | "ignored";
	reason: string;
};

function processStart(pid: number): string | null {
	if (!Number.isInteger(pid) || pid <= 0) return null;
	const result = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", timeout: 5_000 });
	if (result.status !== 0) return null;
	return result.stdout.trim() || null;
}

function processCommand(pid: number): string | null {
	if (!Number.isInteger(pid) || pid <= 0) return null;
	const result = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8", timeout: 5_000 });
	if (result.status !== 0) return null;
	return result.stdout.trim() || null;
}

function processAlive(pid: number, expectedStart?: string | null): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
	} catch {
		return false;
	}
	if (!expectedStart) return true;
	return processStart(pid) === expectedStart;
}

function appServerCommandMatches(pid: number, codexBin: string): boolean {
	const command = processCommand(pid);
	if (!command) return false;
	return command.includes(codexBin) && command.includes("app-server") && command.includes("--enable computer_use");
}

function processChildren(): Map<number, number[]> {
	const result = spawnSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8", timeout: 5_000 });
	const children = new Map<number, number[]>();
	if (result.status !== 0) return children;
	for (const line of result.stdout.split("\n")) {
		const [pidText, ppidText] = line.trim().split(/\s+/);
		const pid = Number(pidText);
		const ppid = Number(ppidText);
		if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
		const list = children.get(ppid) ?? [];
		list.push(pid);
		children.set(ppid, list);
	}
	return children;
}

function processTree(rootPid: number): number[] {
	const children = processChildren();
	const ordered: number[] = [];
	const visit = (pid: number) => {
		for (const child of children.get(pid) ?? []) visit(child);
		ordered.push(pid);
	};
	visit(rootPid);
	return ordered;
}

function killProcessTree(rootPid: number, signal: NodeJS.Signals): void {
	for (const pid of processTree(rootPid)) {
		try {
			process.kill(pid, signal);
		} catch {
			// Process may have exited between ps and kill.
		}
	}
}

function registryKey(cwd: string, codexBin: string): string {
	return createHash("sha256").update(`${cwd}\0${codexBin}`).digest("hex").slice(0, 16);
}

function safeUnlink(file: string): void {
	try {
		unlinkSync(file);
	} catch {
		// Already gone or not removable; stale cleanup is best effort.
	}
}

function readProcessRecord(file: string): ProcessRecord | null {
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
		if (!isRecord(parsed)) return null;
		if (parsed.version !== VERSION || typeof parsed.cwd !== "string" || typeof parsed.codexBin !== "string" || typeof parsed.pidFile !== "string") return null;
		if (typeof parsed.nonce !== "string" || typeof parsed.createdAt !== "string") return null;
		if (typeof parsed.ownerPid !== "number" || typeof parsed.appServerPid !== "number") return null;
		return parsed as ProcessRecord;
	} catch {
		return null;
	}
}

function reapStaleAppServers(cwd: string, codexBin: string): ReapSummary[] {
	mkdirSync(PROCESS_REGISTRY_DIR, { recursive: true });
	const key = registryKey(cwd, codexBin);
	const summaries: ReapSummary[] = [];
	for (const name of readdirSync(PROCESS_REGISTRY_DIR)) {
		if (!name.startsWith(`${PROCESS_REGISTRY_PREFIX}${key}-`) || !name.endsWith(".json")) continue;
		const file = path.join(PROCESS_REGISTRY_DIR, name);
		const record = readProcessRecord(file);
		if (!record || record.cwd !== cwd || record.codexBin !== codexBin) {
			summaries.push({ pidFile: file, action: "ignored", reason: "record did not match current cwd/codexBin" });
			continue;
		}
		const appAlive = processAlive(record.appServerPid, record.appServerStart);
		if (!appAlive) {
			safeUnlink(file);
			summaries.push({ pidFile: file, appServerPid: record.appServerPid, ownerPid: record.ownerPid, action: "removed-dead", reason: "app-server process is no longer alive" });
			continue;
		}
		const ownerAlive = processAlive(record.ownerPid, record.ownerStart);
		if (ownerAlive) {
			summaries.push({ pidFile: file, appServerPid: record.appServerPid, ownerPid: record.ownerPid, action: "kept-active", reason: "owner process is still alive" });
			continue;
		}
		if (!appServerCommandMatches(record.appServerPid, codexBin)) {
			summaries.push({ pidFile: file, appServerPid: record.appServerPid, ownerPid: record.ownerPid, action: "ignored", reason: "process command did not match macuse app-server fingerprint" });
			continue;
		}
		killProcessTree(record.appServerPid, "SIGTERM");
		setTimeout(() => {
			if (processAlive(record.appServerPid, record.appServerStart)) killProcessTree(record.appServerPid, "SIGKILL");
		}, 2_000).unref();
		safeUnlink(file);
		summaries.push({ pidFile: file, appServerPid: record.appServerPid, ownerPid: record.ownerPid, action: "reaped-orphan", reason: "owner process is gone" });
	}
	return summaries;
}

const WATCHDOG_SCRIPT = String.raw`
const { spawnSync } = require('node:child_process');
const { existsSync, readFileSync, unlinkSync } = require('node:fs');
const record = JSON.parse(process.argv[1]);
function ps(pid, field) {
  const result = spawnSync('ps', ['-p', String(pid), '-o', field + '='], { encoding: 'utf8', timeout: 5000 });
  return result.status === 0 ? result.stdout.trim() : '';
}
function alive(pid, start) {
  try { process.kill(pid, 0); } catch { return false; }
  return !start || ps(pid, 'lstart') === start;
}
function commandMatches(pid) {
  const command = ps(pid, 'command');
  return command.includes(record.codexBin) && command.includes('app-server') && command.includes('--enable computer_use');
}
function children() {
  const result = spawnSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8', timeout: 5000 });
  const map = new Map();
  if (result.status !== 0) return map;
  for (const line of result.stdout.split('\n')) {
    const [pidText, ppidText] = line.trim().split(/\s+/);
    const pid = Number(pidText), ppid = Number(ppidText);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    const list = map.get(ppid) || [];
    list.push(pid);
    map.set(ppid, list);
  }
  return map;
}
function tree(root) {
  const map = children();
  const out = [];
  function visit(pid) { for (const child of map.get(pid) || []) visit(child); out.push(pid); }
  visit(root);
  return out;
}
function killTree(signal) {
  for (const pid of tree(record.appServerPid)) {
    try { process.kill(pid, signal); } catch {}
  }
}
function samePidFile() {
  try {
    const current = JSON.parse(readFileSync(record.pidFile, 'utf8'));
    return current.nonce === record.nonce && current.appServerPid === record.appServerPid;
  } catch { return false; }
}
const timer = setInterval(() => {
  if (!existsSync(record.pidFile) || !samePidFile()) process.exit(0);
  if (!alive(record.appServerPid, record.appServerStart)) {
    try { unlinkSync(record.pidFile); } catch {}
    process.exit(0);
  }
  if (alive(record.ownerPid, record.ownerStart)) return;
  if (commandMatches(record.appServerPid)) {
    killTree('SIGTERM');
    setTimeout(() => { if (alive(record.appServerPid, record.appServerStart)) killTree('SIGKILL'); }, 2000).unref();
  }
  try { unlinkSync(record.pidFile); } catch {}
  clearInterval(timer);
  setTimeout(() => process.exit(0), 2500).unref();
}, 1000);
timer.unref();
setInterval(() => {}, 60000);
`;

function writeProcessRecord(cwd: string, codexBin: string, appServerPid: number): ProcessRecord {
	mkdirSync(PROCESS_REGISTRY_DIR, { recursive: true });
	const key = registryKey(cwd, codexBin);
	const nonce = createHash("sha256").update(`${process.pid}\0${appServerPid}\0${Date.now()}\0${Math.random()}`).digest("hex").slice(0, 16);
	const pidFile = path.join(PROCESS_REGISTRY_DIR, `${PROCESS_REGISTRY_PREFIX}${key}-${process.pid}-${appServerPid}-${nonce}.json`);
	const record: ProcessRecord = {
		version: VERSION,
		nonce,
		cwd,
		codexBin,
		ownerPid: process.pid,
		ownerStart: processStart(process.pid),
		appServerPid,
		appServerStart: processStart(appServerPid),
		pidFile,
		createdAt: new Date().toISOString(),
	};
	writeFileSync(pidFile, JSON.stringify(record, null, 2));
	return record;
}

function startWatchdog(record: ProcessRecord): ChildProcess | null {
	try {
		const proc = spawn(process.execPath, ["-e", WATCHDOG_SCRIPT, JSON.stringify(record)], {
			detached: true,
			stdio: "ignore",
		});
		proc.unref();
		return proc;
	} catch {
		return null;
	}
}

type PendingRequest = {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
	method: string;
	onAbort?: () => void;
};

type AppServerThread = { id: string } & Record<string, unknown>;

type JsonRpcId = string | number;

type JsonRpcMessage = Record<string, unknown> & {
	id?: unknown;
	method?: unknown;
	params?: unknown;
	result?: unknown;
	error?: { message?: unknown } & Record<string, unknown>;
};

function parseJsonMessage(line: string): JsonRpcMessage | null {
	try {
		const parsed = JSON.parse(line) as unknown;
		return isRecord(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

function computerUseToolResultText(result: ComputerUseToolResult): string {
	return (Array.isArray(result?.content) ? result.content : [])
		.filter((block): block is { type: string; text: string } => isRecord(block) && block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n");
}

function summarizeInventories(statusResult: unknown): Record<McpServerName, ComputerUseInventory> {
	const servers = isRecord(statusResult) && Array.isArray(statusResult.data) ? statusResult.data : [];
	return Object.fromEntries(Object.entries(MCP_SERVERS).map(([name, expected]) => {
		const server = servers.find((candidate) => isRecord(candidate) && candidate.name === name);
		const tools = isRecord(server) && isRecord(server.tools) ? Object.keys(server.tools).sort() : [];
		return [name, { server: name, present: isRecord(server), authStatus: isRecord(server) && typeof server.authStatus === "string" ? server.authStatus : null, toolNames: tools, toolCount: tools.length, missingTools: expected.tools.filter((tool) => !tools.includes(tool)), checkedAt: new Date().toISOString() }];
	})) as Record<McpServerName, ComputerUseInventory>;
}

export class AppServerClient {
	private proc: ChildProcessWithoutNullStreams | null = null;
	private nextId = 1;
	private pending = new Map<number, PendingRequest>();
	private buffer = "";
	private queue: Promise<unknown> = Promise.resolve();
	private initializing: Promise<void> | null = null;
	private initialized: unknown = null;
	private thread: AppServerThread | null = null;
	private currentApproval: ApprovalMode = "inherit";
	private acceptedThisCall = 0;
	private acceptedElicitations = 0;
	private elicitationCount = 0;
	private notifications: Array<{ method: string; params?: unknown }> = [];
	private stderr = "";
	private processRecord: ProcessRecord | null = null;
	private watchdog: ChildProcess | null = null;
	private staleReapSummary: ReapSummary[] = [];
	private inventories: Record<McpServerName, ComputerUseInventory> | null = null;
	private computerUseRecoveryEvents: ComputerUseRestartSummary[] = [];

	constructor(private readonly codexBin = process.env.CODEX_BIN || DEFAULT_CODEX_BIN, private readonly cwd = process.cwd()) {
		this.staleReapSummary = reapStaleAppServers(this.cwd, this.codexBin);
	}

	status() {
		return {
			version: VERSION,
			codexBin: this.codexBin,
			cwd: this.cwd,
			running: Boolean(this.proc && this.proc.exitCode === null && this.proc.signalCode === null),
			processPid: this.proc?.pid ?? null,
			processRecord: this.processRecord,
			watchdogPid: this.watchdog?.pid ?? null,
			registryDir: PROCESS_REGISTRY_DIR,
			staleReapSummary: this.staleReapSummary,
			threadId: this.thread?.id ?? null,
			computerUse: this.inventories?.["computer-use"] ?? null,
			inventories: this.inventories,
			computerUseRecoveryEvents: this.computerUseRecoveryEvents.slice(-10),
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
		if (this.proc.pid) {
			this.processRecord = writeProcessRecord(this.cwd, this.codexBin, this.proc.pid);
			this.watchdog = startWatchdog(this.processRecord);
		}

		this.initialized = await this.request("initialize", {
			clientInfo: { name: "pi-macuse-computer-use", version: VERSION },
			capabilities: { experimentalApi: true, requestAttestation: false },
		}, Math.min(timeoutMs, 15_000), signal);
		this.notify("initialized");
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
				mcp_servers: mcpServerConfigs(),
			},
		}, Math.min(Math.max(timeoutMs, 45_000), 120_000), signal);
		const thread = isRecord(threadStart) && isRecord(threadStart.thread) ? threadStart.thread : null;
		if (typeof thread?.id !== "string") throw new ComputerUseError("thread/start response did not include thread.id", threadStart);
		this.thread = thread as AppServerThread;
		await this.verifyComputerUseInventory(thread.id, Math.min(Math.max(timeoutMs, 10_000), 30_000), signal);
	}

	private async verifyComputerUseInventory(threadId: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		let inventories = summarizeInventories(null);
		for (;;) {
			inventories = summarizeInventories(null);
			let cursor: string | null = null;
			for (let page = 0; page < 10; page += 1) {
				signal?.throwIfAborted();
				const remaining = deadline - Date.now();
				if (remaining <= 0) break;
				const params: Record<string, unknown> = { threadId, detail: "toolsAndAuthOnly", limit: 100 };
				if (cursor) params.cursor = cursor;
				const status = await this.request("mcpServerStatus/list", params, Math.min(Math.max(1_000, remaining), 30_000), signal);
				const pageInventories = summarizeInventories(status);
				for (const name of Object.keys(MCP_SERVERS) as McpServerName[]) {
					if (pageInventories[name].present) inventories[name] = pageInventories[name];
				}
				cursor = isRecord(status) && typeof status.nextCursor === "string" ? status.nextCursor : null;
				if (!cursor) break;
			}
			this.inventories = inventories;
			if (Object.values(inventories).every((inventory) => inventory.present && inventory.missingTools.length === 0)) return;
			if (Date.now() >= deadline) break;
			await new Promise((resolve) => setTimeout(resolve, Math.min(250, deadline - Date.now())));
		}
		for (const inventory of Object.values(inventories)) {
			if (!inventory.present) throw new ComputerUseError(`Codex app-server did not list the ${inventory.server} MCP server before startup timed out.`, inventory);
			if (inventory.missingTools.length) throw new ComputerUseError(`${inventory.server} MCP server is missing required tools: ${inventory.missingTools.join(", ")}`, inventory);
		}
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
		const message = parseJsonMessage(line);
		if (!message) {
			this.stderr += `\n[invalid app-server JSON] ${line.slice(0, 500)}`;
			return;
		}
		const id: JsonRpcId | null = typeof message.id === "number" || typeof message.id === "string" ? message.id : null;
		const pendingId = typeof id === "number" ? id : null;
		if (pendingId !== null && (Object.prototype.hasOwnProperty.call(message, "result") || Object.prototype.hasOwnProperty.call(message, "error")) && this.pending.has(pendingId)) {
			const pending = this.pending.get(pendingId)!;
			clearTimeout(pending.timer);
			if (pending.onAbort) pending.onAbort();
			this.pending.delete(pendingId);
			const errorText = message.error ? String(message.error.message || "JSON-RPC error") : "";
			if (message.error) pending.reject(new ComputerUseError(`${pending.method} failed: ${errorText}`, message.error));
			else pending.resolve(message.result);
			return;
		}
		if (id !== null && typeof message.method === "string") {
			this.onServerRequest({ ...message, id, method: message.method });
			return;
		}
		if (typeof message.method === "string") {
			this.notifications.push({ method: message.method, params: message.params });
			if (this.notifications.length > 50) this.notifications.shift();
		}
	}

	private onServerRequest(request: JsonRpcMessage & { id: JsonRpcId; method: string }): void {
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
		this.inventories = null;
		if (this.processRecord) safeUnlink(this.processRecord.pidFile);
		this.processRecord = null;
		this.watchdog = null;
	}

	private write(message: unknown): void {
		if (!this.proc || !this.proc.stdin.writable) throw new ComputerUseError("Codex app-server stdin is not writable");
		this.proc.stdin.write(`${JSON.stringify(message)}\n`);
	}

	private notify(method: string, params: Record<string, unknown> = {}): void {
		this.write({ jsonrpc: "2.0", method, params });
	}

	private request(method: string, params: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
		const id = this.nextId++;
		return new Promise<unknown>((resolve, reject) => {
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
			} catch (error: unknown) {
				this.pending.delete(id);
				cleanup();
				reject(error);
			}
		});
	}

	private rememberRecovery(recovery: ComputerUseRestartSummary): void {
		this.computerUseRecoveryEvents.push(recovery);
		if (this.computerUseRecoveryEvents.length > 20) this.computerUseRecoveryEvents = this.computerUseRecoveryEvents.slice(-20);
	}

	async recoverAppServerSession(reason: string, timeoutMs: number, signal?: AbortSignal): Promise<ComputerUseRestartSummary> {
		const recovery = appServerSessionRecoverySummary(sanitizeRecoverableComputerUseText(reason).text);
		this.rememberRecovery(recovery);
		await this.stop();
		await this.ensureReady(timeoutMs, signal);
		return recovery;
	}

	async recoverComputerUseSession(reason: string, timeoutMs: number, signal?: AbortSignal): Promise<ComputerUseRestartSummary> {
		const recovery = restartComputerUseRuntime(sanitizeRecoverableComputerUseText(reason).text);
		this.rememberRecovery(recovery);
		await this.stop();
		await this.ensureReady(timeoutMs, signal);
		return recovery;
	}

	async callTool(tool: string, args: Record<string, JsonValue>, opts: { approval: ApprovalMode; timeoutMs: number; signal?: AbortSignal; server?: McpServerName }): Promise<{ result: ComputerUseToolResult; durationMs: number; acceptedElicitations: number; elicitationCount: number }> {
		const upstreamArgs = pickUpstreamToolArgs(tool, args);
		return this.runExclusive(async () => {
			const acceptedBefore = this.acceptedElicitations;
			const elicitationBefore = this.elicitationCount;
			const started = Date.now();
			const server = opts.server ?? mcpServerForTool(tool);
			const result = await withReadOnlyComputerUseRecovery({
				tool,
				resultText: computerUseToolResultText,
				errorMessage,
				errorFactory: (message) => new ComputerUseError(message),
				recover: (reason) => this.recoverAppServerSession(reason, opts.timeoutMs, opts.signal),
				run: async () => {
					await this.ensureReady(opts.timeoutMs, opts.signal);
					this.currentApproval = opts.approval;
					this.acceptedThisCall = 0;
					try {
						const threadId = this.thread?.id;
						if (!threadId) throw new ComputerUseError("Codex app-server thread is not ready.");
						return await this.request("mcpServer/tool/call", {
							threadId,
							server,
							tool,
							arguments: upstreamArgs,
						}, opts.timeoutMs, opts.signal) as ComputerUseToolResult;
					} finally {
						this.currentApproval = "inherit";
						this.acceptedThisCall = 0;
					}
				},
			});
			return {
				result,
				durationMs: Date.now() - started,
				acceptedElicitations: this.acceptedElicitations - acceptedBefore,
				elicitationCount: this.elicitationCount - elicitationBefore,
			};
		});
	}

	async stop(): Promise<void> {
		const proc = this.proc;
		const record = this.processRecord;
		this.proc = null;
		this.thread = null;
		this.initialized = null;
		this.inventories = null;
		this.processRecord = null;
		this.watchdog = null;
		if (record) safeUnlink(record.pidFile);
		if (!proc) return;
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			if (pending.onAbort) pending.onAbort();
			pending.reject(new ComputerUseError("Codex app-server stopped by macuse"));
		}
		this.pending.clear();
		if (proc.exitCode !== null || proc.signalCode !== null) return;
		const pid = proc.pid;
		if (pid) killProcessTree(pid, "SIGTERM");
		else proc.kill("SIGTERM");
		await new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				if (proc.exitCode === null && proc.signalCode === null) {
					if (pid) killProcessTree(pid, "SIGKILL");
					else proc.kill("SIGKILL");
				}
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

