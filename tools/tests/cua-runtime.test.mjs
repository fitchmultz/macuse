import assert from "node:assert/strict";
import nodeTest from "node:test";
import { mkdtemp, mkdir, writeFile, chmod, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CuaRuntime, resolveLaunch, appApproval, imageMetadata } from "../../lib/cua-runtime.mjs";
import {
  MACUSE_API_DOC,
  SUPPRESS_STATE_END,
  SUPPRESS_STATE_START,
  installCuaBanner,
} from "../../lib/cua-banner.mjs";

/** @typedef {import("../../lib/cua-runtime.mjs").CuaToolRequest} CuaToolRequest */
/** @typedef {import("../../lib/cua-runtime.mjs").CuaCallToolOptions} CuaCallToolOptions */
/** @typedef {NonNullable<Parameters<import("../../lib/cua-runtime.mjs").CuaRuntime["execute"]>[1]>["onUpdate"]} OnUpdate */
/** @typedef {Parameters<NonNullable<OnUpdate>>[0]} CuaUpdate */
/** @typedef {import("../../lib/cua-runtime.mjs").CuaContent} CuaContent */
/**
 * Fixture tool results the fake client resolves with.
 * @typedef {{ content: CuaContent[], _meta?: ({ macuse: Record<string, unknown> } & Record<string, unknown>) | undefined, isError?: boolean }} FakeToolResult
 */
/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
/**
 * @param {CuaToolRequest} request
 * @param {Record<string, unknown>} [extra]
 * @returns {FakeToolResult}
 */
const success = (request, extra = {}) => {
  const gates = request._meta?.macuse;
  return {
    content: [{ type: "text", text: "ok" }],
    _meta: { macuse: { runId: gates?.runId, actions: [], observations: [], ...extra } },
  };
};
const mutating = {
  code: "mock action",
  apps: ["App"],
  allowMutating: true,
  safetyNote: "Change only the isolated fixture field.",
};
/**
 * @param {(request: CuaToolRequest, emit?: (event: unknown) => void) => unknown} [call]
 */
function fixture(call) {
  /** @type {{ request: CuaToolRequest, options: CuaCallToolOptions | undefined }[]} */
  const calls = [];
  let connects = 0;
  let closes = 0;
  /** @type {((event: unknown) => void) | undefined} */
  let diagnostic;
  const runtime = new CuaRuntime({
    connect: async (_options, emit) => {
      connects++;
      diagnostic = emit;
      return {
        callTool: async (request, _schema, options) => {
          calls.push({ request, options });
          if (request.name === "js_reset") {
            return (await call?.(request)) ?? { content: [] };
          }
          return (await call?.(request, diagnostic)) ?? success(request);
        },
        close: async () => {
          closes++;
        },
      };
    },
  });
  return { runtime, calls, connects: () => connects, closes: () => closes };
}

nodeTest(
  "one owned MCP connection persists, sends trusted gates and retains full observations",
  async () => {
    const observation = {
      app: "App",
      title: "fixture",
      url: null,
      text: "complete snapshot",
      elements: [],
      observedAt: Date.now(),
    };
    let jsCalls = 0;
    const f = fixture((request) => {
      if (request.name !== "js") {
        return;
      }
      jsCalls++;
      return jsCalls === 3
        ? success(request, {
            actions: [
              {
                method: "press_key",
                app: "App",
                dispatched: true,
                outcome: "unknown",
                verification: "none",
                error: "Native completion was not reported.",
              },
            ],
          })
        : success(request, { observations: [observation] });
    });
    await f.runtime.execute({ code: "var app = mockApp" });
    await f.runtime.execute(mutating);
    assert.equal(f.connects(), 1);
    const mutatingCall = f.calls[1];
    if (mutatingCall === undefined) {
      assert.fail("mutating call missing");
    }
    const gates = mutatingCall.request._meta?.macuse;
    if (gates === undefined) {
      assert.fail("trusted gates missing");
    }
    assert.ok(Array.isArray(gates.apps) && gates.apps[0] === "App");
    assert.equal(gates.allowMutating, true);
    assert.equal(mutatingCall.request.arguments.timeout_ms, 90_000);
    const observed = f.runtime.getObservation("App");
    if (observed === undefined) {
      assert.fail("App observation missing");
    }
    assert.equal(observed.text, "complete snapshot");
    // An uncertain action drops the app's observation here and in the guard's next run.
    const uncertain = await f.runtime.execute(mutating);
    assert.equal(uncertain.details.macuse.status, "unknown");
    assert.equal(f.runtime.getObservation("App"), undefined);
    await f.runtime.execute({ code: "read again" });
    const nextCall = f.calls[3];
    if (nextCall === undefined) {
      assert.fail("next call missing");
    }
    assert.deepEqual(nextCall.request._meta?.macuse?.invalidatedApps, ["App"]);
    await f.runtime.reset();
    assert.equal(f.runtime.getObservation("App"), undefined);
    assert.equal(f.runtime.status().kernelResets, 1);
    await f.runtime.stop();
    assert.equal(f.closes(), 1);
  },
);

