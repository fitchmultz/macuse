import assert from "node:assert/strict";
import test from "node:test";
import { MacOSNative } from "../macos-native.mjs";

// Read-only platform checks: no app activation, fixture creation, key/mouse events, or privacy prompts.
test("native observer multiplexes requests and restarts cleanly", { skip: process.platform !== "darwin" }, async () => {
	const native = new MacOSNative();
	try {
		const observations = await Promise.all([native.beginObservation(), native.beginObservation()]);
		assert.notEqual(observations[0].id, observations[1].id);
		const snapshots = await Promise.all(Array.from({ length: 4 }, () => native.snapshot()));
		for (const snapshot of snapshots) {
			assert.ok(snapshot.frontmost === null || Number.isInteger(snapshot.frontmost.pid));
			assert.ok(snapshot.focusedWindow === null || typeof snapshot.focusedWindow.token === "string");
		}
		for (const { id, before } of observations) {
			const result = await native.endObservation(id);
			assert.deepEqual(result.before, before);
			assert.equal(result.coverage.applicationActivation, true);
			assert.equal(result.coverage.inputAttribution, false);
			assert.ok(Array.isArray(result.transitions));
		}
		await assert.rejects(native.endObservation(observations[0].id), /Unknown observation/);
		await native.stop();
		await native.stop();
		const restarted = await native.beginObservation();
		assert.notEqual(restarted.id, observations[0].id);
		await native.endObservation(restarted.id);
	} finally { await native.stop(); }
});

test("invalid app identity never reports zero windows or attempts a text edit", { skip: process.platform !== "darwin" }, async () => {
	const native = new MacOSNative();
	try {
		await assert.rejects(native.inspectApp(-1), /positive target PID/);
		// This test's Node process has no AX application/window service. A failed read is unknown, not zero.
		const app = await native.inspectApp(process.pid);
		assert.equal(app.windowsCount, null);
		assert.notEqual(app.windowsError, 0);
		const result = await native.replaceSelectedText({ pid: process.pid, expected: {}, text: "café 日本語 🧪\n" });
		assert.equal(result.status, "guard_failed");
		assert.equal(result.mutationAttempted, false);
		const unsupported = await native.replaceSelectedText({ pid: process.pid,
			expected: { windowToken: "absent", windowTitle: null, document: null, elementToken: "absent" }, text: "untouched" });
		assert.equal(unsupported.status, "unsupported");
		assert.equal(unsupported.mutationAttempted, false);
	} finally { await native.stop(); }
});
