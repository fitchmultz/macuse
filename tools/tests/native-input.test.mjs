import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough, Writable } from "node:stream";
import { setImmediate as nextTurn } from "node:timers/promises";
import nodeTest from "node:test";
import { insertText as insertTextWithRefresh } from "../../lib/native-input.mjs";
import { parseAppState } from "../../lib/app-state.mjs";
import { MacOSNative } from "../macos-native.mjs";

/** @typedef {import("../macos-native.mjs").NativeApplication} NativeApplication */
/** @typedef {import("../macos-native.mjs").NativeAppState} NativeAppState */
/** @typedef {import("../macos-native.mjs").NativeObservation} NativeObservation */
/** @typedef {import("../macos-native.mjs").NativeTextResult} NativeTextResult */
/** @typedef {import("../../lib/app-state.mjs").AppObservation} AppObservation */
/** @typedef {import("../../lib/app-state.mjs").AppElement} AppElement */
/** @typedef {import("../../lib/native-input.mjs").InsertTextResult} InsertTextResult */
/** @typedef {import("../../lib/native-input.mjs").NativeTextBackend} NativeTextBackend */
/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
/** @type {NativeApplication} */
const app = {
  pid: 4242,
  name: "TextEdit",
  bundleId: "com.apple.TextEdit",
  path: "/System/Applications/TextEdit.app",
};
const bundleId = app.bundleId;
if (bundleId === null) {
  assert.fail("Fixture app requires a bundle id");
}
const appPath = app.path;
if (appPath === null) {
  assert.fail("Fixture app requires a path");
}
/** @typedef {import("../../lib/native-input.mjs").InsertTextInput} InsertTextInput */
/** @type {InsertTextInput} */
const input = {
  app: bundleId,
  text: "café 漢字 🙂 e\u0301",
  allowMutating: true,
  safetyNote: "Replace the selection in the disposable TextEdit fixture only; do not save or send.",
};
// The display name intentionally equals the AX identifier: CUA names fall
// back to the ID, which keeps native-input's cross-source join inactive.
/** @type {AppElement} */
const focusedField = {
  index: "2",
  id: "First Text View",
  role: "text entry area",
  name: "First Text View",
  value: "prefix ORIGINAL suffix\n",
  disabled: false,
  settable: true,
  secondaryActions: [],
  line: "",
  context: "",
  cellValueContext: "",
  descendants: "",
};
/** @type {AppObservation} */
const observation = {
  app: bundleId,
  title: "Fixture.txt",
  url: "file:///tmp/Fixture.txt",
  documentIdentity: null,
  nativeWindowIdentity: true,
  text: "full CUA observation",
  observedAt: Date.now(),
  elements: [focusedField],
  focused: focusedField,
};
/** @typedef {import("../macos-native.mjs").NativeWindow} NativeWindow */
/** @type {NativeWindow} */
const fixtureWindow = {
  token: "window",
  title: "Fixture.txt",
  document: "file:///tmp/Fixture.txt",
};
const fixtureId = focusedField.id;
if (fixtureId === undefined) {
  assert.fail("Fixture field requires an id");
}
/**
 * Full focused-field literal with a synthesized display name; avoids
 * optional-prop spreads that exactOptionalPropertyTypes rejects.
 * @param {string} name
 * @param {string} [index]
 * @returns {AppElement}
 */