nodeTest("host observations follow native canonical app bindings", async () => {
  const observation = {
    app: "/Applications/Test.app",
    title: "fixture",
    text: "full",
    observedAt: 1,
    elements: [],
  };
  const f = fixture((request) =>
    request.name === "js"
      ? success(request, { observations: [observation], resolvedApps: { App: observation.app } })
      : undefined,
  );
  await f.runtime.execute({ code: "observe App" });
  const observed = f.runtime.getObservation("App");
  if (observed === undefined) {
    assert.fail("App observation missing");
  }
  assert.equal(observed.app, observation.app);
  await f.runtime.stop();
});

nodeTest(
  "abort uses concurrent js_reset, awaits original settlement, and invalidates queued work",
  async () => {
    /** @type {unknown[]} */
    const events = [];
    /** @type {((reason?: unknown) => void) | undefined} */
    let rejectActive;
    /** @type {PromiseWithResolvers<void>} */
    const ready = Promise.withResolvers();
    const f = fixture((request) => {
      if (request.name === "js_reset") {
        events.push("reset");
        setTimeout(() => {
          events.push("settled");
          rejectActive?.(new Error("kernel reset"));
        }, 20);
        return { content: [] };
      }
      if (request.arguments.code === "waiting") {
        ready.resolve();
        return new Promise((_resolve, reject) => {
          rejectActive = reject;
        });
      }
      events.push(request.arguments.code);
      return success(request);
    });
    const controller = new AbortController();
    const first = f.runtime.execute(
      { code: "waiting", timeoutMs: 2000 },
      { signal: controller.signal },
    );
    await ready.promise;
    const queued = f.runtime.execute({ code: "queued-before-reset" });
    controller.abort();
    const result = await first;
    assert.equal(result.details.macuse.status, "unknown");
    assert.equal(result.details.macuse.kernelReset, true);
    assert.equal((await queued).isError, true);
    await f.runtime.execute({ code: "after-reset" });
    assert.ok(events.indexOf("settled") < events.indexOf("after-reset"));
    assert.equal(events.includes("queued-before-reset"), false);
    assert.ok(
      f.calls.every((c) => c.options?.signal === undefined),
      "MCP cancellation alone must not replace native reset",
    );
    assert.equal(f.calls.filter((c) => c.request.arguments.code === "waiting").length, 1);
    await f.runtime.stop();
  },
);

