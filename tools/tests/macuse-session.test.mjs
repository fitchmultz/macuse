import assert from "node:assert/strict";
import nodeTest from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MacuseSession } from "../../lib/macuse-session.mjs";
import { CuaRuntime } from "../../lib/cua-runtime.mjs";
import { parseAppState } from "../../lib/app-state.mjs";
import { createGuard } from "../../lib/cua-guard-service.mjs";
import { activityMonitorCheck } from "../validate-macuse.mjs";

/** @typedef {import("../../lib/macuse-session.mjs").SessionRuntime} SessionRuntime */
/** @typedef {import("../../lib/macuse-session.mjs").SessionNative} SessionNative */
/** @typedef {import("../../lib/macuse-session.mjs").SessionAuxiliary} SessionAuxiliary */
/** @typedef {import("../../lib/macuse-session.mjs").SessionResult} SessionResult */
/** @typedef {import("../../lib/app-state.mjs").AppObservation} AppObservation */
/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
/**
 * @typedef {{ requestMeta: { macuse?: unknown }, meta: { macuse?: Record<string, unknown> } | undefined, setResponseMeta: (meta: unknown) => void }} GuardContext
 */

/**
 * @param {import("../../lib/macuse-session.mjs").Content | undefined} part
 * @returns {string}
 */
const textOf = (part) => (part !== undefined && part.type === "text" ? part.text : "");
/**
 * @returns {SessionResult}
 */
const result = () => ({
  content: [{ type: "text", text: "Observed" }],
  isError: false,
  details: { macuse: {} },
});
const focused = {
  index: "1",
  role: "text field",
  name: "editor field",
  id: "editor",
  value: "old",
  disabled: false,
  settable: true,
  secondaryActions: [],
  line: "",
  context: "",
  cellValueContext: "",
  descendants: "",
};
/** @type {AppObservation} */
const observed = {
  app: "Test",
  title: "Fixture",
  url: null,
  documentIdentity: null,
  nativeWindowIdentity: true,
  observedAt: 1,
  text: 'Window: "Fixture", App: Test',
  elements: [focused],
  focused,
};
const app = { pid: 42, bundleId: "test.app", name: "Test", path: "/Test.app" };
/** @type {import("../../tools/macos-native.mjs").NativeAppState} */
const state = {
  pid: 42,
  app,
  accessibilityTrusted: true,
  windowsCount: 1,
  windowsError: 0,
  windows: null,
  focusedWindow: { token: "w", title: "Fixture", document: null },
  focusedElement: {
    token: "f",
    role: "AXTextField",
    roleDescription: "text field",
    identifier: "editor",
    title: "editor field",
    description: null,
    value: "old",
    selectedTextSettable: true,
    selectedTextError: 0,
  },
};
function fixture() {
  /** @type {string[]} */
  const events = [];
  /** @type {SessionRuntime & { observation: AppObservation | undefined }} */
  const runtime = {
    observation: observed,
    execute: async () => {
      events.push("code");
      runtime.observation = { ...observed, observedAt: Date.now() };
      const current = runtime.observation;
      return {
        ...result(),
        details: { macuse: { observations: [current] } },
      };
    },
    getObservation: () => runtime.observation,
    invalidateObservation: (identifier) => {
      events.push(`invalidate:${identifier}`);
      runtime.observation = undefined;
    },
    reset: async () => {
      events.push("reset");
    },
    stop: async () => {
      events.push("stop-code");
    },
    status: () => ({ running: false }),
  };
  /** @type {SessionNative} */
  const native = {
    resolveApp: async () => app,
    inspectApp: async () => state,
    beginObservation: async () => ({ id: "watch" }),
    endObservation: async () => ({
      before: { frontmost: null, focusedWindow: null },
      after: { frontmost: null, focusedWindow: null },
      transitions: [],
      coverage: {
        applicationActivation: true,
        focusedWindow: {},
        truncated: false,
        inputAttribution: false,
        windowDetails: "targetAppsOnly",
      },
    }),
    replaceSelectedText: async () => ({
      status: "applied",
      verified: true,
      mutationAttempted: true,
      insertedUTF16Length: 4,
      replacedUTF16Length: 0,
    }),
    stop: async () => {
      events.push("stop-native");
    },
  };
  /** @type {SessionAuxiliary} */
  const auxiliary = {
    callTool: async () => {
      events.push("auxiliary");
      return result();
    },
    stop: async () => {
      events.push("stop-auxiliary");
    },
    status: () => ({ running: false }),
  };
  return {
    events,
    runtime,
    native,
    auxiliary,
    session: new MacuseSession({ runtime, native, auxiliary }),
  };
}

