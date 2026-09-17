import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  compactText, contentText, describeTargetResolution, machineElements, minimalText, parseElementInfo,
  resolveElementDescription, resolveElementId, resolveElementRoleName,
  stateSummary, truncateTextContent, updateElementCache, validateIndexedTarget,
} = await jiti.import("../../extensions/codex-computer-use-modules/elements-state.ts");
const { filterToolResult } = await jiti.import("../../extensions/codex-computer-use-modules/content.ts");
const { parseAppListContent } = await jiti.import("../../extensions/codex-computer-use-modules/apps.ts");
const { waitConditionMet } = await jiti.import("../../extensions/codex-computer-use-modules/sequence.ts");

const content = (text) => [{ type: "text", text }];
const state = (tree) => `Computer Use state (CUA App Version: 1001067)\n<app_state>\nApp=/System/Applications/TextEdit.app/ (bundleID com.apple.TextEdit, pid 123)\nWindow: "fixture.txt", App: TextEdit.\n${tree}\n</app_state>`;

// Shapes captured from TextEdit and Activity Monitor; no workstation data.
test("parses both upstream field orders and keeps multiline values intact", () => {
  const value = "Alpha café 日本語 🧪\n\n123 KB\n<example>literal text</example>\nLast line";
  for (const header of [
    `ID: First Text View, Value: ${value}`,
    `Value: Alpha café 日本語 🧪, ID: First Text View\n\n123 KB\n<example>literal text</example>\nLast line`,
  ]) {
    const text = state(`0 standard window fixture.txt, Secondary Actions: Raise, URL: file:///tmp/fixture.txt\n\t1 scroll area Secondary Actions: Scroll Left, Scroll Right\n\t\t2 text entry area (settable) ${header}\n\t\t3 scroll bar (disabled, settable, float) 0.1851851791143417\n4 menu bar\n\t5 File`);
    const elements = parseElementInfo(text);
    assert.deepEqual(elements.map((element) => element.index), ["0", "1", "2", "3", "4", "5"]);
    const field = elements.find((element) => element.index === "2");
    assert.equal(field.id, "First Text View");
    assert.equal(field.name, "First Text View");
    assert.equal(field.role, "text entry area");
    assert.equal(field.value, value);
    assert.deepEqual(elements[0].secondaryActions, ["Raise"]);
    assert.deepEqual(elements[1].secondaryActions, ["Scroll Left", "Scroll Right"]);
    assert.equal(elements[3].role, "scroll bar");
    assert.equal(elements[3].disabled, true);
    assert.equal(elements[3].value, "0.1851851791143417");
    assert.equal(elements[3].name, "scroll bar");
    assert.equal(stateSummary(content(text)).url, "file:///tmp/fixture.txt");
  }
});

test("does not mistake row measurements for targets or drop sparse and unfamiliar targets", () => {
  const text = state("0 standard window Activity Monitor\n\t1 outline Processes (showing 0-2 of 2 items)\n\t\t2 row (selectable) Example\n123 KB\n0 bytes\n\t\t3 row (selectable) Other\n82 KB\n4 menu bar\n\t5 File\n\t6 Custom Menu\n7 AXUnfamiliar Widget, ID: custom-control\n8 radio button Description: Disk, Value: 1");
  const elements = parseElementInfo(text);
  assert.deepEqual(elements.map((element) => element.index), ["0", "1", "2", "3", "4", "5", "6", "7", "8"]);
  assert.ok(elements[2].line.includes("123 KB\n0 bytes"));
  const cache = new Map([["fixture", elements]]);
  assert.equal(resolveElementRoleName({ app: "fixture", name: "File" }, cache).element_index, "5");
  assert.equal(resolveElementId({ app: "fixture", elementId: "custom-control" }, cache).element_index, "7");
  assert.equal(resolveElementDescription({ app: "fixture", elementDescription: "Disk" }, cache).element_index, "8");
  assert.equal(elements[8].value, "1");
});

