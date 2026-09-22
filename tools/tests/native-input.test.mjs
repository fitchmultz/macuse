import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough, Writable } from "node:stream";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";
import { insertText } from "../../lib/native-input.mjs";
import { MacOSNative } from "../macos-native.mjs";

const app = { pid: 4242, name: "TextEdit", bundleId: "com.apple.TextEdit", path: "/System/Applications/TextEdit.app" };
const input = { app: app.bundleId, text: "café 漢字 🙂 e\u0301", allowMutating: true, safetyNote: "Replace the selection in the disposable TextEdit fixture only; do not save or send." };
const observation = { app: app.bundleId, title: "Fixture.txt", url: "file:///tmp/Fixture.txt", text: "full CUA observation", observedAt: Date.now(), elements: [],
	focused: { index: "2", id: "First Text View", role: "text entry area", value: "prefix ORIGINAL suffix\n" } };
observation.elements = [observation.focused];
const state = { pid: app.pid, app, accessibilityTrusted: true, windowsCount: 1, windowsError: 0, windows: [],
	focusedWindow: { token: "window", title: observation.title, document: observation.url },
	focusedElement: { token: "field", role: "AXTextArea", roleDescription: "text entry area", identifier: "First Text View", title: null, description: null,
		value: observation.focused.value, selectedTextSettable: true, selectedTextError: 0 } };
const focus = { before: { frontmost: null, focusedWindow: null }, after: { frontmost: null, focusedWindow: null }, transitions: [],
	coverage: { applicationActivation: true, focusedWindow: {}, inputAttribution: false, windowDetails: "targetAppsOnly", truncated: false } };
const applied = { status: "applied", mutationAttempted: true, verified: true, insertedUTF16Length: input.text.length, replacedUTF16Length: 8 };
function fixture(overrides = {}) {
	const calls = [];
	const methods = { resolveApp: async () => app, inspectApp: async () => structuredClone(state), beginObservation: async () => ({ id: "watch" }),
		endObservation: async () => focus, replaceSelectedText: async () => applied, stop: async () => {}, ...overrides };
	return { calls, native: Object.fromEntries(Object.entries(methods).map(([name, fn]) => [name, async (...args) => { calls.push({ name, args }); return fn(...args); }])) };
}
function noEdit(result, f, pattern) {
	assert.equal(result.isError, true);
	assert.equal(result.details.macuse.dispatched, false);
	assert.equal(result.details.macuse.outcome, "not_dispatched");
	assert.match(result.content[0].text, pattern);
	assert.equal(f.calls.some(call => call.name === "replaceSelectedText"), false);
}

test("selected-range insertion preserves exact Unicode, document tokens, field value and honest focus coverage", async () => {
	const f = fixture();
	const result = await insertText(f.native, input, observation);
	assert.equal(result.isError, false);
	assert.equal(result.details.macuse.outcome, "verified");
	assert.equal(result.details.macuse.dispatched, true);
	assert.equal(result.details.macuse.replacedUTF16Length, 8);
	assert.equal(result.details.macuse.insertedUTF16Length, input.text.length);
	assert.equal(result.details.macuse.focus.coverage.inputAttribution, false);
	assert.deepEqual(f.calls.find(call => call.name === "replaceSelectedText").args[0], { pid: app.pid, text: input.text,
		expected: { windowToken: "window", windowTitle: observation.title, document: observation.url, elementToken: "field", value: observation.focused.value } });
	assert.deepEqual(f.calls.map(call => call.name), ["resolveApp", "beginObservation", "inspectApp", "replaceSelectedText", "endObservation"]);
});

test("missing observation, permission flags and malformed Unicode fail before native access", async () => {
	for (const [candidate, observed, pattern] of [
		[input, undefined, /Observe the intended app/],
		[{ ...input, allowMutating: false }, observation, /allowMutating:true/],
		[{ ...input, safetyNote: "short" }, observation, /20 characters/],
		[{ ...input, text: "bad\ud800" }, observation, /well-formed Unicode/],
		[{ ...input, text: "bad\udfff" }, observation, /well-formed Unicode/],
		[{ ...input, expectedTitle: 123 }, observation, /exact string/],
	]) {
		const f = fixture();
		noEdit(await insertText(f.native, candidate, observed), f, pattern);
		assert.equal(f.calls.length, 0);
	}
});