nodeTest(
  "a rejected code run settles its focus observation and preserves the failure",
  async () => {
    const f = fixture();
    const failure = new Error("native execution failed");
    const end = f.native.endObservation;
    f.native.beginObservation = async () => {
      f.events.push("begin");
      return { id: "watch" };
    };
    f.native.endObservation = async (id, options) => {
      f.events.push(`end:${id}`);
      return end(id, options);
    };
    f.runtime.execute = async () => {
      f.events.push("execute");
      throw failure;
    };
    await assert.rejects(
      f.session.callTool("macuse", { code: "42" }),
      (error) => error === failure,
    );
    assert.deepEqual(f.events, ["begin", "execute", "end:watch"]);
  },
);

nodeTest(
  "code never starts auxiliary transport; invalid envelopes fail before native access",
  async () => {
    const f = fixture();
    const valid = await f.session.callTool("macuse", { code: "42", trackFocus: false });
    assert.equal(valid.isError, false);
    assert.deepEqual(f.events, ["code"]);
    /** @type {[string, Record<string, unknown>][]} */
    const invalidInputs = [
      // Deliberately runtime-invalid input (a JSON array): this exercises the
      // session-side validation path, which the typed boundary cannot express.
      // oxlint-disable-next-line no-unsafe-type-assertion -- QX-006: Test intentionally passes invalid input.
      ["macuse", /** @type {Record<string, unknown>} */ (JSON.parse("[]"))],
      ["macuse", { code: 1 }],
      ["macuse", { code: "42", trackFocus: "false" }],
      ["macuse_insert_text", {}],
      ["unknown", {}],
    ];
    for (const [name, input] of invalidInputs) {
      const invalid = await f.session.callTool(name, input);
      assert.equal(invalid.isError, true);
      assert.equal(invalid.details.macuse.dispatched, false);
    }
    assert.deepEqual(f.events, ["code"]);
    await f.session.stop();
  },
);

nodeTest("session accepts native deadline values outside the old wrapper range", async () => {
  const f = fixture();
  for (const timeoutMs of [999, 300_001]) {
    const callResult = await f.session.callTool("macuse", {
      code: "42",
      timeoutMs,
      trackFocus: false,
    });
    assert.equal(callResult.isError, false);
  }
  assert.deepEqual(f.events, ["code", "code"]);
  await f.session.stop();
});

nodeTest(
  "missing Sky focus marker is joined only to a unique matching native ID in the observed document",
  async () => {
    for (const mismatch of [
      false,
      "document",
      "value",
      "duplicate",
      "page label",
      "sheet",
      "window",
    ]) {
      const f = fixture();
      const source =
        typeof mismatch === "string" && ["page label", "sheet", "window"].includes(mismatch)
          ? parseAppState(
              "Test",
              `Window: "", App: Test.\n0 ${mismatch === "page label" ? "window Secondary Actions: Raise\n\t1 HTML content chrome-extension://fixture.invalid/popup.html" : `${mismatch} Fixture`}\n\t2 text field ID: editor, Value: old`,
            )
          : observed;
      const field = source.focused ?? source.elements.find((e) => e.id === "editor");
      if (field === undefined) {
        assert.fail("missing editor field");
      }
      const { focused: _omitted, ...rest } = source;
      /** @type {AppObservation} */
      const observation = {
        ...rest,
        observedAt: Date.now() + 1000,
        elements: mismatch === "duplicate" ? [field, field] : source.elements,
      };
      f.runtime.execute = async () => ({
        ...result(),
        details: { macuse: { observations: [observation] } },
      });
      const baseWindow = state.focusedWindow;
      const baseElement = state.focusedElement;
      f.native.inspectApp = async () => ({
        ...state,
        focusedWindow:
          baseWindow === null
            ? null
            : { ...baseWindow, title: mismatch === "document" ? "Other" : source.title },
        focusedElement:
          baseElement === null
            ? null
            : { ...baseElement, value: mismatch === "value" ? "changed" : "old" },
      });
      await f.session.callTool("macuse", { code: "observe", trackFocus: false });
      assert.equal(
        observation.focused?.id,
        mismatch !== false ? undefined : "editor",
        String(mismatch),
      );
    }
  },
);