test("retains actual multiword roles instead of treating role suffixes as names", () => {
  const roles = ["scroll bar", "value indicator", "full screen button", "increment arrow button", "decrement arrow button", "increment page button", "decrement page button", "sort button", "menu button", "tab group"];
  const elements = parseElementInfo(roles.map((role, index) => `${index} ${role}`).join("\n"));
  assert.deepEqual(elements.map((element) => element.role), roles);
  assert.deepEqual(elements.map((element) => element.name), roles);
  const scalar = parseElementInfo("1 scroll bar (settable, float) 0.5\n2 slider (settable, int) 3\n3 checkbox (settable, bool) true");
  assert.deepEqual(scalar.map((element) => element.value), ["0.5", "3", "true"]);
  assert.equal(stateSummary(content(state("2 text https://example.com/body-only"))).url, null);
});

test("browser document URLs use scoped metadata and matching full address values", () => {
  // Sanitized from a live Brave state: window URLs omit https://, address fields retain it.
  const text = state('0 standard window URL: example.com/review/7, Secondary Actions: Raise, Review - Brave\n1 container URL: example.com/review/7, Review - Brave\n13 text field (settable) Address and search bar, Value: https://example.com/review/7, Placeholder: Search Brave or type a URL\n48 HTML content URL: example.com/review/7, Review\n49 text https://unrelated.invalid/body-link');
  assert.equal(stateSummary(content(text)).url, 'https://example.com/review/7');
  assert.ok(waitConditionMet('waitForURL', { app: 'Browser', url: 'https://example.com/review/7' }, filterToolResult({ content: content(text) }), new Map()));
  assert.equal(waitConditionMet('waitForURL', { app: 'Browser', url: 'https://unrelated.invalid/body-link' }, filterToolResult({ content: content(text) }), new Map()), null);
  for (const [display, full] of [['localhost:3000/review/7', 'http://localhost:3000/review/7'], ['example.com:8443/review/7', 'https://example.com:8443/review/7']]) {
    const portState = text.replaceAll('https://example.com/review/7', full).replaceAll('example.com/review/7', display);
    assert.equal(stateSummary(content(portState)).url, full);
    assert.ok(waitConditionMet('waitForURL', { app: 'Browser', url: full }, filterToolResult({ content: content(portState) }), new Map()));
  }
  assert.equal(stateSummary(content(state('0 standard window URL: about:blank'))).url, 'about:blank');
  assert.equal(parseElementInfo(text).find(e => e.index === '48').role, 'html content');
  const draft = text.replace('Value: https://example.com/review/7', 'Value: https://different.invalid/typed-but-not-open');
  assert.equal(stateSummary(content(draft)).url, 'example.com/review/7', 'draft address input cannot replace window identity');
  assert.equal(stateSummary(content(state('0 standard window New Tab\n1 web area URL: brave://newtab/\n2 text https://unrelated.invalid/body-link'))).url, 'brave://newtab/');
});

test("displayed window titles can be copied into title guards and waits", () => {
  for (const title of ['A very long document title, with punctuation - Browser', 'Say "hi" - Browser']) {
    const text = state(`0 standard window URL: example.com/page, Secondary Actions: Raise, ${title}\n1 text field (settable) ID: editor, Value: old`).replace('Window: "fixture.txt"', `Window: "${title.includes('"') ? title : 'A very long…Browser'}"`);
    for (const render of [minimalText, compactText]) {
      const displayed = JSON.parse(render(text).match(/^Window: (.*), App: .*$/m)[1]);
      assert.equal(displayed, title);
      assert.ok(waitConditionMet('waitForText', { app: 'Browser', text: 'old', title: displayed }, filterToolResult({ content: content(text) }), new Map()));
      assert.ok(waitConditionMet('waitForTitle', { app: 'Browser', title: displayed }, filterToolResult({ content: content(text) }), new Map()));
    }
  }
});

test("duplicate IDs reject ambiguity and a successful empty refresh invalidates targets", () => {
  const cache = new Map();
  updateElementCache(cache, "fixture", content(state("2 button First, ID: duplicate\n3 button Second, ID: duplicate")));
  assert.throws(() => resolveElementId({ app: "fixture", elementId: "duplicate" }, cache), /Ambiguous 2 elementId/);
  assert.equal(resolveElementDescription({ app: "fixture", elementDescription: "Second" }, cache).element_index, "3");
  updateElementCache(cache, "fixture", content(state("")));
  assert.deepEqual(cache.get("fixture"), []);
  assert.throws(() => resolveElementId({ app: "fixture", elementId: "duplicate" }, cache), /No elementId/);
  assert.throws(() => validateIndexedTarget({ app: "fixture", element_index: "3" }, cache), /not present in the latest/);
});

