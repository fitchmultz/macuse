import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { createJiti } from 'jiti';
const jiti = createJiti(import.meta.url);
const { executeSequence } = await jiti.import('../../extensions/codex-computer-use-modules/sequence-runner.ts');
const { macosNative } = await jiti.import('../../extensions/codex-computer-use-modules/macos-focus.ts');
const extension = await jiti.import('../../extensions/codex-computer-use.ts');
const app = { pid: 1, name: 'User app', bundleId: 'user.app', path: '/User.app' };
const snapshot = { frontmost: app, focusedWindow: null };
beforeEach(() => {
  mock.method(macosNative, 'beginObservation', async () => ({ id: 'observation', before: snapshot }));
  mock.method(macosNative, 'endObservation', async () => ({ before: snapshot, after: snapshot, transitions: [], coverage: { applicationActivation: true, focusedWindow: {}, truncated: false, inputAttribution: false } }));
  mock.method(macosNative, 'inspectApp', async () => { throw new Error('Native boundary unavailable in this fixture'); });
});
afterEach(() => mock.restoreAll());
const tree = (value = 'old', title = 'A.txt', extra = '') => `App=/Test.app (bundleID test.app, pid 4242)\nWindow: "${title}", App: Test.\n0 standard window ${title}, URL: file:///tmp/${title}\n\t1 text field (settable) ID: editor, Value: ${value}\n\t2 button Description: Toggle\n\t3 text ${extra}\n</app_state>`;
const wrap = (text, isError = false) => ({ result: { content: [{ type: 'text', text }], isError }, durationMs: 1, acceptedElicitations: 0, elicitationCount: 0 });
const state = text => wrap(text);
function fixture(replies) {
  const calls = [];
  const client = { async callTool(tool, args) { calls.push({ tool, args }); const next = replies.shift(); if (next instanceof Error) throw next; assert.ok(next, `unexpected ${tool}`); return next; }, status() { return { threadId: 'fixture', stderrTail: '', computerUseRecoveryEvents: [] }; } };
  return { calls, run: (steps, options = {}, signal) => executeSequence({ app: 'test.app', steps, allowMutating: true, safetyNote: 'Only the disposable fixture document; stop before other app changes.', detail: 'minimal', ...options }, signal, undefined, () => client, new Map()) };
}
const edit = value => ({ tool: 'set_value', arguments: { elementId: 'editor', value } });

test('validates a later malformed step before any earlier mutation', async () => {
  const f = fixture([]);
  await assert.rejects(f.run([edit('new'), { tool: 'waitForText', arguments: {} }]), /requires arguments.text/);
  await assert.rejects(f.run([edit('new'), { tool: 'type_text', arguments: {} }]), /requires arguments.text/);
  await assert.rejects(f.run([edit('new'), { tool: 'waitForElement', arguments: { targets: [{ elementId: 12 }] } }]), /elementId must be a string/);
  assert.deepEqual(f.calls, []);
});

test('preflight rejects a document change after the agent inspected its target', async () => {
  const f = fixture([state(tree()), state(tree('old', 'B.txt'))]);
  const result = await f.run([{ tool: 'get_app_state' }, edit('new')]);
  assert.match(result.details.computerUse.failed.message, /Target document changed/);
  assert.equal(result.details.computerUse.resumeFromStepIndex, 1);
  assert.equal(result.details.computerUse.steps[1].dispatched, false);
  assert.deepEqual(f.calls.map(c => c.tool), ['get_app_state', 'get_app_state']);
});

test('a new app alias cannot bypass the previously observed document guard', async () => {
  const f = fixture([state(tree()), state(tree('old', 'B.txt'))]);
  const result = await f.run([{ tool: 'get_app_state', arguments: { app: 'test.app' } }, { ...edit('new'), arguments: { app: 'Test', elementId: 'editor', value: 'new' } }]);
  assert.match(result.details.computerUse.failed.message, /Target document changed/);
  assert.equal(result.details.computerUse.steps[1].dispatched, false);
  assert.deepEqual(f.calls.map(c => c.tool), ['get_app_state', 'get_app_state']);
});

test('action bundle headers and read path headers identify the same running app', async () => {
  const actionState = tree().replace('/Test.app (bundleID test.app, pid 4242)', 'test.app (pid 4242)');
  const f = fixture([state(tree()), state(actionState), state(tree()), wrap('Saved')]);
  const result = await f.run([{ tool: 'select_text', arguments: { elementId: 'editor', text: 'old' } }, { tool: 'press_key', arguments: { key: 'super+s' } }]);
  assert.equal(result.details.computerUse.failed, null);
  assert.deepEqual(f.calls.map(c => c.tool), ['get_app_state', 'select_text', 'get_app_state', 'press_key']);
});