nodeTest(
  "guard-generated close evidence cannot certify labels or nonstandard roots absent from a populated native window list",
  async () => {
    for (const [
      root,
      nativeTitle,
      nativeDocument,
      closed,
    ] of /** @type {[string, string, string | null, boolean][]} */ ([
      [
        "window Secondary Actions: Raise\n\t1 HTML content chrome-extension://fixture.invalid/popup.html",
        "",
        null,
        false,
      ],
      [
        "standard window Secondary Actions: Raise\n\t1 HTML content chrome-extension://fixture.invalid/popup.html",
        "",
        null,
        false,
      ],
      ["sheet Confirmation", "Parent window", null, false],
      ["window Confirmation", "Parent window", null, false],
      ["standard window Fixture", "Other window", null, true],
      ["standard window Fixture", "Fixture", null, false],
      [
        "standard window Fixture, URL: file:///tmp/Fixture.txt",
        "Other window",
        "file:///tmp/Other.txt",
        true,
      ],
      [
        "standard window Fixture, URL: file:///tmp/Fixture.txt",
        "Other window",
        "file:///tmp/Fixture.txt",
        false,
      ],
      ["standard window Fixture, URL: file:///tmp/Fixture.txt", "Other window", null, false],
    ])) {
      for (const empty of [false, true]) {
        const f = fixture();
        let reads = 0,
          closes = 0;
        /**
         * @typedef {{ requestMeta: { macuse?: Record<string, unknown> } | undefined, meta: { macuse?: Record<string, unknown> } | undefined, setResponseMeta: (meta: unknown) => void }} CloseGuardContext
         */
        /** @type {CloseGuardContext} */
        const context = {
          requestMeta: undefined,
          meta: undefined,
          setResponseMeta(meta) {
            const cloned = structuredClone(meta);
            this.meta = isRecord(cloned) && isRecord(cloned.macuse) ? cloned : undefined;
          },
        };
        const guard = createGuard({
          context: () => context,
          dispatch: async (request) => {
            if (request.method === "get_app_state") {
              reads++;
              return { app: "Test", text: `Window: "", App: Test.\n0 ${root}` };
            }
            assert.equal(request.method, "press_key");
            closes++;
            return;
          },
        });
        f.runtime.execute = async (input) => {
          context.requestMeta = {
            macuse: { runId: "close-regression", ...(isRecord(input) ? input : {}) },
          };
          await guard({ type: "execute", method: "get_app_state", args: [{ app: "Test" }] });
          await guard({
            type: "execute",
            method: "press_key",
            args: [{ app: "Test", key: "cmd+w" }],
          });
          const published = context.meta;
          return {
            ...result(),
            details: { macuse: published?.macuse ?? {} },
          };
        };
        f.native.inspectApp = async () => ({
          ...state,
          windowsCount: empty ? 0 : 1,
          windows: empty ? [] : [{ token: "w", title: nativeTitle, document: nativeDocument }],
        });
        const response = await f.session.callTool("macuse", {
          code: "observe then close",
          apps: ["Test"],
          allowMutating: true,
          safetyNote: "Close only the observed fixture.",
          trackFocus: false,
        });
        assert.equal(response.isError, false);
        const actionList = response.details.macuse.actions;
        const action =
          Array.isArray(actionList) && isRecord(actionList[0]) ? actionList[0] : undefined;
        if (action === undefined) {
          assert.fail("missing close action record");
        }
        assert.equal(action.dispatched, true);
        assert.equal(action.closesWindow, true);
        assert.equal(
          action.verification,
          empty || closed ? "native-window-closed" : "native-returned",
          `${root}; empty=${empty}`,
        );
        assert.equal(
          response.content.some(
            (part) =>
              part.type === "text" && part.text.includes("confirms the target window is closed"),
          ),
          empty || closed,
        );
        assert.equal(reads, 2, "close verification must not reopen the app via Sky");
        assert.equal(closes, 1, "close must never be replayed");
      }
    }
  },
);

