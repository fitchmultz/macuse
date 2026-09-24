import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CuaRuntime, resolveLaunch, appApproval, imageMetadata } from "../../lib/cua-runtime.mjs";

const success = (request, extra = {}) => ({ content: [{ type: "text", text: "ok" }], _meta: { macuse: { runId: request._meta.macuse.runId, actions: [], observations: [], ...extra } } });
const mutating = { code: "mock action", apps: ["App"], allowMutating: true, safetyNote: "Change only the isolated fixture field." };
function fixture(call) {
  const calls = [];
  let connects = 0;
  let closes = 0;
  let diagnostic;
  const runtime = new CuaRuntime({ connect: async (_options, emit) => {
    connects++;
    diagnostic = emit;
    return { callTool: async (request, _schema, options) => {
      calls.push({ request, options });
      if (request.name === "js_reset") return await call?.(request) ?? { content: [] };
      return await call?.(request, diagnostic) ?? success(request);
    }, close: async () => { closes++; } };
  } });
  return { runtime, calls, connects: () => connects, closes: () => closes };
}

test("one owned MCP connection persists, sends trusted gates and retains full observations", async () => {
  const observation = { app: "App", title: "fixture", url: null, text: "complete snapshot", elements: [], observedAt: Date.now() };
  const f = fixture(request => request.name === "js" ? success(request, { observations: [observation] }) : undefined);
  await f.runtime.execute({ code: "var app = mockApp" });
  await f.runtime.execute(mutating);
  assert.equal(f.connects(), 1);
  assert.equal(f.calls[1].request._meta.macuse.apps[0], "App");
  assert.equal(f.calls[1].request._meta.macuse.allowMutating, true);
  assert.equal(f.calls[1].request.arguments.timeout_ms, 90_000);
  assert.equal(f.runtime.getObservation("App").text, "complete snapshot");
  f.runtime.invalidateObservation("App");
  assert.equal(f.runtime.getObservation("App"), undefined);
  await f.runtime.execute({ code: "read again" });
  assert.deepEqual(f.calls[2].request._meta.macuse.invalidatedApps, ["App"]);
  await f.runtime.reset();
  assert.equal(f.runtime.getObservation("App"), undefined);
  assert.equal(f.runtime.status().kernelResets, 1);
  await f.runtime.stop();
  assert.equal(f.closes(), 1);
});

test('host selected-text observations follow native canonical bindings and invalidate that same app', async () => {
  const observation = { app: '/Applications/Test.app', title: 'fixture', text: 'full', observedAt: 1, elements: [] };
  const f = fixture(request => request.name === 'js' ? success(request, { observations: [observation], resolvedApps: { App: observation.app } }) : undefined);
  await f.runtime.execute({ code: 'observe App' });
  assert.equal(f.runtime.getObservation('App').app, observation.app);
  f.runtime.invalidateObservation('App');
  assert.equal(f.runtime.getObservation('App'), undefined);
  await f.runtime.execute({ code: 'observe again' });
  assert.deepEqual(f.calls[1].request._meta.macuse.invalidatedApps, [observation.app]);
  await f.runtime.stop();
});

test("abort uses concurrent js_reset, awaits original settlement, and invalidates queued work", async () => {
  const events = [];
  let rejectActive;
  let started;
  const ready = new Promise(resolve => started = resolve);
  const f = fixture(request => {
    if (request.name === "js_reset") {
      events.push("reset");
      setTimeout(() => { events.push("settled"); rejectActive?.(new Error("kernel reset")); }, 20);
      return { content: [] };
    }
    if (request.arguments.code === "waiting") {
      started();
      return new Promise((_resolve, reject) => rejectActive = reject);
    }
    events.push(request.arguments.code);
    return success(request);
  });
  const controller = new AbortController();
  const first = f.runtime.execute({ code: "waiting", timeoutMs: 2000 }, { signal: controller.signal });
  await ready;
  const queued = f.runtime.execute({ code: "queued-before-reset" });
  controller.abort();
  const result = await first;
  assert.equal(result.details.macuse.status, "unknown");
  assert.equal(result.details.macuse.kernelReset, true);
  assert.equal((await queued).isError, true);
  await f.runtime.execute({ code: "after-reset" });
  assert.ok(events.indexOf("settled") < events.indexOf("after-reset"));
  assert.equal(events.includes("queued-before-reset"), false);
  assert.ok(f.calls.every(c => c.options.signal === undefined), "MCP cancellation alone must not replace native reset");
  assert.equal(f.calls.filter(c => c.request.arguments?.code === "waiting").length, 1);
  await f.runtime.stop();
});