test("small display budgets do not remove late targets or field content from machine state", () => {
  const value = `START_PREVIEW ${"Long document text. ".repeat(300)}\nEND_FULL_VALUE`;
  const text = state(`2 text entry area (settable) Value: ${value.split("\n")[0]}, ID: First Text View\nEND_FULL_VALUE\n3 radio button Description: Disk, Value: 1`);
  const filtered = filterToolResult({ content: content(text) });
  assert.equal(contentText(filtered.content), text);
  const cache = new Map();
  updateElementCache(cache, "fixture", filtered.content);
  assert.equal(resolveElementDescription({ app: "fixture", elementDescription: "Disk" }, cache).element_index, "3");
  assert.equal(machineElements(filtered.content).find((element) => element.id === "First Text View").value, value);
  assert.equal(stateSummary(filtered.content).targets.find((element) => element.index === "2").value, value);
  assert.ok(contentText(truncateTextContent(filtered.content, 64)).length < 100);
  assert.equal(contentText(filtered.content), text, "presentation must not mutate internal content");
});

test("minimal and compact views show one bounded field preview and preserve exact selectors", () => {
  const value = `UNIQUE_PREVIEW ${"Document content. ".repeat(500)}`;
  const text = state(`2 text entry area (settable) ID: First Text View, Value: ${value}\n3 button Done, ID: done`);
  for (const render of [minimalText, compactText]) {
    const shown = render(text);
    assert.ok(shown.length < 1800, `unexpected presentation length: ${shown.length}`);
    assert.equal(shown.split("UNIQUE_PREVIEW").length - 1, 1);
    assert.ok(shown.includes('elementId: "First Text View"'));
    assert.ok(shown.includes('elementId: "done"'));
    assert.ok(!shown.includes(value));
  }
  assert.equal(machineElements(content(text)).find((element) => element.index === "2").value, value, "internal values retain meaningful trailing whitespace");
  const cache = new Map([["fixture", parseElementInfo(text)]]);
  const resolution = describeTargetResolution({ elementId: "First Text View" }, { app: "fixture", element_index: "2" }, cache);
  assert.ok(resolution.length < 600, "sequence target evidence must not repeat the complete field value");
  assert.ok(resolution.includes('elementId: "First Text View"'));
});

test("inline string values and long selector names stay complete internally but bounded on display", () => {
  const value = `VALUE_START ${"abc ".repeat(1500)}`.trim();
  const label = `LABEL_START ${"label ".repeat(1000)}`.trim();
  const text = state(`2 text field (settable, string) ${value}\n3 button ${label}\n4 text entry area (settable) Value: , ID: empty-field`);
  const elements = machineElements(content(text));
  assert.equal(elements.find((element) => element.index === "2").value, value);
  assert.equal(elements.find((element) => element.index === "3").description, label);
  assert.equal(elements.find((element) => element.index === "4").value, "");
  for (const render of [minimalText, compactText]) {
    const shown = render(text);
    assert.ok(shown.length < 2200);
    assert.ok(shown.includes('element_index: "3", expectedRole: "button"'));
    assert.ok(!shown.includes(`elementDescription: "LABEL_START`), "never offer a truncated selector");
  }
});

test("native search values remain values, including the empty omitted string", () => {
  // Live Activity Monitor emits `(settable) query`, or just `(settable)` for an empty string.
  for (const value of ['', 'MACUSE_NO_PROCESS_MATCH_7271', '  spaced query ']) {
    const [field] = parseElementInfo(`57 search text field (settable)${value ? ` ${value}` : ''}`);
    assert.equal(field.value, value);
    assert.equal(field.name, 'search');
  }
  assert.equal(parseElementInfo('1 text field (settable) ID: unknown')[0].value, undefined, 'do not turn every missing value into an empty string');
});

test("parses live last-used= app flags", () => {
  const [app] = parseAppListContent(content("TextEdit — /System/Applications/TextEdit.app — com.apple.TextEdit [running, last-used=2026-09-16]"), { runningOnly: true });
  assert.equal(app.lastUsed, "2026-09-16");
  assert.equal(app.bundleId, "com.apple.TextEdit");
  assert.equal(app.running, true);
});
