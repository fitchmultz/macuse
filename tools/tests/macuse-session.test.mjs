import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MacuseSession } from '../../lib/macuse-session.mjs';
import { activityMonitorCheck } from '../validate-macuse.mjs';

const result = () => ({ content: [{ type: 'text', text: 'Observed' }], isError: false, details: { macuse: {} } });
const observed = { app: 'Test', title: 'Fixture', url: null, observedAt: 1, elements: [], focused: { index: '1', role: 'text field', id: 'editor', value: 'old' } };
observed.elements = [observed.focused];
const app = { pid: 42, bundleId: 'test.app', name: 'Test', path: '/Test.app' };
const state = { pid: 42, app, accessibilityTrusted: true, focusedWindow: { token: 'w', title: 'Fixture', document: null }, focusedElement: { token: 'f', role: 'AXTextField', roleDescription: 'text field', identifier: 'editor', value: 'old', selectedTextSettable: true } };
function fixture() {
  const events = [];
  const runtime = { execute: async () => { events.push('code'); return result(); }, getObservation: () => observed, invalidateObservation: app => events.push(`invalidate:${app}`), reset: async () => events.push('reset'), stop: async () => events.push('stop-code'), status: () => ({ running: false }) };
  const native = { resolveApp: async () => app, inspectApp: async () => state, beginObservation: async () => ({ id: 'watch' }), endObservation: async () => ({ transitions: [], coverage: { applicationActivation: true } }), replaceSelectedText: async () => ({ status: 'applied', verified: true, mutationAttempted: true }), stop: async () => events.push('stop-native') };
  const auxiliary = { callTool: async () => { events.push('auxiliary'); return result(); }, stop: async () => events.push('stop-auxiliary'), status: () => ({ running: false }) };
  return { events, runtime, native, auxiliary, session: new MacuseSession({ runtime, native, auxiliary }) };
}

test('code never starts auxiliary transport; invalid envelopes fail before native access', async () => {
  const f = fixture();
  const valid = await f.session.callTool('macuse', { code: '42', trackFocus: false });
  assert.equal(valid.isError, false);
  assert.deepEqual(f.events, ['code']);
  for (const [name, input] of [['macuse', []], ['macuse', { code: 1 }], ['macuse', { code: '42', trackFocus: 'false' }], ['macuse_insert_text', {}], ['unknown', {}]]) {
    const invalid = await f.session.callTool(name, input);
    assert.equal(invalid.isError, true);
    assert.equal(invalid.details.macuse.dispatched, false);
  }
  assert.deepEqual(f.events, ['code']);
  await f.session.stop();
});

test('missing Sky focus marker is joined only to a unique matching native ID in the observed document', async () => {
  for (const mismatch of [false, 'document', 'value', 'duplicate']) {
    const f = fixture();
    const field = observed.focused;
    const observation = { ...observed, focused: undefined, observedAt: Date.now() + 1000, elements: mismatch === 'duplicate' ? [field, field] : [field] };
    f.runtime.execute = async () => ({ ...result(), details: { macuse: { observations: [observation] } } });
    f.native.inspectApp = async () => ({ ...state, focusedWindow: { ...state.focusedWindow, title: mismatch === 'document' ? 'Other' : 'Fixture' }, focusedElement: { ...state.focusedElement, value: mismatch === 'value' ? 'changed' : 'old' } });
    await f.session.callTool('macuse', { code: 'observe', trackFocus: false });
    assert.equal(observation.focused?.id, mismatch ? undefined : 'editor');
  }
});

test('presentation caps never erase action outcomes or the full internal result', async () => {
  const f = fixture();
  f.runtime.execute = async () => ({ content: [{ type: 'text', text: 'x'.repeat(30000) }], isError: true, details: { macuse: { status: 'unknown', actions: [{ id: 1, method: 'set_value', app: 'Test', dispatched: true, outcome: 'unknown', verification: 'none' }] } } });
  const response = await f.session.callTool('macuse', { code: 'observe', trackFocus: false });
  assert.equal(response.content[0].text.length, 20000);
  assert.equal(response.details.macuse.fullOutput[0].text.length, 30000);
  assert.match(response.content.at(-2).text, /\"dispatched\":true/);
  assert.match(response.content.at(-1).text, /never automatically replay/);
});

test('screenshot export preserves the literal requested path and refuses overwrite', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'macuse-image-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const f = fixture(); f.session.cwd = dir;
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  f.runtime.execute = async () => ({ ...result(), content: [{ type: 'image', mimeType: 'image/jpeg', data: bytes.toString('base64') }] });
  const saved = await f.session.callTool('macuse', { code: 'screenshot', saveImagePath: '@capture.jpg', trackFocus: false });
  assert.equal(saved.isError, false);
  assert.equal(saved.details.macuse.savedImage.path, join(dir, '@capture.jpg'));
  assert.deepEqual(await readFile(join(dir, '@capture.jpg')), bytes);
  const exists = await f.session.callTool('macuse', { code: 'screenshot', saveImagePath: '@capture.jpg', trackFocus: false });
  assert.equal(exists.isError, true);
  assert.match(exists.content.map(p => p.text ?? '').join('\n'), /EEXIST/);
  assert.deepEqual(await readFile(join(dir, '@capture.jpg')), bytes);
});