test("explicit reset waits until the running execute result has settled", async () => {
  let release;
  let start;
  const ready = new Promise(resolve => start = resolve);
  const f = fixture(request => {
    if (request.name === "js_reset") { release({ content: [{ type: "text", text: "js execution reset" }], isError: true }); return { content: [] }; }
    start();
    return new Promise(resolve => release = resolve);
  });
  const pending = f.runtime.execute({ code: "wait" });
  await ready;
  const status = await f.runtime.reset();
  assert.equal(status.running, false);
  assert.equal((await pending).details.macuse.kernelReset, true);
  await f.runtime.stop();
});

test("native timeout advice is replaced; observations are cleared and no script is retried", async () => {
  const f = fixture(request => request.name === "js" ? { content: [{ type: "text", text: "Execution timed out. Kernel reset. Please rerun your request." }], isError: true } : undefined);
  const result = await f.runtime.execute(mutating);
  assert.equal(result.details.macuse.status, "unknown");
  assert.equal(result.details.macuse.kernelReset, true);
  assert.equal(result.content.some(c => /rerun your request/i.test(c.text)), false);
  assert.ok(result.content.some(c => /do not automatically replay/.test(c.text)));
  assert.deepEqual(f.calls.map(c => c.request.name), ["js", "js_reset"]);
  await f.runtime.stop();
});

test("lost metadata and diagnostic text cannot certify action success or no dispatch", async () => {
  const updates = [];
  const f = fixture((request, emit) => {
    if (request.name !== "js") return;
    emit({ runId: request._meta.macuse.runId, method: "set_value", dispatched: false, outcome: "completed", verification: "exact-field-value" });
    return { content: [{ type: "text", text: "done" }] };
  });
  const result = await f.runtime.execute(mutating, { onUpdate: update => updates.push(update) });
  assert.equal(result.details.macuse.status, "unknown");
  assert.deepEqual(result.details.macuse.actions, []);
  assert.equal(result.details.macuse.provisionalActions.length, 1);
  assert.equal(updates[0].details.macuse.status, "running");
  await f.runtime.stop();
});

test("an unawaited native action is reset before later code can use the owned runtime", async () => {
  const f = fixture(request => request.name === "js" ? success(request, { actions: [{ method: "press_key", dispatched: true, outcome: "unknown", verification: "none" }] }) : undefined);
  const result = await f.runtime.execute(mutating);
  assert.equal(result.details.macuse.status, "unknown");
  assert.equal(result.details.macuse.interruption, "unsettled-action");
  assert.deepEqual(f.calls.map(c => c.request.name), ["js", "js_reset"]);
  await f.runtime.stop();
});

test("ordinary guest errors preserve authoritative partial outcomes without resetting JS", async () => {
  const action = { id: 1, method: "set_value", app: "App", dispatched: true, outcome: "completed", verification: "exact-field-value" };
  for (const text of ["Error: script failed after the edit", "Invalid timeout setting", "js execution timed out; kernel reset, rerun your request"]) {
    const f = fixture(request => {
      if (request.name !== "js") return;
      const result = success(request, { actions: [action] });
      result._meta["codex/nodeReplExecutionDurationMs"] = 0;
      return { ...result, isError: true, content: [{ type: "text", text }] };
    });
    const result = await f.runtime.execute(mutating);
    assert.equal(result.isError, true);
    assert.equal(result.details.macuse.kernelReset, false, text);
    assert.deepEqual(result.details.macuse.actions, [action]);
    assert.equal(f.calls.length, 1);
    await f.runtime.stop();
  }
});

test("guard rejection caught by guest still surfaces an error and its partial record", async () => {
  const f = fixture(request => request.name === "js" ? success(request, { actions: [{ method: "set_value", dispatched: false, outcome: "not_dispatched", error: "outside app scope" }] }) : undefined);
  const result = await f.runtime.execute(mutating);
  assert.equal(result.isError, true);
  assert.match(result.content.at(-1).text, /outside app scope/);
  await f.runtime.stop();
});

test("reset failure closes the connection and still settles a possibly dispatched call", async () => {
  let rejectCall;
  let started;
  const ready = new Promise(resolve => started = resolve);
  const controller = new AbortController();
  let closed = false;
  const runtime = new CuaRuntime({ connect: async () => ({
    callTool: request => {
      if (request.name === "js_reset") return Promise.reject(new Error("transport closed"));
      started();
      return new Promise((_resolve, reject) => rejectCall = reject);
    },
    close: async () => { closed = true; rejectCall(new Error("transport closed")); },
  }) });
  const pending = runtime.execute(mutating, { signal: controller.signal });
  await ready;
  controller.abort();
  const result = await pending;
  assert.equal(result.details.macuse.status, "unknown");
  assert.equal(result.isError, true);
  assert.equal(closed, true);
  assert.equal(runtime.status().connected, false);
  await runtime.stop();
});