const namedField = (name, index = "2") => ({
  index,
  id: fixtureId,
  role: "text entry area",
  name,
  value: "prefix ORIGINAL suffix\n",
  disabled: false,
  settable: true,
  secondaryActions: [],
  line: "",
  context: "",
  cellValueContext: "",
  descendants: "",
});
/** @typedef {NonNullable<NativeAppState["focusedElement"]>} NativeFocusedElement */
/** @type {NativeFocusedElement} */
const fixtureField = {
  token: "field",
  role: "AXTextArea",
  roleDescription: "text entry area",
  identifier: "First Text View",
  title: null,
  description: null,
  value: "prefix ORIGINAL suffix\n",
  selectedTextSettable: true,
  selectedTextError: 0,
};
/** @type {NativeAppState} */
const state = {
  pid: app.pid,
  app,
  accessibilityTrusted: true,
  windowsCount: 1,
  windowsError: 0,
  windows: [],
  focusedWindow: fixtureWindow,
  focusedElement: fixtureField,
};
/** @type {NativeObservation} */
const focus = {
  before: { frontmost: null, focusedWindow: null },
  after: { frontmost: null, focusedWindow: null },
  transitions: [],
  coverage: {
    applicationActivation: true,
    focusedWindow: {},
    inputAttribution: false,
    windowDetails: "targetAppsOnly",
    truncated: false,
  },
};
/** @type {NativeTextResult} */
const applied = {
  status: "applied",
  mutationAttempted: true,
  verified: true,
  insertedUTF16Length: input.text.length,
  replacedUTF16Length: 8,
};
/** @typedef {{ name: string, args: unknown[] }} RecordedCall */
/** @typedef {{ calls: RecordedCall[], native: NativeTextBackend }} Fixture */
/**
 * @param {Partial<NativeTextBackend>} [overrides]
 * @returns {Fixture}
 */
function fixture(overrides = {}) {
  /** @type {RecordedCall[]} */
  const calls = [];
  /** @type {NativeTextBackend} */
  const native = {
    resolveApp: async (identifier, options) => {
      calls.push({ name: "resolveApp", args: [identifier, options] });
      if (overrides.resolveApp !== undefined) {
        return overrides.resolveApp(identifier, options);
      }
      return app;
    },
    inspectApp: async (pid, options) => {
      calls.push({ name: "inspectApp", args: [pid, options] });
      if (overrides.inspectApp !== undefined) {
        return overrides.inspectApp(pid, options);
      }
      return structuredClone(state);
    },
    beginObservation: async (pids, options) => {
      calls.push({ name: "beginObservation", args: [pids, options] });
      if (overrides.beginObservation !== undefined) {
        return overrides.beginObservation(pids, options);
      }
      return { id: "watch" };
    },
    endObservation: async (id, options) => {
      calls.push({ name: "endObservation", args: [id, options] });
      if (overrides.endObservation !== undefined) {
        return overrides.endObservation(id, options);
      }
      return focus;
    },
    replaceSelectedText: async (request, options) => {
      calls.push({ name: "replaceSelectedText", args: [request, options] });
      if (overrides.replaceSelectedText !== undefined) {
        return overrides.replaceSelectedText(request, options);
      }
      return applied;
    },
    stop: async () => {
      calls.push({ name: "stop", args: [] });
      if (overrides.stop !== undefined) {
        return overrides.stop();
      }
    },
  };
  return { calls, native };
}
/**
 * @param {NativeTextBackend} native
 * @param {import("../../lib/native-input.mjs").InsertTextInput} textInput
 * @param {AppObservation | undefined} observed
 * @param {{ signal?: AbortSignal, refreshObservation?: () => Promise<AppObservation | undefined> }} [options]
 * @returns {Promise<InsertTextResult>}
 */
const insertText = (native, textInput, observed, options = {}) =>
  insertTextWithRefresh(native, textInput, observed, {
    refreshObservation: options.refreshObservation ?? (async () => structuredClone(observed)),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });
/**
 * @param {InsertTextResult} result
 * @param {Fixture} f
 * @param {RegExp} pattern
 */
function noEdit(result, f, pattern) {
  assert.equal(result.isError, true);
  assert.equal(result.details.macuse.dispatched, false);
  assert.equal(result.details.macuse.outcome, "not_dispatched");
  const firstBlock = result.content[0];
  if (firstBlock === undefined) {
    assert.fail("result text missing");
  }
  assert.match(firstBlock.text, pattern);
  assert.equal(
    f.calls.some((call) => call.name === "replaceSelectedText"),
    false,
  );
}

