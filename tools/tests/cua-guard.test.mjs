import assert from "node:assert/strict";
import test from "node:test";
import { createGuard } from "../../lib/cua-guard-service.mjs";

const tree = ({ title = "fixture", value = "old", index = 1, duplicate = false, focus = index } = {}) => `Window: "fixture", App: App.\n0 standard window ${title}, URL: file:///tmp/fixture\n\t${index} text field (settable) ID: editor, Value: ${value}\n${duplicate ? "\t8 text field (settable) ID: editor, Value: old\n" : ""}\t3 button Save, ID: save, Secondary Actions: Press\n\t4 text unrelated clock\nThe focused UI element is ${focus} text field`;
const gates = { runId: "run-1", apps: ["App"], allowMutating: true, safetyNote: "Change only the isolated fixture field." };
const request = (method, input) => ({ type: "execute", method, args: input === undefined ? [] : [{ app: "App", ...input }] });

function fixture({ mutate, states, nativeApp = 'App' } = {}) {
  let value = "old";
  let reads = 0;
  const calls = [];
  const context = { requestMeta: { macuse: { ...gates } }, setResponseMeta(meta) { this.meta = structuredClone(meta); } };
  const guard = createGuard({ context: () => context, dispatch: async message => {
    calls.push(structuredClone(message));
    if (message.type === "setup") return { target: "mac", methods: ["get_app_state", "list_apps", "set_value", "type_text", "paste", "start_audio_recording", "stop_audio_recording", "unknown"] };
    if (message.method === "get_app_state") return { app: nativeApp, text: states?.[Math.min(reads++, states.length - 1)] ?? tree({ value }), screenshot: null };
    if (message.method === "list_apps") return [{ id: "App" }];
    if (mutate) return mutate(message);
    if (message.method === "set_value") value = message.args[0].value;
  } });
  return { guard, context, calls, actions: () => context.meta.macuse.actions, observe: () => guard(request("get_app_state", {})) };
}

test("setup preserves GUI primitives but removes audio and unknown services; metadata is mandatory", async () => {
  const f = fixture();
  const setup = await f.guard({ type: "setup" });
  assert.deepEqual(setup.methods, ["get_app_state", "list_apps", "set_value", "type_text", "paste"]);
  f.context.requestMeta = {};
  await assert.rejects(f.guard(request("list_apps")), /trusted macuse/);
  await assert.rejects(f.guard({ type: "drag_start", point: [1, 1] }), /trusted macuse/);
});

test("exact app scope, mutation note and pointer gates fail before dispatch", async () => {
  for (const meta of [{ ...gates, allowMutating: false }, { ...gates, apps: ["app"] }, { ...gates, safetyNote: "too short" }]) {
    const f = fixture();
    await f.observe();
    f.context.requestMeta.macuse = meta;
    await assert.rejects(f.guard(request("set_value", { element_index: 1, value: "new" })));
    assert.equal(f.calls.some(c => c.method === "set_value"), false);
  }
  for (const [method, input] of [["click", { element_index: 3 }], ["drag", { from_x: 1, from_y: 1, to_x: 2, to_y: 2 }], ["scroll", { x: 1, y: 1, direction: "down" }]]) {
    const f = fixture();
    await f.observe();
    await assert.rejects(f.guard(request(method, input)), /allowPointer/);
    assert.equal(f.calls.some(c => c.method === method), false);
  }
  const f = fixture();
  await f.observe();
  await f.guard(request("scroll", { element_index: 3, direction: "down" }));
  assert.equal(f.actions()[0].outcome, "completed");
});

test("validate complete arguments and block Unicode typing and clipboard paths before action", async () => {
  for (const [method, input] of [
    ["type_text", { text: "café 漢字 🙂" }], ["paste", { text: "ascii" }], ["press_key", { key: "super+v" }],
    ["select_text", { element_index: 1, text: "old", selection_type: "invalid" }],
    ["scroll", { element_index: 1, direction: "down", pages: Infinity }],
    ["set_value", { element_index: 1, value: "bad\ud800" }], ["select_text", { element_index: 1, text: "bad\udfff" }],
    ["set_value", { element_index: 1, value: 123 }], ["set_value", { element_index: 1, value: "new", hidden: true }],
    ["click", { element_index: 3, x: 1, y: 2 }], ["drag", { from_x: NaN, from_y: 1, to_x: 2, to_y: 2 }],
  ]) {
    const f = fixture();
    await f.observe();
    const count = f.calls.length;
    await assert.rejects(f.guard(request(method, input)));
    assert.equal(f.calls.length, count, `${method} must fail before even preflight`);
    assert.equal(f.actions()[0].dispatched, false);
  }
});

