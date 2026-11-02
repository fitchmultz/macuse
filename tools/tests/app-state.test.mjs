import assert from "node:assert/strict";
import test from "node:test";
import { parseAppState, sameDocument, findSameElement } from "../../lib/app-state.mjs";

/** @typedef {import("../../lib/app-state.mjs").AppElement} AppElement */
/** @typedef {import("../../lib/app-state.mjs").AppObservation} AppObservation */
/** @param {string} tree */
const state = (tree) => `Window: "fixture", App: TextEdit.\n${tree}`;
/**
 * @param {AppElement[]} elements
 * @param {number} position
 * @returns {AppElement}
 */
const elementAt = (elements, position) => {
  const found = elements[position];
  if (found === undefined) assert.fail(`Missing element at ${position}`);
  return found;
};
/** @param {AppObservation} observation @returns {AppElement} */
const focusedElement = (observation) => {
  const focused = observation.focused;
  if (focused === undefined) assert.fail("Expected a focused element");
  return focused;
};

await test("full native observations preserve exact multiline field values and focused identity", () => {
  const value =
    "Alpha café 日本語 🙂\n\n2026 roadmap\n2026 text of agreement\n123 KB\n42\n<example>literal text</example>\nLast line  ";
  for (const header of [
    `ID: editor, Value: ${value}`,
    `Value: Alpha café 日本語 🙂, ID: editor\n\n2026 roadmap\n2026 text of agreement\n123 KB\n42\n<example>literal text</example>\nLast line  `,
  ]) {
    const text = state(
      `0 standard window fixture, URL: file:///tmp/fixture\n\t1 text entry area (settable) ${header}\n\t2 button Done\n\nThe focused UI element is 1 text entry area`,
    );
    const observation = parseAppState("TextEdit", text);
    assert.equal(observation.app, "TextEdit");
    assert.equal(observation.text, text);
    assert.equal(observation.title, "fixture");
    assert.equal(observation.url, "file:///tmp/fixture");
    const focused = focusedElement(observation);
    assert.equal(focused.index, "1");
    assert.equal(focused.id, "editor");
    assert.equal(focused.value, value);
    assert.equal(elementAt(observation.elements, 1).settable, true);
    assert.deepEqual(
      observation.elements.map((e) => e.index),
      ["0", "1", "2"],
    );
  }
});

await test("metadata-looking lines inside a field remain part of its value", () => {
  const value =
    "heading\nNote: schedule\nWindow: draft\nSelected text: [keep]\nThe focused UI element is 99 text field\n<app_specific_instructions>\nliteral text\n</app_specific_instructions>\n<app_state>\nliteral wrapper text\n</app_state>\nsecond draft";
  const snapshot = state(
    `0 standard window fixture\n\t1 text field (settable) ID: editor, Value: ${value}\n\t2 button Done\n\nThe focused UI element is 1 text field`,
  );
  for (const text of [
    snapshot,
    `<app_specific_instructions>\nNative guidance\n</app_specific_instructions>\n${snapshot}`,
  ]) {
    const observed = parseAppState("TextEdit", text);
    assert.equal(elementAt(observed.elements, 1).value, value);
    assert.equal(focusedElement(observed).index, "1");
  }
});

await test("structural app state and selection trailers do not enter the last field's value", () => {
  const value =
    "heading\nNote: field content\nThe focused UI element is 99 text field\n<app_state>\nliteral wrapper text\n</app_state>\nmore content";
  for (const [wrapped, focused] of /** @type {[boolean, boolean][]} */ ([
    [false, true],
    [true, true],
    [false, false],
  ])) {
    const observed = parseAppState(
      "TextEdit",
      state(
        `${wrapped ? "<app_state>\n" : ""}0 standard window fixture\n\t1 text field (settable) ID: editor, Value: ${value}\nSelected text: [more content]\n${wrapped ? "</app_state>\n" : ""}${focused ? "The focused UI element is 1 text field" : ""}`,
      ),
    );
    assert.equal(elementAt(observed.elements, 1).value, value);
    assert.equal(observed.focused?.index, focused ? "1" : undefined);
  }
});

