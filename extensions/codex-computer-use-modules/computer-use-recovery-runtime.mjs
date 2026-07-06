import { spawnSync } from "node:child_process";

const COMPUTER_USE_APP = `${process.env.HOME ?? ""}/.codex/computer-use/Codex Computer Use.app`;
const SERVICE_PATH = `${COMPUTER_USE_APP}/Contents/MacOS/SkyComputerUseService`;
const APP_SESSION_STOPPED_TEXT = "This application session has been explicitly stopped by the user for this turn.";
const APP_SESSION_STOPPED_OUTPUT = "Computer Use application session is stopped for this target. Upstream returned no app state/action result. macuse treats this as a normal tool error, not an instruction to end the agent turn. Restart or re-approve Computer Use, then retry macuse.";
const READ_ONLY_AUTO_RECOVERY_TOOLS = new Set(["list_apps", "get_app_state"]);

export function isRecoverableComputerUseSessionText(text) {
	return /Computer Use application session is stopped|This application session has been explicitly stopped|Transport closed|transport closed|connection closed|channel closed/i.test(String(text));
}

export function sanitizeRecoverableComputerUseText(text) {
	const value = String(text);
	if (!value.includes(APP_SESSION_STOPPED_TEXT)) return { text: value, forcedError: false };
	return { text: APP_SESSION_STOPPED_OUTPUT, forcedError: true };
}

export function shouldAutoRecoverComputerUse(tool, text, enabled = true) {
	return enabled && READ_ONLY_AUTO_RECOVERY_TOOLS.has(tool) && isRecoverableComputerUseSessionText(text);
}

export function appServerSessionRecoverySummary(reason) {
	const now = new Date().toISOString();
	return { reason, scope: "app-server-session", startedAt: now, finishedAt: now, targets: [] };
}

export async function withReadOnlyComputerUseRecovery({ tool, enabled = true, run, resultText, recover, errorMessage, errorFactory = (message) => new Error(message) }) {
	let recovered = false;
	for (;;) {
		try {
			const result = await run();
			if (!recovered && shouldAutoRecoverComputerUse(tool, resultText(result), enabled)) {
				recovered = true;
				await recover(`recoverable ${tool} result from Computer Use`);
				continue;
			}
			return result;
		} catch (error) {
			const message = errorMessage ? errorMessage(error) : error?.message || String(error);
			const sanitized = sanitizeRecoverableComputerUseText(message);
			if (!recovered && shouldAutoRecoverComputerUse(tool, message, enabled)) {
				recovered = true;
				await recover(`recoverable ${tool} error from Computer Use: ${sanitized.text}`);
				continue;
			}
			if (sanitized.forcedError) throw errorFactory(sanitized.text, error);
			throw error;
		}
	}
}

function sleep(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function computerUseProcesses() {
	const ps = spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8", timeout: 10_000 });
	if (ps.status !== 0) return [];
	return ps.stdout.split("\n").flatMap((line) => {
		const trimmed = line.trim();
		if (!trimmed) return [];
		const [pidText, ...rest] = trimmed.split(/\s+/);
		const pid = Number(pidText);
		const cmd = rest.join(" ");
		if (!Number.isInteger(pid) || pid === process.pid) return [];
		if (cmd === SERVICE_PATH || cmd.endsWith("SkyComputerUseClient mcp") || cmd.includes("SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient mcp")) return [{ pid, cmd }];
		return [];
	});
}

function pidExists(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function signalTarget(target, signal) {
	try {
		process.kill(target.pid, signal);
		return { ...target, signal };
	} catch (error) {
		if (!pidExists(target.pid)) return { ...target, signal: "already-exited" };
		return { ...target, signal: "failed", error: error?.message || String(error) };
	}
}

export function restartComputerUseRuntime(reason) {
	const startedAt = new Date().toISOString();
	const targets = computerUseProcesses();
	const results = [];
	for (const target of targets) results.push(signalTarget(target, "SIGTERM"));
	if (targets.length > 0) sleep(1_500);
	for (const target of targets) {
		if (pidExists(target.pid)) results.push(signalTarget(target, "SIGKILL"));
	}
	return { reason, scope: "computer-use-runtime", startedAt, finishedAt: new Date().toISOString(), targets: results };
}