nodeTest(
  "a reused editor cannot insert into a changed record despite unchanged native identity and value",
  async () => {
    /**
     * @param {string} record
     * @returns {AppObservation}
     */
    const snapshot = (record) =>
      parseAppState(
        bundleId,
        `Window: "Fixture.txt", App: TextEdit.
0 standard window Fixture.txt, URL: file:///tmp/Fixture.txt
	1 cell Value: ${record}
		2 text entry area ID: First Text View, Value: prefix ORIGINAL suffix

The focused UI element is 2 text entry area`,
      );
    const before = snapshot("draft.txt");
    const fresh = snapshot("important.txt");
    const beforeFocused = before.focused;
    if (beforeFocused === undefined) {
      assert.fail("snapshot focused field missing");
    }
    const freshFocused = fresh.focused;
    if (freshFocused === undefined) {
      assert.fail("fresh snapshot focused field missing");
    }
    const stateField = state.focusedElement;
    if (stateField === null) {
      assert.fail("fixture native field missing");
    }
    assert.equal(beforeFocused.value, stateField.value);
    assert.equal(beforeFocused.context, freshFocused.context);
    assert.notEqual(beforeFocused.cellValueContext, freshFocused.cellValueContext);
    const f = fixture();
    noEdit(
      await insertText(f.native, input, before, { refreshObservation: async () => fresh }),
      f,
      /Focused field changed/,
    );
    const reindexed = parseAppState(
      bundleId,
      before.text.replaceAll("2 text entry area", "9 text entry area"),
    );
    assert.equal(
      (
        await insertText(fixture().native, input, before, {
          refreshObservation: async () => reindexed,
        })
      ).isError,
      false,
    );
  },
);

nodeTest(
  "selected-range insertion preserves exact Unicode, document tokens, field value and honest focus coverage",
  async () => {
    const f = fixture();
    const result = await insertText(f.native, input, observation);
    assert.equal(result.isError, false);
    assert.equal(result.details.macuse.outcome, "verified");
    assert.equal(result.details.macuse.dispatched, true);
    assert.equal(result.details.macuse.replacedUTF16Length, 8);
    assert.equal(result.details.macuse.insertedUTF16Length, input.text.length);
    const focusRecord = result.details.macuse.focus;
    assert.equal(focusRecord?.observationAvailable, true, "focus observation missing");
    const editCall = f.calls.find((call) => call.name === "replaceSelectedText");
    if (editCall === undefined) {
      assert.fail("replaceSelectedText call missing");
    }
    assert.deepEqual(editCall.args[0], {
      pid: app.pid,
      text: input.text,
      expected: {
        windowToken: "window",
        windowTitle: observation.title,
        document: observation.url,
        elementToken: "field",
        value: focusedField.value,
      },
    });
    assert.deepEqual(
      f.calls.map((call) => call.name),
      ["resolveApp", "beginObservation", "inspectApp", "replaceSelectedText", "endObservation"],
    );
  },
);

nodeTest(
  "missing observation, permission flags and malformed Unicode fail before native access",
  async () => {
    /** @type {[InsertTextInput, AppObservation | undefined, RegExp][]} */
    const cases = [
      [input, undefined, /Observe the intended app/],
      [{ ...input, allowMutating: false }, observation, /allowMutating:true/],
      [{ ...input, safetyNote: " \n " }, observation, /nonempty safetyNote/],
      [{ ...input, text: "bad\ud800" }, observation, /well-formed Unicode/],
      [{ ...input, text: "bad\udfff" }, observation, /well-formed Unicode/],
      [
        // Deliberately invalid runtime input: the guard must reject a non-string
        // expectedTitle; the type system cannot express this invalid entry.
        // oxlint-disable-next-line no-unsafe-type-assertion -- QX-006: Test intentionally passes invalid input.
        /** @type {InsertTextInput} */ (/** @type {unknown} */ ({ ...input, expectedTitle: 123 })),
        observation,
        /exact string/,
      ],
    ];
    for (const [candidate, observed, pattern] of cases) {
      const f = fixture();
      noEdit(await insertText(f.native, candidate, observed), f, pattern);
      assert.equal(f.calls.length, 0);
    }
  },
);

nodeTest("selected-text insertion accepts a short nonempty mutation note", async () => {
  const result = await insertText(
    fixture().native,
    { ...input, safetyNote: "Fixture only." },
    observation,
  );
  assert.equal(result.isError, false);
  assert.equal(result.details.macuse.outcome, "verified");
});