test("no prior focused field refuses before native access rather than editing the current field", async () => {
	const f = fixture();
	noEdit(await insertText(f.native, input, { ...observation, focused: undefined }), f, /did not identify a focused field.*getAXState/);
	assert.equal(f.calls.length, 0);
});

test("CUA display names synthesized from ID/role do not masquerade as native field labels", async () => {
	for (const name of [observation.focused.id, observation.focused.role]) {
		const result = await insertText(fixture().native, input, { ...observation, focused: { ...observation.focused, name } });
		assert.equal(result.isError, false);
	}
	const f = fixture({ inspectApp: async () => ({ ...state, focusedElement: { ...state.focusedElement, role: "AXTextField", roleDescription: "search text field" } }) });
	const focused = { ...observation.focused, role: 'search' };
	assert.equal((await insertText(f.native, input, { ...observation, focused, elements: [focused] })).isError, false);
});

test('indistinguishable fields and duplicate stable IDs cannot authorize an insertion', async () => {
	const focused = { index: '1', role: 'text field', name: 'text field', value: 'same' };
	for (const observed of [
		{ ...observation, focused, elements: [focused, { ...focused, index: '2' }] },
		{ ...observation, elements: [observation.focused, { ...observation.focused, index: '2' }] },
	]) {
		const f = fixture({ inspectApp: async () => ({ ...state, focusedElement: { ...state.focusedElement, identifier: null, roleDescription: 'text field', value: 'same' } }) });
		noEdit(await insertText(f.native, input, observed), f, /unique cross-source identity/);
	}
});

test("missing/ambiguous running-app resolution and another app's observation never dispatch", async () => {
	for (const reason of ["No running app exactly matches TextEdit", "Ambiguous running app TextEdit"]) {
		const f = fixture({ resolveApp: async () => { throw new Error(reason); } });
		noEdit(await insertText(f.native, input, observation), f, new RegExp(reason));
		assert.deepEqual(f.calls.map(call => call.name), ["resolveApp"]);
	}
	const f = fixture();
	noEdit(await insertText(f.native, input, { ...observation, app: "textedit" }), f, /another app/);
	assert.deepEqual(f.calls.map(call => call.name), ["resolveApp"]);
});

test("exact resolved name/path observations are accepted, never fuzzy aliases", async () => {
	for (const identity of [app.name, app.path]) {
		const f = fixture();
		assert.equal((await insertText(f.native, input, { ...observation, app: identity })).isError, false);
	}
});

test("changed document, explicit guards, app identity and focused field refuse before dispatch", async () => {
	for (const [changed, candidate, pattern] of [
		[{ ...state, focusedWindow: { ...state.focusedWindow, document: "file:///tmp/Other.txt" } }, input, /window\/document changed/],
		[state, { ...input, expectedTitle: "Other.txt" }, /Window guard failed/],
		[state, { ...input, expectedUrl: "file:///tmp/Other.txt" }, /Document guard failed/],
		[{ ...state, app: { ...app, path: "/Other.app" } }, input, /app identity changed/],
		...[
			{ identifier: "Other field" }, { roleDescription: "text field" }, { value: "human edited the field" },
		].map(field => [{ ...state, focusedElement: { ...state.focusedElement, ...field } }, input, /focused field or its value changed/]),
	]) {
		const f = fixture({ inspectApp: async () => changed });
		noEdit(await insertText(f.native, candidate, observation), f, pattern);
	}
	const f = fixture();
	noEdit(await insertText(f.native, input, { ...observation, focused: { ...observation.focused, name: "Other field" } }), f, /focused field/);
});

test("document URL wins over abbreviated titles, but explicit title guards remain exact", async () => {
	const abbreviated = { ...observation, title: "Fi…" };
	assert.equal((await insertText(fixture().native, input, abbreviated)).isError, false);
	const f = fixture();
	noEdit(await insertText(f.native, { ...input, expectedTitle: "Fi…" }, abbreviated), f, /Window guard failed/);
	const missingUrl = fixture({ inspectApp: async () => ({ ...state, focusedWindow: { ...state.focusedWindow, document: null } }) });
	noEdit(await insertText(missingUrl.native, input, observation), missingUrl, /window\/document changed/);
	const untitled = { ...observation, url: null };
	const other = fixture({ inspectApp: async () => ({ ...state, focusedWindow: { ...state.focusedWindow, title: "Other.txt", document: null } }) });
	noEdit(await insertText(other.native, input, untitled), other, /window\/document changed/);
});