nodeTest(
  "native documentation and app state reach the caller with action outcomes intact",
  async () => {
    const f = fixture();
    /** @type {import("../../lib/macuse-session.mjs").Content[]} */
    const content = [
      {
        type: "text",
        text: `Native Computer Use documentation\n${"documentation text ".repeat(1600)}`,
      },
      { type: "text", text: "Window: Settings\n0 search text field Search" },
      { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
    ];
    const actions = Array.from({ length: 21 }, (_, index) => ({
      id: index + 1,
      method: "click",
      app: "Test",
      dispatched: true,
      outcome: index === 20 ? "unknown" : "completed",
      verification: index === 20 ? "none" : "native-returned",
    }));
    f.runtime.execute = async () => ({
      content: [...content],
      isError: true,
      details: { macuse: { status: "unknown", actions } },
    });
    const response = await f.session.callTool("macuse", { code: "observe", trackFocus: false });
    const firstText = textOf(response.content[0]);
    assert.equal(firstText.length, textOf(content[0]).length);
    assert.equal(firstText, textOf(content[0]));
    assert.deepEqual(response.content.slice(1, 3), content.slice(1));
    /** @type {unknown} */
    const parsed = JSON.parse(textOf(response.content.at(-2)));
    assert.deepEqual(isRecord(parsed) ? parsed.actions : undefined, actions);
    assert.match(textOf(response.content.at(-1)), /never automatically replay/);
  },
);

nodeTest(
  "screenshot export preserves the literal requested path and refuses overwrite",
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "macuse-image-test-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const f = fixture();
    f.session.cwd = dir;
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    f.runtime.execute = async () => ({
      ...result(),
      content: [{ type: "image", mimeType: "image/jpeg", data: bytes.toString("base64") }],
    });
    const saved = await f.session.callTool("macuse", {
      code: "screenshot",
      saveImagePath: "@capture.jpg",
      trackFocus: false,
    });
    assert.equal(saved.isError, false);
    const savedImage = saved.details.macuse.savedImage;
    if (!isRecord(savedImage)) {
      assert.fail("missing saved image record");
    }
    assert.equal(savedImage.path, join(dir, "@capture.jpg"));
    assert.deepEqual(await readFile(join(dir, "@capture.jpg")), bytes);
    const exists = await f.session.callTool("macuse", {
      code: "screenshot",
      saveImagePath: "@capture.jpg",
      trackFocus: false,
    });
    assert.equal(exists.isError, true);
    assert.match(exists.content.map((p) => (p.type === "text" ? p.text : "")).join("\n"), /EEXIST/);
    assert.deepEqual(await readFile(join(dir, "@capture.jpg")), bytes);
  },
);

nodeTest(
  "selected insertion owns the same queue as code and invalidates its prior observation",
  async () => {
    const f = fixture();
    /** @type {PromiseWithResolvers<void>} */
    const editing = Promise.withResolvers();
    /** @type {PromiseWithResolvers<void>} */
    const edited = Promise.withResolvers();
    f.native.replaceSelectedText = async () => {
      editing.resolve();
      await edited.promise;
      return {
        status: "applied",
        mutationAttempted: true,
        verified: true,
        insertedUTF16Length: 4,
        replacedUTF16Length: 0,
      };
    };
    const edit = f.session.callTool("macuse_insert_text", {
      app: "Test",
      text: "café",
      allowMutating: true,
      safetyNote: "Only replace the fixture selection; no other effects.",
    });
    await editing.promise;
    const next = f.session.callTool("macuse", { code: "42", trackFocus: false });
    await Promise.resolve();
    assert.deepEqual(f.events, ["code", "invalidate:Test"]);
    edited.resolve();
    assert.equal((await edit).details.macuse.outcome, "verified");
    await next;
    assert.deepEqual(f.events, ["code", "invalidate:Test", "code"]);
    await f.session.stop();
  },
);

