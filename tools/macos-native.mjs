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
				compiler.once("exit", code => code === 0 ? resolve() : reject(new Error(`Native helper compilation failed: ${stderr}`)));
			});
			await rename(temporary, binary);
		} finally { await rm(temporary, { force: true }); }
		return binary;
	})();
	try { return await compiled; } catch (error) { compiled = undefined; throw error; }
}

/** One lazy child owned by the caller's session. No retries of potentially applied edits. */
export class MacOSNative {
	#child;
	#starting;
	#pending = new Map();
	#nextId = 0;

	async #start() {
		if (this.#child) return this.#child;
		if (!this.#starting) this.#starting = (async () => {
			const child = spawn(await executable(), [], { stdio: ["pipe", "pipe", "pipe"] });
			let stderr = "";
			child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-4000); });
			const fail = (error, exited = false) => {
				if (this.#child !== child) return;
				if (exited || !child.pid) this.#child = undefined;
				else child.kill(); // Keep the handle so stop() can still wait for actual exit.
				for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
				this.#pending.clear();
			};
			child.once("error", fail);
			child.once("exit", (code, signal) => fail(new Error(`Native helper stopped (${signal ?? code})${stderr ? `: ${stderr}` : ""}. An outstanding edit may already have applied; do not replay.`), true));
			child.stdin.on("error", fail);
			createInterface({ input: child.stdout }).on("line", line => {
				let message;
				try { message = JSON.parse(line); } catch { return; }
				const pending = this.#pending.get(message.id);
				if (!pending) return;
				this.#pending.delete(message.id);
				clearTimeout(pending.timer);
				if (message.result?.error) pending.reject(new Error(message.result.error));
				else pending.resolve(message.result);
			});
			this.#child = child;
			return child;
		})().finally(() => { this.#starting = undefined; });
		return this.#starting;
	}

	async #request(method, args = {}) {
		const child = await this.#start();
		const id = ++this.#nextId;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#pending.delete(id);
				reject(new Error(`Native ${method} timed out; its outcome is unknown. Do not replay an edit.`));
				// Prevent queued commands on a stuck helper from applying later.
				child.kill();
			}, 15_000);
			this.#pending.set(id, { resolve, reject, timer });
			child.stdin.write(`${JSON.stringify({ id, method, ...args })}\n`);
		});
	}

	snapshot() { return this.#request("snapshot"); }
	beginObservation(pids = []) { return this.#request("beginObservation", { pids }); }
	endObservation(id) { return this.#request("endObservation", { observationId: id }); }
	inspectApp(pid) { return this.#request("inspectApp", { pid }); }
	replaceSelectedText(args) { return this.#request("replaceSelectedText", args); }

	async stop() {
		if (this.#starting) await this.#starting.catch(() => {});
		const child = this.#child;
		if (!child) return;
		await new Promise(resolve => {
			const timer = setTimeout(() => child.kill(), 1000);
			child.once("exit", () => { clearTimeout(timer); resolve(); });
			child.stdin.end();
		});
	}
}