nodeTest("explicit reset waits until the running execute result has settled", async () => {
  /** @type {((value: unknown) => void) | undefined} */
  let release;
  /** @type {PromiseWithResolvers<void>} */
  const ready = Promise.withResolvers();
  const f = fixture((request) => {
    if (request.name === "js_reset") {
      release?.({ content: [{ type: "text", text: "js execution reset" }], isError: true });
      return { content: [] };
    }
    ready.resolve();
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  const pending = f.runtime.execute({ code: "wait" });
  await ready.promise;
  const status = await f.runtime.reset();
  assert.equal(status.running, false);
  assert.equal((await pending).details.macuse.kernelReset, true);
  await f.runtime.stop();
});

nodeTest(
  "native timeout advice is replaced; observations are cleared and no script is retried",
  async () => {
    const f = fixture((request) =>
      request.name === "js"
        ? {
            content: [
              {
                type: "text",
                text: "Execution timed out. Kernel reset. Please rerun your request.",
              },
            ],
            isError: true,
          }
        : undefined,
    );
    const result = await f.runtime.execute(mutating);
    assert.equal(result.details.macuse.status, "unknown");
    assert.equal(result.details.macuse.kernelReset, true);
    assert.equal(
      result.content.some((c) => c.type === "text" && /rerun your request/i.test(c.text)),
      false,
    );
    assert.ok(
      result.content.some((c) => c.type === "text" && /do not automatically replay/.test(c.text)),
    );
    assert.deepEqual(
      f.calls.map((c) => c.request.name),
      ["js", "js_reset"],
    );
    await f.runtime.stop();
  },
);

nodeTest(
  "lost metadata and diagnostic text cannot certify action success or no dispatch",
  async () => {
    /** @type {CuaUpdate[]} */
    const updates = [];
    const f = fixture((request, emit) => {
      if (request.name !== "js") {
        return;
      }
      emit?.({
        runId: request._meta?.macuse?.runId,
        method: "set_value",
        dispatched: false,
        outcome: "completed",
        verification: "exact-field-value",
      });
      return { content: [{ type: "text", text: "done" }] };
    });
    const result = await f.runtime.execute(mutating, {
      onUpdate: (update) => updates.push(update),
    });
    assert.equal(result.details.macuse.status, "unknown");
    assert.deepEqual(result.details.macuse.actions, []);
    assert.ok(Array.isArray(result.details.macuse.provisionalActions));
    assert.equal(result.details.macuse.provisionalActions.length, 1);
    const firstUpdate = updates[0];
    if (firstUpdate === undefined) {
      assert.fail("first update missing");
    }
    assert.equal(firstUpdate.details.macuse.status, "running");
    await f.runtime.stop();
  },
);

nodeTest(
  "an unawaited native action is reset before later code can use the owned runtime",
  async () => {
    const f = fixture((request) =>
      request.name === "js"
        ? success(request, {
            actions: [
              { method: "press_key", dispatched: true, outcome: "unknown", verification: "none" },
            ],
          })
        : undefined,
    );
    const result = await f.runtime.execute(mutating);
    assert.equal(result.details.macuse.status, "unknown");
    assert.equal(result.details.macuse.interruption, "unsettled-action");
    assert.deepEqual(
      f.calls.map((c) => c.request.name),
      ["js", "js_reset"],
    );
    await f.runtime.stop();
  },
);

nodeTest(
  "ordinary guest errors preserve authoritative partial outcomes without resetting JS",
  async () => {
    const action = {
      id: 1,
      method: "set_value",
      app: "App",
      dispatched: true,
      outcome: "completed",
      verification: "exact-field-value",
    };
    for (const text of [
      "Error: script failed after the edit",
      "Invalid timeout setting",
      "js execution timed out; kernel reset, rerun your request",
    ]) {
      const f = fixture((request) => {
        if (request.name !== "js") {
          return;
        }
        const result = success(request, { actions: [action] });
        if (result._meta === undefined) {
          assert.fail("fake result meta missing");
        }
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
  },
);

nodeTest(
  "guard rejection caught by guest still surfaces an error and its partial record",
  async () => {
    const f = fixture((request) =>
      request.name === "js"
        ? success(request, {
            actions: [
              {
                method: "set_value",
                dispatched: false,
                outcome: "not_dispatched",
                error: "outside app scope",
              },
            ],
          })
        : undefined,
    );
    const result = await f.runtime.execute(mutating);
    assert.equal(result.isError, true);
    const lastBlock = result.content.at(-1);
    if (lastBlock === undefined || lastBlock.type !== "text") {
      assert.fail("text result missing");
    }
    assert.match(lastBlock.text, /outside app scope/);
    await f.runtime.stop();
  },
);

nodeTest(
  "reset failure closes the connection and still settles a possibly dispatched call",
  async () => {
    /** @type {((reason?: unknown) => void) | undefined} */
    let rejectCall;
    /** @type {PromiseWithResolvers<void>} */
    const ready = Promise.withResolvers();
    const controller = new AbortController();
    let closed = false;
    const runtime = new CuaRuntime({
      connect: async () => ({
        callTool: (request) => {
          if (request.name === "js_reset") {
            return Promise.reject(new Error("transport closed"));
          }
          ready.resolve();
          return new Promise((_resolve, reject) => {
            rejectCall = reject;
          });
        },
        close: async () => {
          closed = true;
          rejectCall?.(new Error("transport closed"));
        },
      }),
    });
    const pending = runtime.execute(mutating, { signal: controller.signal });
    await ready.promise;
    controller.abort();
    const result = await pending;
    assert.equal(result.details.macuse.status, "unknown");
    assert.equal(result.isError, true);
    assert.equal(closed, true);
    assert.equal(runtime.status().connected, false);
    await runtime.stop();
  },
);

nodeTest("invalid envelopes and pre-aborted calls never start the native runtime", async () => {
  const f = fixture();
  assert.throws(() => f.runtime.execute({ ...mutating, safetyNote: " \n " }), /safetyNote/);
  for (const timeoutMs of [NaN, 0, -1, 2_147_468_648]) {
    assert.throws(() => f.runtime.execute({ code: "mock", timeoutMs }), /timeoutMs/);
  }
  const result = await f.runtime.execute(mutating, { signal: AbortSignal.abort() });
  assert.equal(result.isError, true);
  assert.equal(f.connects(), 0);
  assert.equal(f.calls.length, 0);
});

nodeTest("caller deadlines supported by the native runtime are passed through", async () => {
  const f = fixture();
  for (const timeoutMs of [1, 999, 300_001, 2_147_468_647]) {
    const result = await f.runtime.execute({ code: "mock", timeoutMs });
    assert.equal(result.isError, false);
    const lastCall = f.calls.at(-1);
    if (lastCall === undefined) {
      assert.fail("deadline call missing");
    }
    assert.equal(lastCall.request.arguments.timeout_ms, timeoutMs);
    assert.equal(lastCall.options?.timeout, timeoutMs + 15_000);
  }
  await f.runtime.stop();
});

nodeTest("only computer app-access elicitations inherit standing approval", () => {
  const params = {
    message: 'Allow Computer Use to use "App"?',
    _meta: {
      connector_id: "computer-use",
      codex_approval_kind: "mcp_tool_call",
      tool_name: "get_app_state",
      tool_params: { app: "com.example.App" },
    },
  };
  assert.equal(appApproval({ params }).action, "accept");
  assert.equal(
    appApproval({
      params: { ...params, _meta: { ...params._meta, tool_name: "start_audio_recording" } },
    }).action,
    "decline",
  );
  assert.equal(
    appApproval({ params: { ...params, _meta: { ...params._meta, connector_id: "other" } } })
      .action,
    "decline",
  );
  for (const message of ["Allow access to App?", "Autoriser l’accès à « App » ?", ""]) {
    assert.equal(appApproval({ params: { ...params, message } }).action, "accept");
  }
  assert.equal(
    appApproval({ params: { ...params, _meta: { ...params._meta, tool_name: "paste" } } }).action,
    "accept",
  );
  assert.equal(
    appApproval({
      params: { ...params, _meta: { ...params._meta, codex_approval_kind: "privacy" } },
    }).action,
    "decline",
  );
  assert.equal(
    appApproval({
      params: {
        ...params,
        _meta: { ...params._meta, tool_params: { app: "App", permission: "all" } },
      },
    }).action,
    "decline",
  );
  assert.equal(appApproval({ params: { ...params, _meta: undefined } }).action, "decline");
});

for (const packaged of [false, true]) {
  nodeTest(
    `launcher resolves ${packaged ? "packaged" : "legacy"} Codex, limits trust and preserves CODEX_HOME`,
    async (t) => {
      const root = await mkdtemp(join(tmpdir(), "macuse-cua-launch-"));
      t.after(() => rm(root, { recursive: true, force: true }));
      const modules = join(root, "cua_node", "custom-modules");
      for (const name of ["cua-repl", "sky"]) {
        await mkdir(join(modules, "@oai", name), { recursive: true });
      }
      await writeFile(
        join(root, "cua_node", "manifest.json"),
        JSON.stringify({
          node_path: "bin/vendor-node",
          node_repl_path: "bin/vendor-repl",
          node_modules: "custom-modules",
        }),
      );
      await writeFile(
        join(modules, "@oai", "cua-repl", "package.json"),
        JSON.stringify({ bin: { "cua-repl": "bin/launcher.mjs" } }),
      );
      await writeFile(
        join(modules, "@oai", "sky", "package.json"),
        JSON.stringify({ name: "@oai/sky", exports: { "./service": "./native-service.js" } }),
      );
      await writeFile(join(modules, "@oai", "sky", "native-service.js"), "");
      const codex = join(root, packaged ? "codex-cli/bin/codex" : "codex");
      await mkdir(join(root, "codex-cli/bin"), { recursive: true });
      await writeFile(codex, "#!/bin/sh\nexit 0\n");
      await chmod(codex, 0o755);
      if (packaged) {
        await writeFile(
          join(root, "codex-cli/codex-package.json"),
          JSON.stringify({ layoutVersion: 1, version: "0.164.0", entrypoint: "bin/codex" }),
        );
      }
      const old = process.env.CODEX_HOME;
      process.env.CODEX_HOME = "/tmp/explicit-codex-home";
      try {
        const config = await resolveLaunch({ resourcesPath: root, cwd: root });
        assert.equal(config.command, join(root, "cua_node/bin/vendor-node"));
        assert.equal(config.env.CODEX_HOME, "/tmp/explicit-codex-home");
        assert.equal(config.env.CUA_REPL_ENABLED_SURFACES, "computer");
        assert.equal(config.env.CODEX_CLI_PATH, codex);
        assert.match(config.env.MACUSE_SKY_SERVICE_URL, /native-service\.js$/);
        assert.equal(config.env.NODE_REPL_TRUSTED_CODE_PATHS.split(":").length, 2);
        assert.match(config.env.NODE_REPL_JS_BANNER ?? "", /cua-banner\.mjs/);
        assert.match(config.env.NODE_REPL_JS_BANNER ?? "", /installCuaBanner/);
        const trustedServices = /** @type {unknown} */ (
          JSON.parse(config.env.NODE_REPL_TRUSTED_SERVICES)
        );
        assert.ok(isRecord(trustedServices), "trusted services manifest must be an object");
        assert.deepEqual(Object.keys(trustedServices), ["sky"]);
        assert.equal(JSON.stringify(config).includes("disable-sandbox"), false);
        assert.equal(JSON.stringify(config).includes("plugin-cache"), false);
      } finally {
        if (old === undefined) {
          delete process.env.CODEX_HOME;
        } else {
          process.env.CODEX_HOME = old;
        }
      }
    },
  );
}

nodeTest(
  "image signatures correct JPEG MIME and dimensions without changing payload or coordinate space",
  async () => {
    const jpeg = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 3, 26, 3, 0, 1, 1, 0x11, 0, 0xff,
      0xd9,
    ]).toString("base64");
    assert.deepEqual(imageMetadata(jpeg), { mimeType: "image/jpeg", width: 768, height: 794 });
    const f = fixture((request) =>
      request.name === "js"
        ? { ...success(request), content: [{ type: "image", data: jpeg, mimeType: "image/png" }] }
        : undefined,
    );
    const result = await f.runtime.execute({ code: "mock screenshot" });
    const firstBlock = result.content[0];
    if (firstBlock === undefined || firstBlock.type !== "image") {
      assert.fail("image result missing");
    }
    assert.equal(firstBlock.data, jpeg);
    assert.equal(firstBlock.mimeType, "image/jpeg");
    const firstImage = result.details.macuse.images[0];
    if (firstImage === undefined) {
      assert.fail("macuse image receipt missing");
    }
    assert.equal(firstImage.coordinateSpace, "native-screenshot");
    const png = Buffer.alloc(24);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
    png.write("IHDR", 12);
    png.writeUInt32BE(4000, 16);
    png.writeUInt32BE(3000, 20);
    assert.deepEqual(imageMetadata(png.toString("base64")), {
      mimeType: "image/png",
      width: 4000,
      height: 3000,
    });
    assert.deepEqual(imageMetadata(Buffer.from("not an image").toString("base64")), {});
    await f.runtime.stop();
  },
);

nodeTest(
  "pre-execution syntax and import errors do not reset the kernel or invalidate observations",
  async () => {
    const observation = {
      app: "App",
      title: "fixture",
      url: null,
      text: "existing snapshot",
      elements: [],
      observedAt: Date.now(),
    };
    let callCount = 0;
    const f = fixture((request) => {
      if (request.name !== "js") {
        return;
      }
      callCount++;
      if (callCount === 1) {
        return success(request, { observations: [observation] });
      }
      if (callCount <= 3) {
        const code = callCount === 2 ? "syntax_error" : "import_error";
        const snippet =
          code === "syntax_error" ? 'Expected ";" but found "timeoutMs"' : `pre-exec ${code}`;
        return {
          isError: true,
          content: [{ type: "text", text: snippet }],
          _meta: { "codex/telemetry": { error_code: code } },
        };
      }
      return success(request);
    });
    await f.runtime.execute({ code: "var app = await cua.getApp('App')" });
    for (const code of ["return 1;", 'import foo from "nope";']) {
      const failed = await f.runtime.execute({ ...mutating, code });
      assert.equal(failed.isError, true);
      assert.equal(failed.details.macuse.status, "failed");
      assert.equal(failed.details.macuse.kernelReset, false);
      assert.notEqual(f.runtime.getObservation("App"), undefined);
    }
    await f.runtime.execute({ code: "check follow-up" });
    assert.deepEqual(f.calls.at(-1)?.request._meta?.macuse?.invalidatedApps, []);
    assert.equal(
      f.calls.some((c) => c.request.name === "js_reset"),
      false,
    );
    await f.runtime.stop();
  },
);

nodeTest(
  "timeout watchdog waits past native reset delivery and surfaces timeout if fallback fires",
  async () => {
    /** @type {string[]} */
    const events = [];
    const slowNative = fixture(
      (request) =>
        new Promise((resolve) => {
          if (request.name !== "js") {
            events.push(request.name);
            resolve({ content: [] });
            return;
          }
          setTimeout(() => {
            events.push("native_result");
            resolve({
              isError: true,
              content: [{ type: "text", text: "js execution timed out; kernel reset" }],
            });
          }, 300);
        }),
    );
    const nativeWon = await slowNative.runtime.execute({ code: "wait", timeoutMs: 50 });
    assert.equal(nativeWon.details.macuse.status, "unknown");
    assert.deepEqual(events, ["native_result", "js_reset"]);
    const firstBlock = nativeWon.content[0];
    assert.match(firstBlock?.type === "text" ? firstBlock.text : "", /timed out/);
    await slowNative.runtime.stop();

    /** @type {((value: unknown) => void) | undefined} */
    let release;
    const hungNative = fixture((request) => {
      if (request.name === "js_reset") {
        release?.({ isError: true, content: [{ type: "text", text: "js execution reset" }] });
        return { content: [] };
      }
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    const fallbackWon = await hungNative.runtime.execute({ code: "hang", timeoutMs: 10 });
    assert.equal(fallbackWon.details.macuse.status, "unknown");
    assert.equal(fallbackWon.details.macuse.interruption, "timeout");
    assert.ok(
      fallbackWon.content.some(
        (c) => c.type === "text" && /Execution timed out after 10ms; kernel reset\./.test(c.text),
      ),
    );
    await hungNative.runtime.stop();
  },
);

nodeTest(
  "failed mid-script runs emit the latest guard observation when absent from visible output",
  async () => {
    const f = fixture((request) => {
      if (request.name !== "js") {
        return;
      }
      const staleSnapshot = {
        app: "Finder",
        title: "Desktop",
        url: null,
        text: 'Window: "Desktop", App: Finder.\n0 list stale',
        elements: [],
        observedAt: Date.now() - 60_000,
      };
      const freshSnapshot = {
        app: "Brave Browser",
        title: "Cloudflare",
        url: "https://dash.cloudflare.com/",
        text: 'Window: "Cloudflare", App: Brave Browser.\n0 standard window Cloudflare\n\t1 menu\n\t\t2 View summary',
        elements: [],
        observedAt: Date.now(),
      };
      const res = success(request, {
        observations: [staleSnapshot, freshSnapshot],
        actions: [
          {
            id: 1,
            method: "perform_secondary_action",
            app: "Brave Browser",
            dispatched: false,
            outcome: "not_dispatched",
            verification: "none",
            error: "Target identity not confirmed: index 99",
          },
        ],
      });
      return {
        ...res,
        content: [
          {
            type: "text",
            text: 'Window: "New Tab", App: Brave Browser.\n0 standard window New Tab',
          },
        ],
      };
    });
    const failed = await f.runtime.execute(mutating);
    assert.equal(failed.isError, true);
    const text = failed.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
    assert.match(text, /Latest observed Brave Browser state from this failed run:/);
    assert.match(text, /2 View summary/);
    assert.doesNotMatch(text, /0 list stale/);
    const lastBlock = failed.content.at(-1);
    assert.match(
      lastBlock?.type === "text" ? lastBlock.text : "",
      /Target identity not confirmed: index 99/,
    );
    await f.runtime.stop();

    const uncertain = fixture((request) => {
      if (request.name !== "js") {
        return;
      }
      const res = success(request, {
        observations: [
          {
            app: "Brave Browser",
            title: "Cloudflare",
            url: "https://dash.cloudflare.com/",
            text: 'Window: "Cloudflare", App: Brave Browser.\n0 standard window Cloudflare\n\t2 View summary',
            elements: [],
            observedAt: Date.now(),
          },
        ],
        actions: [
          {
            id: 1,
            method: "perform_secondary_action",
            app: "Brave Browser",
            dispatched: true,
            outcome: "unknown",
            verification: "none",
            error: "Native completion was not reported.",
          },
        ],
      });
      return { ...res, content: [] };
    });
    const uncertainResult = await uncertain.runtime.execute(mutating);
    assert.equal(uncertainResult.details.macuse.status, "unknown");
    const uncertainText = uncertainResult.content
      .map((c) => (c.type === "text" ? c.text : ""))
      .join("\n");
    assert.doesNotMatch(uncertainText, /from this failed run/);
    assert.doesNotMatch(uncertainText, /2 View summary/);
    await uncertain.runtime.stop();
  },
);

nodeTest("installCuaBanner adds silent getApp, distinct state IDs, and waitFor", async () => {
  /** @type {{ text: string, itemId: string | undefined }[]} */
  const writes = [];
  const stateLog = [
    'Window: "Loading", App: Demo.\n0 static text Loading...',
    'Window: "Tokens", App: Demo.\n0 button API Tokens',
  ];
  let pollIndex = 0;
  /** @type {{ cua?: { getApp: (name: string, opts?: unknown) => Promise<{ getAXState: (opts?: unknown) => Promise<string>, waitFor: (predicate: unknown, opts?: unknown) => Promise<string> }> } }} */
  const fakeRoot = {};
  await installCuaBanner({
    globalObject: fakeRoot,
    repl: {
      write(/** @type {string} */ text, /** @type {string | undefined} */ itemId) {
        writes.push({ text, itemId });
      },
    },
    loadVendor: async () => {
      fakeRoot.cua = {
        async getApp(/** @type {string} */ name) {
          const initial = `Window: "Init", App: ${name}.`;
          writes.push({ text: initial, itemId: "cua.state" });
          return {
            async getAXState(/** @type {unknown} */ opts) {
              const fullRequested = isRecord(opts) && opts.disableDiffing === true;
              const next = fullRequested
                ? (stateLog[Math.min(pollIndex++, stateLog.length - 1)] ?? "")
                : "There has been no change in the accessibility tree.";
              if (!isRecord(opts) || opts.emit !== false) {
                writes.push({ text: next, itemId: "cua.state" });
              }
              return next;
            },
            async waitFor() {
              return "";
            },
          };
        },
      };
    },
  });
  const cua = fakeRoot.cua;
  assert.ok(cua !== undefined);
  const app = await cua.getApp("Demo", { emit: false });
  assert.equal(writes.length, 3);
  assert.equal(writes.at(0)?.text, SUPPRESS_STATE_START);
  assert.equal(writes.at(2)?.text, SUPPRESS_STATE_END);
  const matched = await app.waitFor((/** @type {string} */ s) => s.includes("API Tokens"), {
    timeoutMs: 200,
    intervalMs: 5,
  });
  assert.match(matched, /API Tokens/);
  // waitFor polled silently (no extra write for "Loading...") and emitted once with distinct itemId.
  assert.equal(writes.length, 4);
  assert.equal(writes.at(3)?.itemId, "cua.state.1");
  assert.equal(writes.at(3)?.text, matched);
  await app.getAXState();
  assert.equal(writes.at(4)?.itemId, "cua.state.2");
  await assert.rejects(
    () =>
      app.waitFor((/** @type {string} */ s) => s.includes("Missing"), {
        timeoutMs: 15,
        intervalMs: 5,
      }),
    /waitFor timed out after 15ms/,
  );
  await assert.rejects(() => app.waitFor(123), TypeError);
  await assert.rejects(() => app.waitFor(() => true, { timeoutMs: 0 }), RangeError);
});

nodeTest(
  "runtime replaces vendor docs once per session, strips suppressed getApp state, and deduplicates state blocks",
  async () => {
    const vendorDoc =
      "## Computer Use\n\nControl native apps and browsers on the user's computer.\ncua_repl\n";
    const treeA = 'Window: "Dashboard", App: Brave Browser.\n0 button View Tokens';
    const treeB = 'Window: "API Tokens", App: Brave Browser.\n0 button Create Token';
    let turn = 0;
    const f = fixture((request) => {
      if (request.name !== "js") {
        return;
      }
      turn++;
      if (turn === 1) {
        return {
          ...success(request),
          content: [
            { type: "text", text: vendorDoc },
            { type: "text", text: treeA },
            { type: "text", text: treeA },
            { type: "text", text: "console log ok" },
          ],
        };
      }
      return {
        ...success(request),
        content: [
          { type: "text", text: vendorDoc },
          { type: "text", text: `${SUPPRESS_STATE_START}${treeA}${SUPPRESS_STATE_END}${treeB}` },
        ],
      };
    });
    const first = await f.runtime.execute({ code: "first call" });
    assert.deepEqual(
      first.content.map((c) => (c.type === "text" ? c.text : "")),
      [MACUSE_API_DOC, treeA, "console log ok"],
    );
    await f.runtime.reset();
    const afterReset = await f.runtime.execute({ code: "after reset" });
    assert.deepEqual(
      afterReset.content.map((c) => (c.type === "text" ? c.text : "")),
      [treeB],
    );
    await f.runtime.stop();
  },
);