nodeTest(
  "insertion refresh rejects a reused record and cannot authorize a later insertion",
  async () => {
    const f = fixture();
    /** @param {string} record */
    const snapshot = (record) =>
      parseAppState(
        "Test",
        `Window: "Fixture", App: Test.
0 standard window Fixture
	1 cell Value: ${record}
		2 text field ID: editor, Value: old
The focused UI element is 2 text field`,
      );
    f.runtime.observation = snapshot("draft.txt");
    f.runtime.execute = async (input) => {
      assert.equal(isRecord(input) ? input.code : undefined, 'await cua.getApp("Test")');
      f.events.push("refresh");
      f.runtime.observation = snapshot("important.txt");
      return { ...result(), details: { macuse: { observations: [f.runtime.observation] } } };
    };
    f.native.replaceSelectedText = async () => assert.fail("must not dispatch");
    const input = {
      app: "Test",
      text: "replacement",
      allowMutating: true,
      safetyNote: "Replace only the draft.txt record selection.",
    };
    const first = await f.session.callTool("macuse_insert_text", input);
    assert.equal(first.details.macuse.dispatched, false);
    assert.match(textOf(first.content[0]), /Focused field changed/);
    assert.equal(f.runtime.getObservation("Test"), undefined);
    const second = await f.session.callTool("macuse_insert_text", input);
    assert.match(textOf(second.content[0]), /Observe the intended app/);
    assert.deepEqual(f.events, ["refresh", "invalidate:Test"]);
  },
);

nodeTest(
  "insertion refresh retains native focus joining for snapshots without a Sky focused marker",
  async () => {
    const f = fixture();
    f.runtime.execute = async () => {
      const { focused: _omitted, ...rest } = observed;
      f.runtime.observation = { ...rest, observedAt: Date.now() };
      const refreshed = f.runtime.observation;
      return {
        ...result(),
        details: { macuse: { observations: [refreshed] } },
      };
    };
    const response = await f.session.callTool("macuse_insert_text", {
      app: "Test",
      text: "café",
      allowMutating: true,
      safetyNote: "Only replace the fixture selection; no other effects.",
    });
    assert.equal(response.details.macuse.outcome, "verified");
    assert.equal(f.runtime.getObservation("Test"), undefined);
  },
);

nodeTest(
  "an interrupted insertion refresh preserves reset evidence and cancels queued code",
  async () => {
    const f = fixture();
    /** @type {PromiseWithResolvers<void>} */
    const started = Promise.withResolvers();
    /** @type {PromiseWithResolvers<void>} */
    const finish = Promise.withResolvers();
    f.runtime.execute = async () => {
      f.events.push("refresh");
      started.resolve();
      await finish.promise;
      return {
        content: [{ type: "text", text: "Snapshot timed out." }],
        isError: true,
        details: { macuse: { status: "unknown", kernelReset: true, interruption: "timeout" } },
      };
    };
    f.native.replaceSelectedText = async () => assert.fail("must not dispatch");
    const insertion = f.session.callTool("macuse_insert_text", {
      app: "Test",
      text: "café",
      allowMutating: true,
      safetyNote: "Only replace the fixture selection; no other effects.",
    });
    await started.promise;
    const queued = f.session.callTool("macuse", { code: "must-not-run", trackFocus: false });
    finish.resolve();
    const response = await insertion;
    assert.equal(response.isError, true);
    assert.equal(response.details.macuse.dispatched, false);
    assert.equal(response.details.macuse.kernelReset, true);
    assert.equal(response.details.macuse.interruption, "timeout");
    const refresh = response.details.macuse.refresh;
    if (!isRecord(refresh)) {
      assert.fail("missing refresh record");
    }
    assert.equal(refresh.status, "unknown");
    assert.match(textOf(response.content[0]), /Snapshot timed out/);
    assert.match(textOf((await queued).content[0]), /Cancelled before dispatch/);
    assert.deepEqual(f.events, ["refresh", "invalidate:Test"]);
  },
);