nodeTest(
  "no prior focused field refuses before native access rather than editing the current field",
  async () => {
    const f = fixture();
    const { focused: _omitted, ...withoutFocused } = observation;
    noEdit(
      await insertText(f.native, input, withoutFocused),
      f,
      /did not identify a focused field.*getAXState/,
    );
    assert.equal(f.calls.length, 0);
  },
);

nodeTest(
  "CUA display names synthesized from ID/role do not masquerade as native field labels",
  async () => {
    for (const name of [fixtureId, focusedField.role]) {
      const focused = namedField(name);
      const result = await insertText(fixture().native, input, {
        ...observation,
        focused,
        elements: [focused],
      });
      assert.equal(result.isError, false);
    }
    const f = fixture({
      inspectApp: async () => ({
        ...state,
        focusedElement: {
          ...fixtureField,
          role: "AXTextField",
          roleDescription: "search text field",
        },
      }),
    });
    const focused = { ...focusedField, role: "search" };
    assert.equal(
      (await insertText(f.native, input, { ...observation, focused, elements: [focused] })).isError,
      false,
    );
  },
);

nodeTest(
  "indistinguishable fields and duplicate stable IDs cannot authorize an insertion",
  async () => {
    /**
     * @param {string} index
     * @returns {AppElement}
     */
    const indistinguishable = (index) => ({
      index,
      id: fixtureId,
      role: "text field",
      name: "text field",
      value: "same",
      disabled: false,
      settable: true,
      secondaryActions: [],
      line: "",
      context: "",
      cellValueContext: "",
      descendants: "",
    });
    const focused = indistinguishable("1");
    for (const observed of [
      { ...observation, focused, elements: [focused, indistinguishable("2")] },
      { ...observation, elements: [focusedField, namedField(focusedField.name)] },
    ]) {
      const f = fixture({
        inspectApp: async () => ({
          ...state,
          focusedElement: {
            ...fixtureField,
            identifier: null,
            roleDescription: "text field",
            value: "same",
          },
        }),
      });
      const result = await insertText(f.native, input, observed);
      noEdit(result, f, /unique cross-source identity/);
      assert.deepEqual(result.details.macuse.target, app);
    }
  },
);

nodeTest(
  "missing/ambiguous running-app resolution and another app's observation never dispatch",
  async () => {
    for (const reason of [
      "No running app exactly matches TextEdit",
      "Ambiguous running app TextEdit",
    ]) {
      const f = fixture({
        resolveApp: async () => {
          throw new Error(reason);
        },
      });
      noEdit(await insertText(f.native, input, observation), f, new RegExp(reason));
      assert.deepEqual(
        f.calls.map((call) => call.name),
        ["resolveApp"],
      );
    }
    const f = fixture();
    noEdit(
      await insertText(f.native, input, { ...observation, app: "textedit" }),
      f,
      /another app/,
    );
    assert.deepEqual(
      f.calls.map((call) => call.name),
      ["resolveApp"],
    );
  },
);

nodeTest("exact resolved name/path observations are accepted, never fuzzy aliases", async () => {
  for (const identity of [app.name, appPath]) {
    const f = fixture();
    assert.equal(
      (await insertText(f.native, input, { ...observation, app: identity })).isError,
      false,
    );
  }
});

nodeTest(
  "changed document, explicit guards, app identity and focused field refuse before dispatch",
  async () => {
    /**
     * @param {Partial<NativeFocusedElement>} field
     * @returns {[NativeAppState, InsertTextInput, RegExp]}
     */
    const changedFieldCase = (field) => [
      { ...state, focusedElement: { ...fixtureField, ...field } },
      input,
      /focused field or its value changed/,
    ];
    /** @type {[NativeAppState, InsertTextInput, RegExp][]} */
    const cases = [
      [
        { ...state, focusedWindow: { ...fixtureWindow, document: "file:///tmp/Other.txt" } },
        input,
        /window\/document changed/,
      ],
      [state, { ...input, expectedTitle: "Other.txt" }, /Window guard failed/],
      [state, { ...input, expectedUrl: "file:///tmp/Other.txt" }, /Document guard failed/],
      [{ ...state, app: { ...app, path: "/Other.app" } }, input, /app identity changed/],
      ...[
        { identifier: "Other field" },
        { roleDescription: "text field" },
        { value: "human edited the field" },
      ].map(changedFieldCase),
    ];
    for (const [changed, candidate, pattern] of cases) {
      const f = fixture({ inspectApp: async () => changed });
      noEdit(await insertText(f.native, candidate, observation), f, pattern);
    }
    const f = fixture();
    noEdit(
      await insertText(f.native, input, {
        ...observation,
        focused: namedField("Other field"),
      }),
      f,
      /focused field/i,
    );
  },
);

