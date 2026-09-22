import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("./macos-native.swift", import.meta.url));
let compiled;
async function executable() {
	if (process.platform !== "darwin") throw new Error("Native Accessibility requires macOS");
	if (!compiled) compiled = (async () => {
		const hash = createHash("sha256").update(await readFile(source)).update(process.arch).digest("hex").slice(0, 20);
		const directory = join(homedir(), "Library", "Caches", "macuse", "native");
		await mkdir(directory, { recursive: true, mode: 0o700 });
		const binary = join(directory, `macos-native-${hash}`);
		try { await access(binary); return binary; } catch { /* Compile once per source revision. */ }
		const temporary = `${binary}.${process.pid}.tmp`;
		try {
			await new Promise((resolve, reject) => {
				const compiler = spawn("/usr/bin/xcrun", ["swiftc", source, "-o", temporary], { stdio: ["ignore", "ignore", "pipe"] });
				let stderr = "";
				compiler.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-8000); });
				compiler.once("error", reject);
				compiler.once("exit", code => code === 0 ? resolve() : reject(new Error(`Native helper compilation failed: ${stderr}. Ensure xcrun swiftc is available from your Xcode or Command Line Tools installation.`)));
			});
			await rename(temporary, binary);
		} finally { await rm(temporary, { force: true }); }
		return binary;
	})();
	try { return await compiled; } catch (error) { compiled = undefined; throw error; }
}

// Verify absence from a successful native window listing, never by reopening the app.
export function nativeWindowClosed(before, after) {
	if (after?.windowsCount === 0) return true;
	if (after?.windowsCount == null || !after.windows?.length) return false;
	return after.windows.every(window => before.url
		? window.document != null && window.document !== before.url
		: before.title != null && window.title != null && window.title !== before.title);
}

export function nativeTextUnavailableReason(state) {
	if (!state) return "Native inspection returned no app state.";
	if (state.accessibilityTrusted === false) return "Native Accessibility access is unavailable (accessibilityTrusted=false). Enable Accessibility for the parent host in System Settings > Privacy & Security > Accessibility, then restart it.";
	if (!state.focusedWindow || !state.focusedElement) return state.windowsError
		? `Native window inspection failed (AX error ${state.windowsError}); focused text insertion capability is unknown.`
		: "Native inspection found no focused window/control; text insertion capability is unknown.";
	if (state.focusedElement.selectedTextError === -25205) return "This focused control does not support verified native text insertion (AXSelectedText unsupported; AX error -25205).";
	if (state.focusedElement.selectedTextError) return `Native selected-text inspection failed (AX error ${state.focusedElement.selectedTextError}).`;
	return "This focused control does not support verified native text insertion (AXSelectedText is not settable).";
}

/** One lazy child owned by the caller's session. No retries of potentially applied edits. */
export class MacOSNative {
	#child;
	#starting;
	#stopping;
	#pending = new Map();
	#nextId = 0;

	async #start() {
		if (this.#stopping) await this.#stopping;
		if (this.#child) return this.#child;
		if (!this.#starting) this.#starting = (async () => {
			const child = spawn(await executable(), [], { stdio: ["pipe", "pipe", "pipe"] });
			let stderr = "";
			child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-4000); });
			const fail = (error, closed = false) => {
				if (this.#child !== child) return;
				if (!closed && child.pid) {
					for (const pending of this.#pending.values()) pending.failure ??= error;
					void this.stop();
					return;
				}
				this.#child = undefined;
				for (const pending of this.#pending.values()) pending.reject(pending.failure ?? error);
			};
			child.once("error", fail);
			child.once("close", (code, signal) => fail(new Error(`Native helper stopped (${signal ?? code})${stderr ? `: ${stderr}` : ""}. An outstanding edit may already have applied; do not replay.`), true));
			child.stdin.on("error", fail);
			createInterface({ input: child.stdout }).on("line", line => {
				let message;
				try { message = JSON.parse(line); } catch { return; }
				const pending = this.#pending.get(message.id);
				if (!pending || pending.failure) return;
				if (message.result?.error) pending.reject(Object.assign(new Error(message.result.error), { dispatched: false }));
				else pending.resolve(message.result);
			});
			this.#child = child;
			return child;
		})().finally(() => { this.#starting = undefined; });
		return this.#starting;
	}

	async #request(method, args = {}, { signal } = {}) {
		let child;
		try {
			signal?.throwIfAborted();
			child = await this.#start();
			signal?.throwIfAborted();
		} catch (error) { throw Object.assign(new Error(String(error?.message ?? error)), { dispatched: false }); }
		const id = ++this.#nextId;
		return new Promise((resolve, reject) => {
			let dispatched = false;
			const finish = (error, result) => {
				this.#pending.delete(id);
				clearTimeout(timer);
				signal?.removeEventListener("abort", aborted);
				if (error) reject(Object.assign(new Error(String(error.message ?? error)), { dispatched: error.dispatched ?? dispatched }));
				else resolve(result);
			};
			const cancel = reason => {
				pending.failure = new Error(`Native ${method} ${reason}; ${dispatched ? "its edit outcome is unknown. Do not replay." : "no edit was dispatched."}`);
				// Reject only after the owned process has exited; cancellation cannot undo an AX write.
				void this.stop();
			};
			const aborted = () => cancel("aborted");
			const timer = setTimeout(() => cancel("timed out"), 15_000);
			const pending = { resolve: result => finish(null, result), reject: error => finish(error) };
			this.#pending.set(id, pending);
			signal?.addEventListener("abort", aborted, { once: true });
			dispatched = method === "replaceSelectedText";
			child.stdin.write(`${JSON.stringify({ id, method, ...args })}\n`, error => {
				if (error && this.#pending.has(id)) { pending.failure = error; void this.stop(); }
			});
		});
	}

	snapshot(options) { return this.#request("snapshot", {}, options); }
	resolveApp(identifier, options) { return this.#request("resolveApp", { identifier }, options); }
	beginObservation(pids = [], options) { return this.#request("beginObservation", { pids }, options); }
	endObservation(id, options) { return this.#request("endObservation", { observationId: id }, options); }
	inspectApp(pid, options) { return this.#request("inspectApp", { pid }, options); }
	replaceSelectedText(args, options) {
		if (typeof args.text !== "string" || !args.text.isWellFormed()) {
			return Promise.reject(Object.assign(new Error("Text must be a well-formed Unicode string; no edit was dispatched."), { dispatched: false }));
		}
		return this.#request("replaceSelectedText", args, options);
	}

	async stop() {
		if (this.#starting) await this.#starting.catch(() => {});
		if (this.#stopping) return this.#stopping;
		const child = this.#child;
		if (!child) return;
		this.#stopping = new Promise(resolve => {
			const timer = setTimeout(() => child.kill("SIGKILL"), 1000);
			child.once("close", () => { clearTimeout(timer); resolve(); });
			child.kill();
		}).finally(() => { this.#stopping = undefined; });
		return this.#stopping;
	}
}