test("native canonical app bindings keep the observed exact scope without fuzzy aliases", async () => {
  const f = fixture({ nativeApp: '/Applications/Test.app' });
  await f.observe();
  await f.guard(request('press_key', { app: '/Applications/Test.app', key: 'Escape' }));
  assert.equal(f.calls.at(-1).method, 'press_key');
  assert.equal(f.context.meta.macuse.observations[0].app, '/Applications/Test.app');
  assert.equal(f.context.meta.macuse.resolvedApps.App, '/Applications/Test.app');
  await assert.rejects(f.guard(request('press_key', { app: 'app', key: 'Escape' })), /outside/);
});

test("primary AX Press remains usable when Sky lists only secondary actions", async () => {
  const f = fixture({ states: [tree().replace('3 button Save, ID: save, Secondary Actions: Press', '3 radio button Description: Memory, Value: 0')] });
  await f.observe();
  await f.guard(request('perform_secondary_action', { element_index: 3, action: 'Press' }));
  assert.equal(f.calls.at(-1).method, 'perform_secondary_action');
  await assert.rejects(f.guard(request('perform_secondary_action', { element_index: 3, action: 'Unlisted action' })), /not listed/);
});

test("preflight rejects document or field drift and ambiguous target identity", async () => {
  for (const after of [tree({ title: "other" }), tree({ value: "external edit" }), tree({ duplicate: true })]) {
    const f = fixture({ states: [tree(), after] });
    await f.observe();
    await assert.rejects(f.guard(request("set_value", { element_index: 1, value: "new" })), /changed/);
    assert.equal(f.calls.some(c => c.method === "set_value"), false);
    assert.equal(f.actions()[0].outcome, "not_dispatched");
  }
});

test("a disappearing row cannot retarget its Delete action to an originally identical button", async () => {
  const files = names => `Window: "Files", App: App.\n0 standard window Files\n${names.map((name, index) =>
    `\t${index * 2 + 1} row ${name}\n\t\t${index * 2 + 2} button Delete`).join("\n")}`;
  const f = fixture({ states: [files(["draft.txt", "important.txt"]), files(["important.txt"])] });
  await f.observe();
  await assert.rejects(f.guard(request("perform_secondary_action", { element_index: 2, action: "Press" })), /changed/);
  assert.equal(f.calls.some(c => c.method === "perform_secondary_action"), false);
  assert.equal(f.actions()[0].outcome, "not_dispatched");
});

test("an idless Delete button cannot move to another row after a list refresh", async () => {
  const files = (name, status = "ready") => `Window: "Files", App: App.\n0 standard window Files\n\t1 row ${name}\n\t\t2 button Delete\n\t3 text ${status}`;
  const press = request("perform_secondary_action", { element_index: 2, action: "Press" });
  const replaced = fixture({ states: [files("draft.txt"), files("important.txt")] });
  await replaced.observe();
  await assert.rejects(replaced.guard(press), /Target identity or value changed/);
  assert.equal(replaced.calls.some(c => c.method === "perform_secondary_action"), false);

  const unrelated = fixture({ states: [files("draft.txt"), files("draft.txt", "updated")] });
  await unrelated.observe();
  await unrelated.guard(press);
  assert.equal(unrelated.actions()[0].outcome, "completed");
});

test("an unlabeled row's filename child anchors its Delete button", async () => {
  const files = name => `Window: "Files", App: App.\n0 standard window Files\n\t1 row\n\t\t2 text ${name}\n\t\t3 button Delete`;
  const f = fixture({ states: [files("draft.txt"), files("important.txt")] });
  await f.observe();
  await assert.rejects(f.guard(request("perform_secondary_action", { element_index: 3, action: "Press" })), /changed/);
  assert.equal(f.calls.some(c => c.method === "perform_secondary_action"), false);
});

test("a reused Delete button ID cannot override a changed row", async () => {
  const files = name => `Window: "Files", App: App.\n0 standard window Files\n\t1 row ${name}\n\t\t2 button Delete, ID: delete`;
  const f = fixture({ states: [files("draft.txt"), files("important.txt")] });
  await f.observe();
  await assert.rejects(f.guard(request("perform_secondary_action", { element_index: 2, action: "Press" })), /changed/);
  assert.equal(f.calls.some(c => c.method === "perform_secondary_action"), false);
});

test("an unlabeled group item's filename sibling anchors Delete", async () => {
  const files = name => `Window: "Files", App: App.\n0 standard window Files\n\t1 group\n\t\t2 text ${name}\n\t\t3 button Delete, ID: delete`;
  const f = fixture({ states: [files("draft.txt"), files("important.txt")] });
  await f.observe();
  await assert.rejects(f.guard(request("perform_secondary_action", { element_index: 3, action: "Press" })), /changed/);
  assert.equal(f.calls.some(c => c.method === "perform_secondary_action"), false);
});