nodeTest(
  "document URL wins over abbreviated titles, but explicit title guards remain exact",
  async () => {
    const abbreviated = { ...observation, title: "Fi…" };
    assert.equal((await insertText(fixture().native, input, abbreviated)).isError, false);
    const f = fixture();
    noEdit(
      await insertText(f.native, { ...input, expectedTitle: "Fi…" }, abbreviated),
      f,
      /Window guard failed/,
    );
    const missingUrl = fixture({
      inspectApp: async () => ({
        ...state,
        focusedWindow: { ...fixtureWindow, document: null },
      }),
    });
    noEdit(
      await insertText(missingUrl.native, input, observation),
      missingUrl,
      /window\/document changed/,
    );
    const untitled = { ...observation, url: null };
    const other = fixture({
      inspectApp: async () => ({
        ...state,
        focusedWindow: { ...fixtureWindow, title: "Other.txt", document: null },
      }),
    });
    noEdit(await insertText(other.native, input, untitled), other, /window\/document changed/);
  },
);

nodeTest("selected-text insertion survives a native window title update", async () => {
  /**
   * @param {string} title
   * @returns {AppObservation}
   */
  const snapshot = (title) =>
    parseAppState(
      bundleId,
      `Window: "${title}", App: TextEdit.
0 standard window ${title}
	1 HTML content Description: Text fixture, URL: 127.0.0.1:52513/top
		2 text field (settable) Message, Value: before after
		3 HTML content Description: Frame, URL: 127.0.0.1:52513/frame

The focused UI element is 2 text field (settable) Message, Value: before after`,
    );
  const before = snapshot("Job 10%");
  const fresh = snapshot("Job 11%");
  const current = {
    ...state,
    focusedWindow: { token: "window", title: fresh.title, document: null },
    focusedElement: {
      ...fixtureField,
      identifier: null,
      role: "AXTextField",
      roleDescription: "text field",
      title: "Message",
      description: "Message",
      value: "before after",
    },
  };
  const refreshObservation = async () => fresh;
  const f = fixture({ inspectApp: async () => current });
  assert.equal(
    (await insertText(f.native, input, before, { refreshObservation })).details.macuse.outcome,
    "verified",
  );

  const changed = fixture({
    inspectApp: async () => ({
      ...current,
      focusedWindow: { ...current.focusedWindow, title: "Other" },
    }),
  });
  noEdit(
    await insertText(changed.native, input, before, { refreshObservation }),
    changed,
    /window\/document changed/,
  );
  const beforeTitle = before.title;
  if (beforeTitle === null) {
    assert.fail("Snapshot title missing");
  }
  const exactTitle = fixture({ inspectApp: async () => current });
  noEdit(
    await insertText(exactTitle.native, { ...input, expectedTitle: beforeTitle }, before, {
      refreshObservation,
    }),
    exactTitle,
    /Window guard failed/,
  );
});

nodeTest(
  "page labels and nonstandard roots cannot authorize insertion through a coincident native window title",
  async () => {
    for (const root of [
      "window Secondary Actions: Raise\n\t1 HTML content chrome-extension://fixture.invalid/popup.html",
      "standard window Secondary Actions: Raise\n\t1 HTML content chrome-extension://fixture.invalid/popup.html",
      "sheet Fixture.txt",
      "sheet ID: GoToWindow, Secondary Actions: Raise",
      "window Fixture.txt",
    ]) {
      const observed = parseAppState(
        bundleId,
        `Window: "", App: TextEdit.\n0 ${root}\n\t2 text entry area ID: First Text View, Value: prefix ORIGINAL suffix\n\nThe focused UI element is 2 text entry area`,
      );
      const f = fixture({
        inspectApp: async () => ({
          ...state,
          focusedWindow: { ...fixtureWindow, title: observed.title, document: observed.url },
        }),
      });
      noEdit(
        await insertText(f.native, input, observed),
        f,
        /window\/document.*observation|native window identity/i,
      );
    }
  },
);