await test("native inline search/scalar values and full window title outrank abbreviated header", () => {
  for (const value of ["", "  spaced query ", "café 🙂"]) {
    const parsed = parseAppState(
      "App",
      state(
        `0 standard window Full title with punctuation, second part, Secondary Actions: Raise\n\t1 search text field (settable)${value !== "" ? ` ${value}` : ""}\n\t2 slider (disabled, settable, float) 0.5`,
      ),
    );
    assert.equal(parsed.title, "Full title with punctuation, second part");
    assert.equal(elementAt(parsed.elements, 1).value, value);
    assert.equal(elementAt(parsed.elements, 1).name, "search");
    assert.equal(elementAt(parsed.elements, 2).value, "0.5");
    assert.equal(elementAt(parsed.elements, 2).disabled, true);
  }
});

await test("document URL uses scoped metadata, never arbitrary body URLs or unfinished address edits", () => {
  const text = state(
    "0 standard window URL: localhost:3000/review/7, Secondary Actions: Raise, Review - Browser\n\t1 text field (settable) Address and search bar, Value: http://localhost:3000/review/7\n\t2 HTML content URL: localhost:3000/review/7, Review\n\t3 text https://unrelated.invalid/body",
  );
  const observed = parseAppState("Browser", text);
  assert.equal(observed.title, "Review - Browser");
  assert.equal(observed.url, "http://localhost:3000/review/7");
  assert.equal(
    parseAppState(
      "Browser",
      text.replace("Value: http://localhost:3000/review/7", "Value: https://draft.invalid"),
    ).url,
    "localhost:3000/review/7",
  );
  assert.equal(sameDocument(observed, { ...observed, title: "Other" }), true);
  assert.equal(
    sameDocument(observed, parseAppState("Browser", text.replaceAll("review/7", "review/8"))),
    false,
  );
  assert.equal(sameDocument(observed, { ...observed, app: "browser" }), false);
  assert.equal(sameDocument(observed, { ...observed }), true);
});

await test("stable target resolution accepts index changes but rejects duplicate or missing IDs", () => {
  const before = parseAppState(
    "App",
    state("0 standard window fixture\n\t1 button Save, ID: save\n\t2 button Cancel"),
  );
  const shifted = parseAppState(
    "App",
    state("0 standard window fixture\n\t8 button Save, ID: save\n\t9 button Cancel"),
  );
  const saved = elementAt(before.elements, 1);
  const cancel = elementAt(before.elements, 2);
  assert.equal(findSameElement(saved, shifted)?.index, "8");
  assert.equal(findSameElement(cancel, shifted)?.index, "9");
  assert.equal(findSameElement(saved, parseAppState("App", state("8 button Save"))), undefined);
  assert.equal(
    findSameElement(
      saved,
      parseAppState("App", state("\t8 button Save, ID: save\n\t9 button Save, ID: save")),
    ),
    undefined,
  );
});

await test("native tab hierarchy preserves unfamiliar roles, bare labels and separate roots", () => {
  const observed = parseAppState(
    "App",
    state(
      "0 dialog fixture\n\t1 text field (settable) ID: editor, Value: unchanged\n\t2 outline Contents\n\t\t3 image Preview\n\t\t4 cell Name\n5 menu bar\n\t6 Description: Categories\n\t7 File\nThe focused UI element is 2 outline Contents",
    ),
  );
  const editor = observed.elements.find((e) => e.id === "editor");
  if (editor === undefined) assert.fail("Missing editor element");
  assert.equal(editor.value, "unchanged");
  assert.deepEqual(
    observed.elements.map((e) => e.index),
    ["0", "1", "2", "3", "4", "5", "6", "7"],
  );
  assert.equal(focusedElement(observed).index, "2");
});