nodeTest(
  "stale or failed insertion snapshots never reuse the prior cached observation",
  async () => {
    for (const failed of [false, true]) {
      const f = fixture();
      f.runtime.execute = async () => ({ ...result(), isError: failed });
      f.native.replaceSelectedText = async () => assert.fail("must not dispatch");
      const response = await f.session.callTool("macuse_insert_text", {
        app: "Test",
        text: "café",
        allowMutating: true,
        safetyNote: "Only replace the fixture selection; no other effects.",
      });
      assert.equal(response.isError, true);
      assert.equal(response.details.macuse.dispatched, false);
      assert.match(textOf(response.content[0]), failed ? /Observed/ : /fresh full app snapshot/);
      assert.equal(f.runtime.getObservation("Test"), undefined);
    }
  },
);

nodeTest(
  "reset aborts the active call, drains it, cancels queued calls, and never replays",
  async () => {
    const f = fixture();
    /** @type {PromiseWithResolvers<void>} */
    const started = Promise.withResolvers();
    /** @type {PromiseWithResolvers<void>} */
    const settled = Promise.withResolvers();
    f.runtime.execute = async (_input, options) => {
      const signal = options?.signal;
      if (signal === undefined) {
        assert.fail("missing abort signal");
      }
      started.resolve();
      await new Promise((resolve) => {
        signal.addEventListener("abort", resolve, { once: true });
      });
      await settled.promise;
      f.events.push("aborted-code-settled");
      return { ...result(), isError: true };
    };
    const first = f.session.callTool("macuse", { code: "held", trackFocus: false });
    await started.promise;
    const queued = f.session.callTool("macuse", { code: "must-not-run", trackFocus: false });
    const reset = f.session.reset();
    await Promise.resolve();
    assert.deepEqual(f.events, []);
    settled.resolve();
    assert.equal((await first).details.macuse.isError, true);
    assert.equal((await queued).details.macuse.dispatched, false);
    await reset;
    assert.deepEqual(f.events, ["aborted-code-settled", "reset"]);
    await f.session.stop();
  },
);

nodeTest("new calls wait through an in-progress kernel reset", async () => {
  const f = fixture();
  /** @type {PromiseWithResolvers<void>} */
  const started = Promise.withResolvers();
  /** @type {PromiseWithResolvers<void>} */
  const finished = Promise.withResolvers();
  f.runtime.reset = async () => {
    started.resolve();
    await finished.promise;
    f.events.push("reset");
  };
  const reset = f.session.reset();
  await started.promise;
  const next = f.session.callTool("macuse", { code: "after-reset", trackFocus: false });
  await Promise.resolve();
  assert.deepEqual(f.events, []);
  finished.resolve();
  await Promise.all([reset, next]);
  assert.deepEqual(f.events, ["reset", "code"]);
  await f.session.stop();
});

for (const interruption of ["abort", "timeout", "reset"]) {
  nodeTest(`${interruption} cancels pending session calls while allowing fresh work`, async (t) => {
    const f = fixture();
    /** @type {PromiseWithResolvers<void>} */
    const started = Promise.withResolvers();
    /** @type {PromiseWithResolvers<{ content: Array<{ type: "text"; text: string }>; isError: boolean }>} */
    const held = Promise.withResolvers();
    /** @type {unknown[]} */
    const calls = [];
    f.session.runtime = new CuaRuntime({
      connect: async () => ({
        callTool: async (
          /** @type {{ name: string; arguments: Record<string, unknown>; _meta?: { macuse?: { runId?: unknown } } | undefined }} */ request,
        ) => {
          if (request.name === "js_reset") {
            held.resolve({ content: [], isError: true });
            return { content: [] };
          }
          const code = request.arguments.code;
          calls.push(code);
          if (code === "held") {
            started.resolve();
            return held.promise;
          }
          const meta = request._meta;
          const runId =
            meta !== undefined && meta.macuse !== undefined ? meta.macuse.runId : undefined;
          return {
            content: [],
            _meta: { macuse: { runId, actions: [], observations: [] } },
          };
        },
        close: () => Promise.resolve(),
      }),
    });
    t.after(() => f.session.stop());
    /**
     * @param {string} code
     * @param {{ signal?: AbortSignal | undefined; timeoutMs?: number }} [options]
     */
    const call = (code, options) =>
      f.session.callTool("macuse", { code, trackFocus: false, timeoutMs: 1000 }, options);
    const controller = new AbortController();
    const first = call("held", { signal: controller.signal });
    await started.promise;
    const queued = call("must-not-run");
    let reset, duringReset;
    if (interruption === "abort") {
      controller.abort();
    }
    if (interruption === "reset") {
      reset = f.session.reset();
      duringReset = call("during-reset");
    }
    const interrupted = await first;
    assert.equal(interrupted.isError, true);
    assert.equal(interrupted.details.macuse.kernelReset, true);
    assert.equal((await queued).details.macuse.dispatched, false);
    assert.equal(calls.includes("must-not-run"), false);
    await reset;
    if (duringReset) {
      assert.equal((await duringReset).isError, false);
    }
    assert.equal((await call("fresh")).isError, false);
    assert.deepEqual(
      calls,
      interruption === "reset" ? ["held", "during-reset", "fresh"] : ["held", "fresh"],
    );
  });
}