test("a group's Value can be its only item identity", async () => {
  const files = name => `Window: "Files", App: App.\n0 standard window Files\n\t1 group Value: ${name}\n\t\t2 button Delete, ID: delete`;
  const f = fixture({ states: [files("draft.txt"), files("important.txt")] });
  await f.observe();
  await assert.rejects(f.guard(request("perform_secondary_action", { element_index: 2, action: "Press" })), /changed/);
  assert.equal(f.calls.some(c => c.method === "perform_secondary_action"), false);
});

test("a filename nested inside Delete cannot move with a reused button ID", async () => {
  const files = name => `Window: "Files", App: App.\n0 standard window Files\n\t1 row\n\t\t2 button Delete, ID: delete\n\t\t\t3 text ${name}`;
  const f = fixture({ states: [files("draft.txt"), files("important.txt")] });
  await f.observe();
  await assert.rejects(f.guard(request("perform_secondary_action", { element_index: 2, action: "Press" })), /changed/);
  assert.equal(f.calls.some(c => c.method === "perform_secondary_action"), false);
});

test("a row's filename group stays bound to its action group", async () => {
  const files = name => `Window: "Files", App: App.\n0 standard window Files\n\t1 row\n\t\t2 group\n\t\t\t3 text ${name}\n\t\t4 group\n\t\t\t5 button Delete, ID: delete`;
  const f = fixture({ states: [files("draft.txt"), files("important.txt")] });
  await f.observe();
  await assert.rejects(f.guard(request("perform_secondary_action", { element_index: 5, action: "Press" })), /changed/);
  assert.equal(f.calls.some(c => c.method === "perform_secondary_action"), false);
});

test("a group's filename layout stays bound to its action layout", async () => {
  const files = name => `Window: "Files", App: App.\n0 standard window Files\n\t1 group\n\t\t2 group\n\t\t\t3 text ${name}\n\t\t4 group\n\t\t\t5 button Delete, ID: delete`;
  const f = fixture({ states: [files("draft.txt"), files("important.txt")] });
  await f.observe();
  await assert.rejects(f.guard(request("perform_secondary_action", { element_index: 5, action: "Press" })), /changed/);
  assert.equal(f.calls.some(c => c.method === "perform_secondary_action"), false);
});

test("scroll-area layout groups cannot transfer Delete to another item", async () => {
  const files = name => `Window: "Files", App: App.\n0 standard window Files\n\t1 scroll area Library\n\t\t2 group\n\t\t\t3 text ${name}\n\t\t4 group\n\t\t\t5 button Delete, ID: delete`;
  const f = fixture({ states: [files("draft.txt"), files("important.txt")] });
  await f.observe();
  await assert.rejects(f.guard(request("perform_secondary_action", { element_index: 5, action: "Press" })), /changed/);
  assert.equal(f.calls.some(c => c.method === "perform_secondary_action"), false);
});

test("scroll position changes outside the row do not block its Delete button", async () => {
  const files = position => `Window: "Files", App: App.\n0 standard window Files\n\t1 scroll area Library, Value: ${position}\n\t\t2 row draft.txt\n\t\t\t3 button Delete`;
  const f = fixture({ states: [files("0"), files("120")] });
  await f.observe();
  await f.guard(request("perform_secondary_action", { element_index: 3, action: "Press" }));
  assert.equal(f.actions()[0].outcome, "completed");
});

test("typing cannot retarget to an originally identical field when the focused field disappears", async () => {
  const f = fixture({ states: [tree({ duplicate: true }), tree({ index: 8 })] });
  await f.observe();
  await assert.rejects(f.guard(request("type_text", { text: "new" })), /Focused field changed/);
  assert.equal(f.calls.some(c => c.method === "type_text"), false);
  assert.equal(f.actions()[0].outcome, "not_dispatched");
});

test("unique field identity re-resolves its index and exact Unicode setValue readback is required", async () => {
  const value = "café 漢字 🙂\n2026 roadmap\n2026 text of agreement\n  exact trailing whitespace  ";
  const f = fixture({ states: [tree(), tree({ index: 7 }), tree({ index: 7, value })] });
  await f.observe();
  await f.guard(request("set_value", { element_index: 1, value }));
  assert.equal(f.calls.find(c => c.method === "set_value").args[0].element_index, 7);
  assert.equal(f.actions()[0].verification, "exact-field-value");
  assert.equal(f.actions()[0].outcome, "completed");
  assert.equal(f.context.meta.macuse.observations[0].elements.find(e => e.id === "editor").value, value);
});

test("editing a field within a row still verifies its changed value", async () => {
  const files = value => `Window: "Files", App: App.\n0 standard window Files\n\t1 row draft.txt\n\t\t2 text field (settable) ID: editor, Value: ${value}`;
  const f = fixture({ states: [files("old"), files("old"), files("new")] });
  await f.observe();
  await f.guard(request("set_value", { element_index: 2, value: "new" }));
  assert.equal(f.actions()[0].verification, "exact-field-value");
});