nodeTest(
  "unsupported fields and unavailable Accessibility/compiler keep actionable reasons",
  async () => {
    /** @typedef {import("../../lib/native-input.mjs").NativeTextBackend["inspectApp"]} InspectApp */
    /** @type {[InspectApp, RegExp][]} */
    const cases = [
      [async () => ({ ...state, accessibilityTrusted: false }), /System Settings.*Accessibility/],
      [
        async () => ({
          ...state,
          focusedElement: {
            ...fixtureField,
            selectedTextSettable: false,
            selectedTextError: -25205,
          },
        }),
        /AXSelectedText unsupported/,
      ],
      [
        async () => {
          throw new Error("Native helper compilation failed: swiftc unavailable");
        },
        /compilation failed.*swiftc unavailable/,
      ],
    ];
    for (const [inspectApp, pattern] of cases) {
      const f = fixture({ inspectApp });
      noEdit(await insertText(f.native, input, observation), f, pattern);
    }
  },
);

nodeTest(
  "Swift preflight refusal is not dispatched; attempted but unverified write is unknown with no replay",
  async () => {
    /** @typedef {Extract<NativeTextResult, { status: "unsupported" | "guard_failed" | "unverified" }>} RefusedEdit */
    /** @type {RefusedEdit[]} */
    const edits = [
      { status: "unsupported", mutationAttempted: false, reason: "AXSelectedText is not settable" },
      { status: "guard_failed", mutationAttempted: false, reason: "Selection changed" },
      {
        status: "unverified",
        mutationAttempted: true,
        reason: "Exact text readback did not match; do not replay",
      },
    ];
    for (const edit of edits) {
      const f = fixture({ replaceSelectedText: async () => edit });
      const result = await insertText(f.native, input, observation);
      assert.equal(result.isError, true);
      assert.equal(result.details.macuse.dispatched, edit.mutationAttempted);
      assert.equal(
        result.details.macuse.outcome,
        edit.mutationAttempted ? "unknown" : "not_dispatched",
      );
      const firstBlock = result.content[0];
      if (firstBlock === undefined) {
        assert.fail("result text missing");
      }
      assert.match(firstBlock.text, new RegExp(edit.reason));
      assert.equal(f.calls.filter((call) => call.name === "replaceSelectedText").length, 1);
      assert.equal(
        f.calls.some((call) => call.name === "stop"),
        false,
      );
    }
  },
);

nodeTest(
  "a rejected edit waits for native stop and never replays or promises GUI cancellation",
  async () => {
    /** @type {(() => void) | undefined} */
    let release;
    /** @type {Promise<void>} */
    const stopped = new Promise((resolve) => {
      release = resolve;
    });
    const f = fixture({
      replaceSelectedText: async () => {
        throw new Error("Native replaceSelectedText timed out");
      },
      stop: () => stopped,
    });
    let settled = false;
    const pending = insertText(f.native, input, observation).then((result) => {
      settled = true;
      return result;
    });
    await nextTurn();
    assert.equal(settled, false);
    const stopCall = f.calls.at(-1);
    if (stopCall === undefined) {
      assert.fail("stop call missing");
    }
    assert.equal(stopCall.name, "stop");
    release?.();
    const result = await pending;
    assert.equal(result.details.macuse.outcome, "unknown");
    assert.equal(result.details.macuse.dispatched, true);
    const resultText = result.content[0];
    if (resultText === undefined) {
      assert.fail("result text missing");
    }
    assert.match(resultText.text, /Do not replay/);
    assert.doesNotMatch(resultText.text, /cancelled|canceled/);
    assert.equal(f.calls.filter((call) => call.name === "replaceSelectedText").length, 1);
    assert.equal(
      f.calls.some((call) => call.name === "endObservation"),
      false,
    );
  },
);