test("invalid envelopes and pre-aborted calls never start the native runtime", async () => {
  const f = fixture();
  assert.throws(() => f.runtime.execute({ ...mutating, safetyNote: " \n " }), /safetyNote/);
  for (const timeoutMs of [NaN, 999, 300_001]) assert.throws(() => f.runtime.execute({ code: "mock", timeoutMs }), /timeoutMs/);
  const result = await f.runtime.execute(mutating, { signal: AbortSignal.abort() });
  assert.equal(result.isError, true);
  assert.equal(f.connects(), 0);
  assert.equal(f.calls.length, 0);
});

test("only computer app-access elicitations inherit standing approval", () => {
  const params = { message: 'Allow Computer Use to use "App"?', _meta: { connector_id: "computer-use", codex_approval_kind: "mcp_tool_call", tool_name: "get_app_state", tool_params: { app: "com.example.App" } } };
  assert.equal(appApproval({ params }).action, "accept");
  assert.equal(appApproval({ params: { ...params, _meta: { ...params._meta, tool_name: "start_audio_recording" } } }).action, "decline");
  assert.equal(appApproval({ params: { ...params, _meta: { ...params._meta, connector_id: "other" } } }).action, "decline");
  for (const message of ['Allow access to App?', 'Autoriser l’accès à « App » ?', '']) {
    assert.equal(appApproval({ params: { ...params, message } }).action, "accept");
  }
  assert.equal(appApproval({ params: { ...params, _meta: { ...params._meta, tool_name: "paste" } } }).action, "accept");
  assert.equal(appApproval({ params: { ...params, _meta: { ...params._meta, codex_approval_kind: "privacy" } } }).action, "decline");
  assert.equal(appApproval({ params: { ...params, _meta: { ...params._meta, tool_params: { app: "App", permission: "all" } } } }).action, "decline");
  assert.equal(appApproval({ params: { ...params, _meta: undefined } }).action, "decline");
});

test("launcher resolves manifest/package exports, limits trust and preserves CODEX_HOME", async t => {
  const root = await mkdtemp(join(tmpdir(), "macuse-cua-launch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const modules = join(root, "cua_node", "custom-modules");
  for (const name of ["cua-repl", "sky"]) await mkdir(join(modules, "@oai", name), { recursive: true });
  await writeFile(join(root, "cua_node", "manifest.json"), JSON.stringify({ node_path: "bin/vendor-node", node_repl_path: "bin/vendor-repl", node_modules: "custom-modules" }));
  await writeFile(join(modules, "@oai", "cua-repl", "package.json"), JSON.stringify({ bin: { "cua-repl": "bin/launcher.mjs" } }));
  await writeFile(join(modules, "@oai", "sky", "package.json"), JSON.stringify({ name: "@oai/sky", exports: { "./service": "./native-service.js" } }));
  await writeFile(join(modules, "@oai", "sky", "native-service.js"), "");
  const old = process.env.CODEX_HOME;
  process.env.CODEX_HOME = "/tmp/explicit-codex-home";
  try {
    const config = await resolveLaunch({ resourcesPath: root, cwd: root });
    assert.equal(config.command, join(root, "cua_node/bin/vendor-node"));
    assert.equal(config.env.CODEX_HOME, "/tmp/explicit-codex-home");
    assert.equal(config.env.CUA_REPL_ENABLED_SURFACES, "computer");
    assert.equal(config.env.CODEX_CLI_PATH, join(root, "codex"));
    assert.match(config.env.MACUSE_SKY_SERVICE_URL, /native-service\.js$/);
    assert.equal(config.env.NODE_REPL_TRUSTED_CODE_PATHS.split(":").length, 2);
    assert.deepEqual(Object.keys(JSON.parse(config.env.NODE_REPL_TRUSTED_SERVICES)), ["sky"]);
    assert.equal(JSON.stringify(config).includes("disable-sandbox"), false);
    assert.equal(JSON.stringify(config).includes("plugin-cache"), false);
  } finally { if (old === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = old; }
});

test("image signatures correct JPEG MIME and dimensions without changing payload or coordinate space", async () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 3, 26, 3, 0, 1, 1, 0x11, 0, 0xff, 0xd9]).toString("base64");
  assert.deepEqual(imageMetadata(jpeg), { mimeType: "image/jpeg", width: 768, height: 794 });
  const f = fixture(request => request.name === "js" ? { ...success(request), content: [{ type: "image", data: jpeg, mimeType: "image/png" }] } : undefined);
  const result = await f.runtime.execute({ code: "mock screenshot" });
  assert.equal(result.content[0].data, jpeg);
  assert.equal(result.content[0].mimeType, "image/jpeg");
  assert.equal(result.details.macuse.images[0].coordinateSpace, "native-screenshot");
  const png = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
  png.write("IHDR", 12); png.writeUInt32BE(4000, 16); png.writeUInt32BE(3000, 20);
  assert.deepEqual(imageMetadata(png.toString("base64")), { mimeType: "image/png", width: 4000, height: 3000 });
  assert.deepEqual(imageMetadata(Buffer.from("not an image").toString("base64")), {});
  await f.runtime.stop();
});
