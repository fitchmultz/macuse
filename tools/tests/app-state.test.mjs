import assert from "node:assert/strict";
import test from "node:test";
import { parseAppState, sameDocument, findSameElement } from "../../lib/app-state.mjs";

const state = tree => `Window: "fixture", App: TextEdit.\n${tree}`;

test("full native observations preserve exact multiline field values and focused identity", () => {
  const value = "Alpha café 日本語 🙂\n\n2026 roadmap\n123 KB\n42\n<example>literal text</example>\nLast line  ";
  for (const header of [`ID: editor, Value: ${value}`, `Value: Alpha café 日本語 🙂, ID: editor\n\n2026 roadmap\n123 KB\n42\n<example>literal text</example>\nLast line  `]) {
    const text = state(`0 standard window fixture, URL: file:///tmp/fixture\n1 text entry area (settable) ${header}\n2 button Done\n\nThe focused UI element is 1 text entry area`);
    const observation = parseAppState("TextEdit", text);
    assert.equal(observation.app, "TextEdit");
    assert.equal(observation.text, text);
    assert.equal(observation.title, "fixture");
    assert.equal(observation.url, "file:///tmp/fixture");
    assert.equal(observation.focused.index, "1");
    assert.equal(observation.focused.id, "editor");
    assert.equal(observation.focused.value, value);
    assert.equal(observation.elements[1].settable, true);
    assert.deepEqual(observation.elements.map(e => e.index), ["0", "1", "2"]);
  }
});

test("native inline search/scalar values and full window title outrank abbreviated header", () => {
  for (const value of ["", "  spaced query ", "café 🙂"]) {
    const parsed = parseAppState("App", state(`0 standard window Full title with punctuation, second part, Secondary Actions: Raise\n1 search text field (settable)${value ? ` ${value}` : ""}\n2 slider (disabled, settable, float) 0.5`));
    assert.equal(parsed.title, "Full title with punctuation, second part");
    assert.equal(parsed.elements[1].value, value);
    assert.equal(parsed.elements[1].name, "search");
    assert.equal(parsed.elements[2].value, "0.5");
    assert.equal(parsed.elements[2].disabled, true);
  }
});

test("document URL uses scoped metadata, never arbitrary body URLs or unfinished address edits", () => {
  const text = state('0 standard window URL: localhost:3000/review/7, Secondary Actions: Raise, Review - Browser\n1 text field (settable) Address and search bar, Value: http://localhost:3000/review/7\n2 HTML content URL: localhost:3000/review/7, Review\n3 text https://unrelated.invalid/body');
  const observed = parseAppState("Browser", text);
  assert.equal(observed.title, "Review - Browser");
  assert.equal(observed.url, "http://localhost:3000/review/7");
  assert.equal(parseAppState("Browser", text.replace("Value: http://localhost:3000/review/7", "Value: https://draft.invalid")).url, "localhost:3000/review/7");
  assert.equal(sameDocument(observed, { ...observed, title: "Other" }), false);
  assert.equal(sameDocument(observed, { ...observed, app: "browser" }), false);
  assert.equal(sameDocument(observed, { ...observed }), true);
  assert.equal(sameDocument({ app: "App", title: null, url: null }, { app: "App", title: null, url: null }), false);
});

test("stable target resolution accepts index changes but rejects duplicate or missing IDs", () => {
  const before = parseAppState("App", state("0 standard window fixture\n1 button Save, ID: save\n2 button Cancel"));
  const shifted = parseAppState("App", state("0 standard window fixture\n8 button Save, ID: save\n9 button Cancel"));
  assert.equal(findSameElement(before.elements[1], shifted).index, "8");
  assert.equal(findSameElement(before.elements[2], shifted).index, "9");
  assert.equal(findSameElement(before.elements[1], parseAppState("App", state("8 button Save"))), undefined);
  assert.equal(findSameElement(before.elements[1], parseAppState("App", state("8 button Save, ID: save\n9 button Save, ID: save"))), undefined);
});