test("unsupported fields and unavailable Accessibility/compiler keep actionable reasons", async () => {
	for (const [inspectApp, pattern] of [
		[async () => ({ ...state, accessibilityTrusted: false }), /System Settings.*Accessibility/],
		[async () => ({ ...state, focusedElement: { ...state.focusedElement, selectedTextSettable: false, selectedTextError: -25205 } }), /AXSelectedText unsupported/],
		[async () => { throw new Error("Native helper compilation failed: swiftc unavailable"); }, /compilation failed.*swiftc unavailable/],
	]) {
		const f = fixture({ inspectApp });
		noEdit(await insertText(f.native, input, observation), f, pattern);
	}
});

test("Swift preflight refusal is not dispatched; attempted but unverified write is unknown with no replay", async () => {
	for (const edit of [
		{ status: "unsupported", mutationAttempted: false, reason: "AXSelectedText is not settable" },
		{ status: "guard_failed", mutationAttempted: false, reason: "Selection changed" },
		{ status: "unverified", mutationAttempted: true, reason: "Exact text readback did not match; do not replay" },
	]) {
		const f = fixture({ replaceSelectedText: async () => edit });
		const result = await insertText(f.native, input, observation);
		assert.equal(result.isError, true);
		assert.equal(result.details.macuse.dispatched, edit.mutationAttempted);
		assert.equal(result.details.macuse.outcome, edit.mutationAttempted ? "unknown" : "not_dispatched");
		assert.match(result.content[0].text, new RegExp(edit.reason));
		assert.equal(f.calls.filter(call => call.name === "replaceSelectedText").length, 1);
		assert.equal(f.calls.some(call => call.name === "stop"), false);
	}
});

test("a rejected edit waits for native stop and never replays or promises GUI cancellation", async () => {
	let release;
	const stopped = new Promise(resolve => { release = resolve; });
	const f = fixture({ replaceSelectedText: async () => { throw new Error("Native replaceSelectedText timed out"); }, stop: () => stopped });
	let settled = false;
	const pending = insertText(f.native, input, observation).then(result => { settled = true; return result; });
	await nextTurn();
	assert.equal(settled, false);
	assert.equal(f.calls.at(-1).name, "stop");
	release();
	const result = await pending;
	assert.equal(result.details.macuse.outcome, "unknown");
	assert.equal(result.details.macuse.dispatched, true);
	assert.match(result.content[0].text, /Do not replay/);
	assert.doesNotMatch(result.content[0].text, /cancelled|canceled/);
	assert.equal(f.calls.filter(call => call.name === "replaceSelectedText").length, 1);
	assert.equal(f.calls.some(call => call.name === "endObservation"), false);
});

test("pre-dispatch abort and native dispatch:false errors do not claim an attempted edit", async () => {
	for (const reason of [undefined, null, "User stopped the operation"]) {
		const f = fixture();
		noEdit(await insertText(f.native, input, observation, { signal: AbortSignal.abort(reason) }), f, /No edit was dispatched/);
		assert.equal(f.calls.length, 0);
	}
	const failed = fixture({ replaceSelectedText: async () => { throw Object.assign(new Error("aborted before dispatch"), { dispatched: false }); } });
	const result = await insertText(failed.native, input, observation);
	assert.equal(result.details.macuse.dispatched, false);
	assert.equal(result.details.macuse.outcome, "not_dispatched");
});

test("unavailable focus coverage does not erase verified text readback", async () => {
	for (const method of ["beginObservation", "endObservation"]) {
		const f = fixture({ [method]: async () => { throw new Error("Observer unavailable"); } });
		const result = await insertText(f.native, input, observation);
		assert.equal(result.details.macuse.outcome, "verified");
		assert.equal(result.details.macuse.focus.observationAvailable, false);
		assert.equal(result.details.macuse.focus.inputAttribution, false);
		assert.match(result.details.macuse.focus.observationError, /Observer unavailable/);
	}
});