nodeTest(
  "pre-dispatch abort and native dispatch:false errors do not claim an attempted edit",
  async () => {
    for (const reason of [undefined, null, "User stopped the operation"]) {
      const f = fixture();
      noEdit(
        await insertText(f.native, input, observation, { signal: AbortSignal.abort(reason) }),
        f,
        /No edit was dispatched/,
      );
      assert.equal(f.calls.length, 0);
    }
    const failed = fixture({
      replaceSelectedText: async () => {
        throw Object.assign(new Error("aborted before dispatch"), { dispatched: false });
      },
    });
    const result = await insertText(failed.native, input, observation);
    assert.equal(result.details.macuse.dispatched, false);
    assert.equal(result.details.macuse.outcome, "not_dispatched");
  },
);

nodeTest("unavailable focus coverage does not erase verified text readback", async () => {
  for (const method of ["beginObservation", "endObservation"]) {
    const f = fixture({
      [method]: async () => {
        throw new Error("Observer unavailable");
      },
    });
    const result = await insertText(f.native, input, observation);
    assert.equal(result.details.macuse.outcome, "verified");
    const unavailable = result.details.macuse.focus;
    if (unavailable === undefined) {
      assert.fail("unavailable focus record missing");
    }
    assert.equal(unavailable.observationAvailable, false);
    assert.equal(unavailable.inputAttribution, false);
    assert.match(unavailable.observationError, /Observer unavailable/);
  }
});

// Exercise the real client lifecycle against a fake subprocess: never launch the native helper or touch the desktop.
/**
 * @typedef {EventEmitter & {
 *   pid: number,
 *   stdout: PassThrough,
 *   stderr: PassThrough,
 *   stdin: Writable,
 *   requests: Array<Record<string, unknown>>,
 *   kills: string[],
 *   kill: (signal?: string) => boolean,
 *   respond: (result: unknown) => void,
 * }} FakeChild
 */
/**
 * @param {import("node:test").TestContext} t
 * @returns {FakeChild[]}
 */
function subprocess(t) {
  /** @type {FakeChild[]} */
  const children = [];
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  if (descriptor === undefined) {
    assert.fail("process.platform descriptor missing");
  }
  Object.defineProperty(process, "platform", { ...descriptor, value: "darwin" });
  t.mock.method(fs, "access", async () => null);
  t.mock.method(fs, "mkdir", async () => null);
  t.mock.method(childProcess, "spawn", () => {
    /** @type {FakeChild} */
    const child = Object.assign(new EventEmitter(), {
      pid: 9876,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      requests: [],
      kills: [],
      kill(signal = "SIGTERM") {
        child.kills.push(signal);
        return true;
      },
      respond(/** @type {unknown} */ result) {
        const lastRequest = child.requests.at(-1);
        if (lastRequest === undefined) {
          assert.fail("fixture request missing for response");
        }
        child.stdout.write(`${JSON.stringify({ id: lastRequest.id, result })}\n`);
      },
      stdin: new Writable({
        write(chunk, _encoding, callback) {
          const parsed = /** @type {unknown} */ (JSON.parse(String(chunk)));
          assert.ok(isRecord(parsed), "fixture request must be a JSON object");
          child.requests.push(parsed);
          child.emit("request");
          callback();
        },
      }),
    });
    children.push(child);
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    Object.defineProperty(process, "platform", descriptor);
  });
  return children;
}
/**
 * @param {FakeChild[]} children
 * @returns {Promise<FakeChild>}
 */
async function requested(children) {
  while ((children.at(-1)?.requests.length ?? 0) === 0) {
    await nextTurn();
  }
  const child = children.at(-1);
  if (child === undefined) {
    assert.fail("fake child missing");
  }
  return child;
}