test("unrelated text changes cannot verify setValue; caught uncertain action latches this run", async () => {
  const f = fixture({ states: [tree(), tree(), tree().replace("unrelated clock", "new clock")], mutate: () => undefined });
  await f.observe();
  await assert.rejects(f.guard(request("set_value", { element_index: 1, value: "new" })), /readback/);
  const count = f.calls.length;
  await assert.rejects(f.guard(request("press_key", { key: "Escape" })), /uncertain outcome/);
  assert.equal(f.calls.length, count);
  assert.equal(f.actions()[0].dispatched, true);
  assert.equal(f.actions()[0].outcome, "unknown");
  assert.equal(f.actions()[1].dispatched, false);
  f.context.requestMeta.macuse = { ...gates, runId: "run-2" };
  await assert.rejects(f.guard(request("press_key", { key: "Escape" })), /Observe this exact app/);
});

test("dispatch exceptions preserve partial evidence and prohibit replay, even after public reads", async () => {
  const f = fixture({ mutate: () => { throw new Error("native pipe closed"); } });
  await f.observe();
  await assert.rejects(f.guard(request("press_key", { key: "Escape" })), /native pipe closed/);
  await f.observe();
  await assert.rejects(f.guard(request("press_key", { key: "Escape" })), /uncertain outcome/);
  assert.equal(f.calls.filter(c => c.method === "press_key").length, 1);
});

test("full preflight/action/readback units serialize concurrent guest calls and public reads", async () => {
  let release;
  const hold = new Promise(resolve => release = resolve);
  let started;
  const dispatched = new Promise(resolve => started = resolve);
  const f = fixture({ states: [tree(), tree(), tree({ value: "new" })], mutate: async () => { started(); await hold; } });
  await f.observe();
  const first = f.guard(request("set_value", { element_index: 1, value: "new" }));
  await dispatched;
  const publicRead = f.observe();
  const second = f.guard(request("press_key", { key: "Escape" }));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.calls.map(c => c.method), ["get_app_state", "get_app_state", "set_value"]);
  release();
  await Promise.all([first, publicRead, second]);
  assert.deepEqual(f.calls.map(c => c.method), ["get_app_state", "get_app_state", "set_value", "get_app_state", "get_app_state", "get_app_state", "press_key"]);
  assert.ok(f.calls.filter(c => c.method === "get_app_state").every(c => c.args[0].disableDiff === true));
});

test("host insertion invalidates observations once per run without resetting bindings", async () => {
  const f = fixture();
  await f.observe();
  f.context.requestMeta.macuse = { ...gates, runId: "after-insertion", invalidatedApps: ["App"] };
  await assert.rejects(f.guard(request("press_key", { key: "Escape" })), /Observe this exact app/);
  await f.observe();
  await f.guard(request("press_key", { key: "Escape" }));
  assert.equal(f.actions().at(-1).outcome, "completed");
});

test("setValue readback cannot verify a different document or unrelated field", async () => {
  for (const after of [tree({ title: "other", value: "new" }), tree().replace("4 text unrelated clock", "4 text field (settable) ID: unrelated, Value: new")]) {
    const f = fixture({ states: [tree(), tree(), after], mutate: () => undefined });
    await f.observe();
    await assert.rejects(f.guard(request("set_value", { element_index: 1, value: "new" })), /readback/);
    assert.equal(f.actions()[0].outcome, "unknown");
  }
});

test("explicit window close reports identity without a native read that could reopen the app", async () => {
  for (const [method, input] of [["press_key", { key: "super+w" }], ["click", { element_index: 5 }], ["perform_secondary_action", { element_index: 5, action: "Press" }]]) {
    const text = tree().replace("3 button Save", "5 close button Close, Secondary Actions: Press\n3 button Save");
    const f = fixture({ states: [text] });
    f.context.requestMeta.macuse.allowPointer = true;
    await f.observe();
    await f.guard(request(method, input));
    assert.equal(f.calls.at(-1).method, method);
    assert.equal(f.actions()[0].closesWindow, true);
    assert.deepEqual(f.actions()[0].before, { title: "fixture", url: "file:///tmp/fixture" });
    assert.equal(f.actions()[0].verification, "native-returned");
  }
});

test("unsupported native diff and focused-field drift fail closed", async () => {
  const diff = fixture({ states: ['The following is a diff from the previous accessibility tree for Window: "fixture"'] });
  await assert.rejects(diff.observe(), /full app snapshot/);
  const f = fixture({ states: [tree(), tree({ focus: 3 })] });
  await f.observe();
  await assert.rejects(f.guard(request("type_text", { text: "ascii" })), /Focused field changed/);
  assert.equal(f.calls.some(c => c.method === "type_text"), false);
});