test('set_value does not accept requested text elsewhere in an unchanged document', async () => {
  const unchanged = tree('old', 'A.txt', 'needle');
  const f = fixture([state(unchanged), wrap('Value set'), state(unchanged)]);
  const result = await f.run([edit('needle')]);
  assert.match(result.details.computerUse.failed.message, /resolved field did not expose/);
  assert.equal(result.details.computerUse.steps[0].dispatched, true);
  assert.equal(result.details.computerUse.resumeFromStepIndex, null);
});

test('set_value readback cannot verify the same field ID in a different document', async () => {
  const f = fixture([state(tree()), wrap('Value set'), state(tree('desired', 'B.txt'))]);
  const result = await f.run([edit('desired')]);
  assert.match(result.details.computerUse.failed.message, /readback belongs to a different document/);
  assert.equal(result.details.computerUse.steps[0].outcome, 'unknown');
  assert.equal(result.details.computerUse.resumeFromStepIndex, null);
});

test('small presentation budgets keep late selectors and exact multiline field verification', async () => {
  const before = tree().replace('\t1 text field', `\t5 text ${'padding'.repeat(1000)}\n\t1 text field`);
  const wanted = '  café 日本語 🧪\nline two \n';
  const f = fixture([state(before), wrap('Value set'), state(tree(wanted))]);
  const result = await f.run([edit(wanted)], { maxTextChars: 1000 });
  assert.equal(result.details.computerUse.failed, null);
  assert.equal(result.details.computerUse.steps[0].outcome, 'verified');
  assert.equal(f.calls[1].args.element_index, '1');
  assert.equal(f.calls[1].args.value, wanted);
  assert.ok(result.content[0].text.length < 1100);
});

test('unrelated clock text does not prove that a targeted no-op button worked', async () => {
  const f = fixture([state(tree('old', 'A.txt', 'clock 1')), wrap('Pressed'), state(tree('old', 'A.txt', 'clock 2')), state(tree('old', 'A.txt', 'clock 3'))]);
  const result = await f.run([{ tool: 'perform_secondary_action', arguments: { elementDescription: 'Toggle', action: 'Press' }, requireStateChange: true }]);
  assert.match(result.details.computerUse.failed.message, /actionDispatchedButNoStateChange/);
  assert.equal(result.details.computerUse.resumeFromStepIndex, null);
});

test('cancel interrupts the wait interval without issuing another snapshot', async () => {
  const f = fixture([state(tree())]);
  const controller = new AbortController();
  const start = performance.now();
  const timer = setTimeout(() => controller.abort(), 30);
  const result = await f.run([{ tool: 'waitForText', arguments: { text: 'absent', timeoutMs: 20000, intervalMs: 10000 } }], {}, controller.signal);
  clearTimeout(timer);
  assert.ok(result.details.computerUse.failed);
  assert.ok(performance.now() - start < 1000, 'cancellation waited for the poll interval');
  assert.equal(f.calls.length, 1);
  assert.ok(result.details.computerUse.steps[0].durationMs > 0);
});

test('failed postconditions preserve dispatch evidence and become Pi errors without losing details', async () => {
  const f = fixture([state(tree()), state(tree()), wrap('Pressed'), state(tree('new'))]);
  const result = await f.run([{ tool: 'get_app_state' }, { tool: 'perform_secondary_action', arguments: { elementDescription: 'Toggle', action: 'Press' }, expectVisibleText: ['missing outcome'] }]);
  const d = result.details.computerUse;
  assert.equal(d.failed.index, 1);
  assert.equal(d.steps[1].dispatched, true);
  assert.equal(d.steps[1].outcome, 'unknown', 'failed assertions cannot verify an action');
  assert.equal(d.resumeFromStepIndex, null);
  assert.match(result.content[0].text, /do not replay/i);
  const handlers = new Map();
  (extension.default ?? extension)({ registerTool() {}, registerCommand() {}, on(name, handler) { handlers.set(name, handler); } });
  const patch = await handlers.get('tool_result')({ toolName: 'macuse_sequence', details: result.details, content: result.content, isError: false });
  assert.deepEqual(patch, { isError: true });
  assert.equal(d.completedStepCount, 1);
});

test('last-window close is successful only when native inspection confirms zero windows', async () => {
  mock.method(macosNative, 'inspectApp', async () => ({ pid: 4242, windowsCount: 0 }));
  const f = fixture([state(tree()), wrap('Computer Use server error -10005: noWindowsAvailable', true)]);
  const result = await f.run([{ tool: 'press_key', arguments: { key: 'super+w' } }]);
  assert.equal(result.details.computerUse.failed, null);
  assert.equal(result.details.computerUse.steps[0].outcome, 'verified');
  assert.equal(f.calls.length, 2, 'must not reopen the app for a post-close screenshot');
});