nodeTest(
  "missing native focus coverage remains explicit without blocking a read-only result",
  async () => {
    const f = fixture();
    f.native.beginObservation = async () => {
      throw new Error("Compiler unavailable");
    };
    const response = await f.session.callTool("macuse", { code: "42" });
    assert.equal(response.isError, false);
    const focus = response.details.macuse.focus;
    if (!isRecord(focus)) {
      assert.fail("missing focus record");
    }
    assert.equal(focus.observationAvailable, false);
    assert.match(textOf(response.content.at(-1)), /Compiler unavailable/);
    assert.equal(focus.isolationGuaranteed, false);
  },
);

/**
 * @param {string} mode
 * @returns {string | undefined}
 */
const originalTab = (mode) => {
  if (mode === "unknown") {
    return;
  }
  if (mode === "initial-memory") {
    return "Memory";
  }
  return "Disk";
};

for (const mode of [
  "initial-disk",
  "initial-memory",
  "unknown",
  "failed-action",
  "missing-coverage",
  "activation",
]) {
  nodeTest(`Activity Monitor validation cleanup: ${mode}`, async () => {
    const original = originalTab(mode);
    let current = original,
      mutations = 0;
    const tabs = () =>
      ["CPU", "Memory", "Disk"].map((name, index) => ({
        index: String(index),
        name,
        description: name,
        role: "radio button",
        secondaryActions: ["Press"],
        value: current === name ? "1" : "0",
      }));
    const activityFixture = {
      runtime: { getObservation: () => ({ elements: tabs() }) },
      callTool: async (
        /** @type {string} */ _tool,
        /** @type {Record<string, unknown>} */ input,
      ) => {
        const code = typeof input.code === "string" ? input.code : "";
        const action = code.match(/performSecondaryAction\((\d+)/);
        if (action) {
          const selected = tabs()[Number(action[1] ?? 0)];
          if (selected !== undefined) {
            current = selected.name;
          }
          mutations++;
        }
        const changed = mutations === 1 && action !== null;
        return {
          ...result(),
          isError: mode === "failed-action" && changed,
          details: {
            macuse: {
              focus: {
                observationAvailable: mode !== "missing-coverage",
                coverage: { applicationActivation: true, truncated: false },
                before: { frontmost: { bundleId: "user.editor" } },
                after: { frontmost: { bundleId: "user.editor" } },
                transitions:
                  mode === "activation" && changed
                    ? [{ kind: "activation", app: { bundleId: "com.apple.ActivityMonitor" } }]
                    : [],
              },
            },
          },
        };
      },
    };
    const run = activityMonitorCheck(activityFixture, { strictFocus: true });
    if (["initial-disk", "initial-memory"].includes(mode)) {
      assert.equal((await run).restored, true);
    } else {
      await assert.rejects(run);
    }
    assert.equal(current, original);
    assert.equal(mutations, ["unknown", "missing-coverage"].includes(mode) ? 0 : 2);
  });
}