test('selected insertion owns the same queue as code and invalidates its prior observation', async () => {
  const f = fixture();
  const editing = Promise.withResolvers(), edited = Promise.withResolvers();
  f.native.replaceSelectedText = async () => { editing.resolve(); await edited.promise; return { status: 'applied', mutationAttempted: true, verified: true }; };
  const edit = f.session.callTool('macuse_insert_text', { app: 'Test', text: 'café', allowMutating: true, safetyNote: 'Only replace the fixture selection; no other effects.' });
  await editing.promise;
  const next = f.session.callTool('macuse', { code: '42', trackFocus: false });
  await Promise.resolve();
  assert.deepEqual(f.events, []);
  edited.resolve();
  assert.equal((await edit).details.macuse.outcome, 'verified');
  await next;
  assert.deepEqual(f.events, ['invalidate:Test', 'code']);
  await f.session.stop();
});

test('reset aborts the active call, drains it, cancels queued calls, and never replays', async () => {
  const f = fixture(), started = Promise.withResolvers(), settled = Promise.withResolvers();
  f.runtime.execute = async (_input, { signal }) => { started.resolve(); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); await settled.promise; f.events.push('aborted-code-settled'); return { ...result(), isError: true }; };
  const first = f.session.callTool('macuse', { code: 'held', trackFocus: false });
  await started.promise;
  const queued = f.session.callTool('macuse', { code: 'must-not-run', trackFocus: false });
  const reset = f.session.reset();
  await Promise.resolve();
  assert.deepEqual(f.events, []);
  settled.resolve();
  assert.equal((await first).details.macuse.isError, true);
  assert.equal((await queued).details.macuse.dispatched, false);
  await reset;
  assert.deepEqual(f.events, ['aborted-code-settled', 'reset']);
  await f.session.stop();
});

test('new calls wait through an in-progress kernel reset', async () => {
  const f = fixture(), started = Promise.withResolvers(), finished = Promise.withResolvers();
  f.runtime.reset = async () => { started.resolve(); await finished.promise; f.events.push('reset'); };
  const reset = f.session.reset();
  await started.promise;
  const next = f.session.callTool('macuse', { code: 'after-reset', trackFocus: false });
  await Promise.resolve();
  assert.deepEqual(f.events, []);
  finished.resolve();
  await Promise.all([reset, next]);
  assert.deepEqual(f.events, ['reset', 'code']);
  await f.session.stop();
});

test('missing native focus coverage remains explicit without blocking a read-only result', async () => {
  const f = fixture();
  f.native.beginObservation = async () => { throw new Error('Compiler unavailable'); };
  const response = await f.session.callTool('macuse', { code: '42' });
  assert.equal(response.isError, false);
  assert.equal(response.details.macuse.focus.observationAvailable, false);
  assert.match(response.content.at(-1).text, /Compiler unavailable/);
  assert.equal(response.details.macuse.focus.isolationGuaranteed, false);
});

for (const mode of ['initial-disk', 'initial-memory', 'unknown', 'failed-action', 'missing-coverage', 'activation']) test(`Activity Monitor validation cleanup: ${mode}`, async () => {
  const original = mode === 'unknown' ? undefined : mode === 'initial-memory' ? 'Memory' : 'Disk';
  let current = original, mutations = 0;
  const tabs = () => ['CPU', 'Memory', 'Disk'].map((name, index) => ({ index: String(index), name, description: name, role: 'radio button', secondaryActions: ['Press'], value: current === name ? '1' : '0' }));
  const fixture = { runtime: { getObservation: () => ({ elements: tabs() }) }, callTool: async (_tool, input) => {
    const action = input.code.match(/performSecondaryAction\((\d+)/);
    if (action) { current = tabs()[Number(action[1])].name; mutations++; }
    const changed = mutations === 1 && action;
    return { ...result(), isError: mode === 'failed-action' && Boolean(changed), details: { macuse: { focus: { observationAvailable: mode !== 'missing-coverage', coverage: { applicationActivation: true, truncated: false }, before: { frontmost: { bundleId: 'user.editor' } }, after: { frontmost: { bundleId: 'user.editor' } }, transitions: mode === 'activation' && changed ? [{ kind: 'activation', app: { bundleId: 'com.apple.ActivityMonitor' } }] : [] } } } };
  } };
  const run = activityMonitorCheck(fixture, { strictFocus: true });
  if (['initial-disk', 'initial-memory'].includes(mode)) assert.equal((await run).restored, true);
  else await assert.rejects(run);
  assert.equal(current, original);
  assert.equal(mutations, ['unknown', 'missing-coverage'].includes(mode) ? 0 : 2);
});