nodeTest(
  "native resolution forwards exact identifiers, returns identity, and preserves rejection",
  async (t) => {
    const children = subprocess(t);
    const native = new MacOSNative();
    const pending = native.resolveApp(appPath);
    const child = await requested(children);
    const firstRequest = child.requests[0];
    if (firstRequest === undefined) {
      assert.fail("first request missing");
    }
    assert.equal(firstRequest.identifier, appPath);
    child.respond(app);
    assert.deepEqual(await pending, app);
    const missing = native.resolveApp("No such app");
    await nextTurn();
    child.respond({ error: "No running app exactly matches No such app" });
    await assert.rejects(missing, /No running app exactly/);
    const stopping = native.stop();
    child.emit("close", null, "SIGTERM");
    await stopping;
  },
);

for (const boundary of ["abort", "timeout"]) {
  nodeTest(
    `native ${boundary} waits for helper exit before settling an edit or restarting`,
    async (t) => {
      const children = subprocess(t);
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const native = new MacOSNative();
      const controller = new AbortController();
      let settled = false;
      const pending = native
        .replaceSelectedText(
          { pid: app.pid, text: input.text, expected: {} },
          { signal: controller.signal },
        )
        .catch((/** @type {unknown} */ error) => {
          settled = true;
          return error;
        });
      const child = await requested(children);
      if (boundary === "abort") {
        controller.abort();
      } else {
        t.mock.timers.tick(15_000);
      }
      await nextTurn();
      assert.deepEqual(child.kills, ["SIGTERM"]);
      assert.equal(settled, false);
      const after = native.resolveApp(bundleId);
      await nextTurn();
      assert.equal(children.length, 1);
      t.mock.timers.tick(1000);
      assert.deepEqual(child.kills, ["SIGTERM", "SIGKILL"]);
      child.emit("close", null, "SIGKILL");
      const failure = await pending;
      assert.ok(isRecord(failure), "edit must settle with a dispatch record");
      assert.equal(failure.dispatched, true);
      assert.match(String(failure.message), boundary === "abort" ? /aborted/ : /timed out/);
      assert.match(String(failure.message), /outcome is unknown.*Do not replay/);
      await nextTurn();
      assert.equal(children.length, 2);
      const restarted = await requested(children);
      const restartRequest = restarted.requests[0];
      if (restartRequest === undefined) {
        assert.fail("restart request missing");
      }
      assert.equal(restartRequest.method, "resolveApp");
      restarted.respond(app);
      await after;
      const stopping = native.stop();
      restarted.emit("close", null, "SIGTERM");
      await stopping;
      assert.equal(
        children.flatMap((c) => c.requests).filter((r) => r.method === "replaceSelectedText")
          .length,
        1,
      );
    },
  );
}

nodeTest("helper loss preserves each outstanding request's own dispatch status", async (t) => {
  const children = subprocess(t);
  const native = new MacOSNative();
  const read = native.inspectApp(app.pid).catch((/** @type {unknown} */ error) => error);
  const child = await requested(children);
  const edit = native
    .replaceSelectedText({ pid: app.pid, text: input.text, expected: {} })
    .catch((/** @type {unknown} */ error) => error);
  await nextTurn();
  child.emit("close", 1, null);
  const readOutcome = await read;
  assert.ok(isRecord(readOutcome), "read must settle with a record");
  assert.equal(readOutcome.dispatched, false);
  const editOutcome = await edit;
  assert.ok(isRecord(editOutcome), "edit must settle with a record");
  assert.equal(editOutcome.dispatched, true);
});

nodeTest(
  "native malformed Unicode and already-aborted requests never start a subprocess",
  async (t) => {
    const children = subprocess(t);
    const native = new MacOSNative();
    // An unpaired surrogate is a string but must be rejected before process startup.
    const malformed = { pid: app.pid, expected: {}, text: "\ud800" };
    await assert.rejects(native.replaceSelectedText(malformed), (/** @type {unknown} */ error) => {
      if (!isRecord(error)) {
        return false;
      }
      return error.dispatched === false && /well-formed/.test(String(error.message));
    });
    await assert.rejects(
      native.inspectApp(app.pid, { signal: AbortSignal.abort() }),
      (/** @type {unknown} */ error) => isRecord(error) && error.dispatched === false,
    );
    assert.equal(children.length, 0);
  },
);