test('closing one document can be verified while other windows remain', async () => {
  for (const oldStillPresent of [false, true]) {
    const windows = [{ token: 'B', title: 'B.txt', document: 'file:///tmp/B.txt' }];
    if (oldStillPresent) windows.push({ token: 'A', title: 'A.txt', document: 'file:///tmp/A.txt' });
    mock.method(macosNative, 'inspectApp', async () => ({ windowsCount: windows.length, windows }));
    const f = fixture([state(tree()), state(tree('old', 'B.txt'))]);
    const result = await f.run([{ tool: 'press_key', arguments: { key: 'super+w' }, requireStateChange: true }]);
    assert.equal(Boolean(result.details.computerUse.failed), oldStillPresent);
    assert.equal(result.details.computerUse.steps[0].outcome, oldStillPresent ? 'unknown' : 'verified');
    assert.deepEqual(f.calls.map(c => c.tool), ['get_app_state', 'press_key']);
  }
});

test('unverified closes never read upstream state, even with requested evidence', async () => {
  mock.method(macosNative, 'inspectApp', async () => ({ windowsCount: null }));
  for (const reply of [wrap('Closed'), wrap('noWindowsAvailable', true)]) {
    const f = fixture([state(tree()), reply]);
    const result = await f.run([{ tool: 'press_key', arguments: { key: 'super+w' }, requireStateChange: true }], { includeImage: true });
    assert.equal(result.details.computerUse.failed.dispatched, true);
    assert.equal(result.details.computerUse.resumeFromStepIndex, null);
    assert.deepEqual(f.calls.map(c => c.tool), ['get_app_state', 'press_key'], 'readback could reopen a closed app');
  }
});

test('Unicode uses native selection replacement and is never replayed through upstream typing', async () => {
  const window = { token: 'w', title: 'A.txt', document: 'file:///tmp/A.txt' };
  mock.method(macosNative, 'inspectApp', async () => ({ pid: 4242, focusedWindow: window, focusedElement: { token: 'e', selectedTextSettable: true } }));
  const inserted = mock.method(macosNative, 'replaceSelectedText', async input => ({ status: 'applied', mutationAttempted: true, verified: true, insertedUTF16Length: input.text.length, replacedUTF16Length: 3 }));
  const text = 'café 日本語 🧪';
  const f = fixture([state(tree()), state(tree(text))]);
  const result = await f.run([{ tool: 'type_text', arguments: { text } }]);
  assert.equal(result.details.computerUse.failed, null);
  assert.equal(result.details.computerUse.steps[0].outcome, 'verified');
  assert.equal(inserted.mock.calls[0].arguments[0].text, text);
  assert.deepEqual(f.calls.map(c => c.tool), ['get_app_state', 'get_app_state']);
});

test('native edit exceptions wait for helper exit before returning an unknown outcome', async () => {
  const stopped = Promise.withResolvers();
  const stopping = Promise.withResolvers();
  mock.method(macosNative, 'inspectApp', async () => ({ pid: 4242, focusedWindow: { token: 'w', title: 'A.txt', document: 'file:///tmp/A.txt' }, focusedElement: { token: 'e', selectedTextSettable: true } }));
  mock.method(macosNative, 'replaceSelectedText', async () => { throw new Error('Native edit timed out'); });
  mock.method(macosNative, 'stop', async () => { stopping.resolve(); await stopped.promise; });
  const f = fixture([state(tree())]);
  let returned = false;
  const pending = f.run([{ tool: 'type_text', arguments: { text: 'café' } }]).then(r => { returned = true; return r; });
  await stopping.promise;
  assert.equal(returned, false);
  stopped.resolve();
  const result = await pending;
  assert.equal(result.details.computerUse.steps[0].outcome, 'unknown');
  assert.equal(result.details.computerUse.failed.dispatched, true);
  assert.equal(f.calls.length, 1);
});

test('unverified native insertion does not fall back or advertise safe replay', async () => {
  mock.method(macosNative, 'inspectApp', async () => ({ pid: 4242, focusedWindow: { token: 'w', title: 'A.txt', document: 'file:///tmp/A.txt' }, focusedElement: { token: 'e', selectedTextSettable: true } }));
  mock.method(macosNative, 'replaceSelectedText', async () => ({ status: 'unverified', mutationAttempted: true, reason: 'readback failed' }));
  const f = fixture([state(tree())]);
  const result = await f.run([{ tool: 'type_text', arguments: { text: 'ASCII too' } }]);
  assert.equal(result.details.computerUse.failed.dispatched, true);
  assert.equal(result.details.computerUse.resumeFromStepIndex, null);
  assert.equal(f.calls.length, 1);
});