// Exercise the real client lifecycle against a fake subprocess: never launch the native helper or touch the desktop.
function subprocess(t) {
	const children = [];
	const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
	Object.defineProperty(process, "platform", { ...descriptor, value: "darwin" });
	t.mock.method(fs, "access", async () => {});
	t.mock.method(fs, "mkdir", async () => {});
	t.mock.method(childProcess, "spawn", () => {
		const child = new EventEmitter();
		Object.assign(child, { pid: 9876, stdout: new PassThrough(), stderr: new PassThrough(), requests: [], kills: [],
			kill(signal = "SIGTERM") { child.kills.push(signal); return true; },
			respond(result) { child.stdout.write(`${JSON.stringify({ id: child.requests.at(-1).id, result })}\n`); },
		});
		child.stdin = new Writable({ write(chunk, _encoding, callback) { child.requests.push(JSON.parse(String(chunk))); child.emit("request"); callback(); } });
		children.push(child);
		return child;
	});
	syncBuiltinESMExports();
	t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); Object.defineProperty(process, "platform", descriptor); });
	return children;
}
async function requested(children) {
	while (!children.at(-1)?.requests.length) await nextTurn();
	return children.at(-1);
}

test("native resolution forwards exact identifiers, returns identity, and preserves rejection", async t => {
	const children = subprocess(t);
	const native = new MacOSNative();
	const pending = native.resolveApp(app.path);
	const child = await requested(children);
	assert.equal(child.requests[0].identifier, app.path);
	child.respond(app);
	assert.deepEqual(await pending, app);
	const missing = native.resolveApp("No such app");
	await nextTurn();
	child.respond({ error: "No running app exactly matches No such app" });
	await assert.rejects(missing, /No running app exactly/);
	const stopping = native.stop();
	child.emit("close", null, "SIGTERM");
	await stopping;
});

for (const boundary of ["abort", "timeout"]) test(`native ${boundary} waits for helper exit before settling an edit or restarting`, async t => {
	const children = subprocess(t);
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const native = new MacOSNative();
	const controller = new AbortController();
	let settled = false;
	const pending = native.replaceSelectedText({ pid: app.pid, text: input.text, expected: {} }, { signal: controller.signal })
		.catch(error => { settled = true; return error; });
	const child = await requested(children);
	if (boundary === "abort") controller.abort();
	else t.mock.timers.tick(15_000);
	await nextTurn();
	assert.deepEqual(child.kills, ["SIGTERM"]);
	assert.equal(settled, false);
	const after = native.resolveApp(app.bundleId);
	await nextTurn();
	assert.equal(children.length, 1);
	t.mock.timers.tick(1000);
	assert.deepEqual(child.kills, ["SIGTERM", "SIGKILL"]);
	child.emit("close", null, "SIGKILL");
	const error = await pending;
	assert.equal(error.dispatched, true);
	assert.match(error.message, boundary === "abort" ? /aborted/ : /timed out/);
	assert.match(error.message, /outcome is unknown.*Do not replay/);
	await nextTurn();
	assert.equal(children.length, 2);
	const restarted = await requested(children);
	assert.equal(restarted.requests[0].method, "resolveApp");
	restarted.respond(app);
	await after;
	const stopping = native.stop();
	restarted.emit("close", null, "SIGTERM");
	await stopping;
	assert.equal(children.flatMap(c => c.requests).filter(r => r.method === "replaceSelectedText").length, 1);
});

test("helper loss preserves each outstanding request's own dispatch status", async t => {
	const children = subprocess(t);
	const native = new MacOSNative();
	const read = native.inspectApp(app.pid).catch(error => error);
	const child = await requested(children);
	const edit = native.replaceSelectedText({ pid: app.pid, text: input.text, expected: {} }).catch(error => error);
	await nextTurn();
	child.emit("close", 1, null);
	assert.equal((await read).dispatched, false);
	assert.equal((await edit).dispatched, true);
});

test("native malformed Unicode and already-aborted requests never start a subprocess", async t => {
	const children = subprocess(t);
	const native = new MacOSNative();
	await assert.rejects(native.replaceSelectedText({ text: "\ud800" }), error => error.dispatched === false && /well-formed/.test(error.message));
	await assert.rejects(native.inspectApp(app.pid, { signal: AbortSignal.abort() }), error => error.dispatched === false);
	assert.equal(children.length, 0);
});
