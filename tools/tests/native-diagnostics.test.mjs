import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { createJiti } from 'jiti';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { BridgeComputerUseSession } from '../cu-helpers.mjs';
import { nativeRequirementChecks } from '../macuse-doctor.mjs';

const jiti = createJiti(import.meta.url);
const { executeSequence } = await jiti.import('../../extensions/codex-computer-use-modules/sequence-runner.ts');
const { macosNative } = await jiti.import('../../extensions/codex-computer-use-modules/macos-focus.ts');
const { ComputerUseError } = await jiti.import('../../extensions/codex-computer-use-modules/core.ts');
const { computerUseDiagnostic, failureResult } = await jiti.import('../../extensions/codex-computer-use-modules/diagnostics.ts');
const { focusSnapshot, focusSummaryText } = await jiti.import('../../extensions/codex-computer-use-modules/apps.ts');
const snapshot = { frontmost: null, focusedWindow: null };
const observation = { before: snapshot, after: snapshot, transitions: [], coverage: { applicationActivation: true, focusedWindow: {}, truncated: false, inputAttribution: false, windowDetails: 'targetAppsOnly' } };
const nativeState = { pid: 4242, accessibilityTrusted: true, focusedWindow: { token: 'w', title: 'A.txt', document: 'file:///tmp/A.txt' }, focusedElement: { token: 'e', selectedTextSettable: false, selectedTextError: 0 } };
const tree = 'App=/Test.app (bundleID test.app, pid 4242)\nWindow: "A.txt", App: Test.\n0 standard window A.txt, URL: file:///tmp/A.txt\n1 text field (settable) ID: editor, Value: old\n</app_state>';
const result = text => ({ content: [{ type: 'text', text }] });
const wrap = text => ({ result: result(text), durationMs: 1, acceptedElicitations: 0, elicitationCount: 0 });
beforeEach(() => {
  mock.method(macosNative, 'beginObservation', async () => ({ id: 'observation', before: snapshot }));
  mock.method(macosNative, 'endObservation', async () => observation);
  mock.method(macosNative, 'inspectApp', async () => nativeState);
  mock.method(macosNative, 'replaceSelectedText', async () => { throw new Error('Unexpected native mutation'); });
  mock.method(macosNative, 'stop', async () => {});
});
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
afterEach(() => {
  mock.restoreAll();
  syncBuiltinESMExports();
  Object.defineProperty(process, 'platform', platformDescriptor);
});

function sequence(replies, steps = [{ tool: 'type_text', arguments: { text: 'café' } }]) {
  const calls = [];
  const client = {
    async callTool(tool) { calls.push(tool); const next = replies.shift(); if (next instanceof Error) throw next; assert.ok(next, `Unexpected ${tool}`); return next; },
    status() { return { threadId: 'fixture', stderrTail: '', computerUseRecoveryEvents: [] }; },
  };
  return { calls, pending: executeSequence({ app: 'Test', steps, allowMutating: true, safetyNote: 'Only the disposable fixture; stop before any other changes.', detail: 'minimal' }, undefined, undefined, () => client, new Map()) };
}

for (const [label, inspect, expected] of [
  ['compile failure', async () => { throw new Error('Native helper compilation failed: swiftc unavailable'); }, /compilation failed: swiftc unavailable/],
  ['timeout', async () => { throw new Error('Native inspectApp timed out; its outcome is unknown.'); }, /Native inspectApp timed out/],
  ['untrusted AX', async () => ({ ...nativeState, accessibilityTrusted: false }), /accessibilityTrusted=false/],
  ['AX read error', async () => ({ ...nativeState, focusedElement: { ...nativeState.focusedElement, selectedTextError: -25204 } }), /AX error -25204/],
  ['unsupported control', async () => nativeState, /does not support.*AXSelectedText is not settable/],
  ['unsupported attribute', async () => ({ ...nativeState, focusedElement: { ...nativeState.focusedElement, selectedTextError: -25205 } }), /does not support.*AXSelectedText unsupported/],
  ['window read error', async () => ({ ...nativeState, focusedWindow: null, windowsError: -25204 }), /window inspection failed.*AX error -25204/],
]) {
  test(`Unicode refusal preserves ${label} in Pi and bridge without dispatch`, async () => {
    mock.method(macosNative, 'inspectApp', inspect);
    const f = sequence([wrap(tree)]);
    const pi = await f.pending;
    assert.match(pi.details.computerUse.failed.message, expected);
    assert.equal(pi.details.computerUse.failed.dispatched, false);
    assert.deepEqual(f.calls, ['get_app_state']);
    if (!label.startsWith('unsupported')) assert.doesNotMatch(pi.details.computerUse.failed.message, /does not support/);
    const calls = [];
    const bridge = new BridgeComputerUseSession(async tool => { calls.push(tool); return result(tree); }, { native: macosNative });
    await assert.rejects(bridge.run('type_text', { app: 'Test', text: 'café' }), error => {
      assert.match(error.message, expected);
      assert.equal(error.details.dispatched, false);
      return true;
    });
    assert.deepEqual(calls, ['get_app_state']);
    assert.equal(macosNative.replaceSelectedText.mock.calls.length, 0);
  });
}

test('unsupported insertion preserves the helper capability reason', async () => {
  mock.method(macosNative, 'inspectApp', async () => ({ ...nativeState, focusedElement: { ...nativeState.focusedElement, selectedTextSettable: true } }));
  mock.method(macosNative, 'replaceSelectedText', async () => ({ status: 'unsupported', mutationAttempted: false, reason: 'AXSelectedText is unavailable for this selection' }));
  const pi = await sequence([wrap(tree)]).pending;
  assert.match(pi.details.computerUse.failed.message, /unsupported: AXSelectedText is unavailable for this selection/);
  assert.equal(pi.details.computerUse.failed.dispatched, false);
});

for (const method of ['beginObservation', 'endObservation']) {
  test(`${method} failure remains unknown focus and preserves its reason`, async () => {
    const reason = `Native ${method} timed out`;
    mock.method(macosNative, method, async () => { throw new Error(reason); });
    const pi = await sequence([wrap(tree)], [{ tool: 'get_app_state' }]).pending;
    const focus = pi.details.computerUse.focus;
    assert.equal(focus.observationAvailable, false);
    assert.equal(focus.observationError, reason);
    assert.equal(focus.changed, null);
    assert.match(pi.content.map(block => block.text).join('\n'), new RegExp(reason));
    const bridge = new BridgeComputerUseSession(async () => result(tree), { native: macosNative });
    const response = await bridge.run('get_app_state', { app: 'Test' });
    assert.equal(response.focus.observationAvailable, false);
    assert.equal(response.focus.observationError, reason);
    assert.equal(response.focus.changed, null);
  });
}

test('close verification preserves native inspection failure without reopening or replaying', async () => {
  mock.method(macosNative, 'inspectApp', async () => { throw new Error('Native inspectApp timed out'); });
  const f = sequence([wrap(tree), wrap('Closed')], [{ tool: 'press_key', arguments: { key: 'super+w' }, requireStateChange: true }]);
  const pi = await f.pending;
  assert.match(pi.details.computerUse.failed.message, /Native inspectApp timed out/);
  assert.equal(pi.details.computerUse.failed.dispatched, true);
  assert.deepEqual(f.calls, ['get_app_state', 'press_key']);
  const calls = [];
  const bridge = new BridgeComputerUseSession(async tool => { calls.push(tool); return result(tool === 'get_app_state' ? tree : 'Closed'); }, { native: macosNative });
  await assert.rejects(bridge.run('press_key', { app: 'Test', key: 'super+w', requireStateChange: true }), error => {
    assert.match(error.message, /Native inspectApp timed out/);
    assert.equal(error.details.dispatched, true);
    return true;
  });
  assert.deepEqual(calls, ['get_app_state', 'press_key']);
});

test('unavailable focus endpoints do not imply that the target stayed background', () => {
  const text = focusSummaryText({ ...focusSnapshot(null, null), observationAvailable: false, observationError: 'Compiler missing' }, 'Test');
  assert.match(text, /frontmostChanged=unknown/);
  assert.match(text, /targetAppFrontmostAfter=unknown/);
  assert.match(text, /targetAppBecameFrontmost=unknown/);
  assert.match(text, /Compiler missing/);
});

const queueMessage = 'Computer Use call timed out while waiting for the previous request; no new action was sent.';
test('queued timeout explains prior ownership, not a dispatched current action', async () => {
  const diagnostic = computerUseDiagnostic(failureResult(queueMessage, 5000), 'press_key', { app: 'Test' }, { dispatched: false });
  assert.match(diagnostic, /previous pending RPC still owns the queue/);
  assert.match(diagnostic, /\/macuse-stop/);
  assert.match(diagnostic, /Then get_app_state again/);
  assert.doesNotMatch(diagnostic, /A dispatched action may already have taken effect|macuse.restart/);
  const error = new ComputerUseError(queueMessage, { dispatched: false, outcomeUnknown: false, reason: 'timeout' });
  const f = sequence([wrap(tree), error], [{ tool: 'press_key', arguments: { key: 'a' } }]);
  const pi = await f.pending;
  assert.equal(pi.details.computerUse.failed.dispatched, false);
  assert.equal(pi.details.computerUse.steps[0].outcome, 'reported');
  assert.match(pi.details.computerUse.steps[0].nextActions.join('\n'), /previous pending RPC still owns/);
  assert.doesNotMatch(pi.content.map(block => block.text).join('\n'), /action was dispatched and may already/);
});

test('a queued readback does not erase an already dispatched mutation', async () => {
  const error = new ComputerUseError(queueMessage, { dispatched: false, outcomeUnknown: false });
  const f = sequence([wrap(tree), wrap('Typed'), error], [{ tool: 'type_text', arguments: { text: 'ascii' } }]);
  const pi = await f.pending;
  assert.equal(pi.details.computerUse.failed.dispatched, true);
  assert.match(pi.details.computerUse.steps[0].nextActions.join('\n'), /may already have taken effect/);
  assert.equal(pi.details.computerUse.resumeFromStepIndex, null);
});

test('generic timeout diagnostics respect known dispatch metadata', () => {
  const failure = failureResult('timed out after 1000ms', 5000);
  assert.match(computerUseDiagnostic(failure, 'click', {}), /may already have taken effect/);
  assert.doesNotMatch(computerUseDiagnostic(failure, 'click', {}, { dispatched: false }), /may already have taken effect/);
  assert.equal(computerUseDiagnostic({ ...failure, isError: false }, 'click', {}), null);
});

function doctorRunner(responses, platform = 'darwin') {
  const calls = [];
  Object.defineProperty(process, 'platform', { ...platformDescriptor, value: platform });
  mock.method(childProcess, 'spawnSync', (command, args, opts) => {
    calls.push({ command, args, opts });
    const response = responses.shift();
    assert.ok(response, `Unexpected doctor command ${command}`);
    return { status: response.ok ? 0 : 1, stdout: response.stdout ?? '', stderr: response.stderr ?? '' };
  });
  syncBuiltinESMExports();
  return { calls };
}

test('doctor distinguishes missing compiler from unknown trust without attempting AX', () => {
  const f = doctorRunner([{ ok: false, stderr: 'xcrun: unable to find swiftc' }]);
  const checks = nativeRequirementChecks();
  assert.equal(checks[0].status, 'fail');
  assert.match(checks[0].summary, /unable to find swiftc/);
  assert.match(checks[1].summary, /Unknown.*not checked/);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].args, ['--find', 'swiftc']);
});

for (const trusted of [true, false, undefined]) {
  test(`doctor reports native Accessibility trust ${trusted} without permission prompts`, () => {
    const f = doctorRunner([{ ok: true, stdout: '/usr/bin/swiftc' }, { ok: true, stdout: JSON.stringify({ accessibilityTrusted: trusted }) }]);
    const checks = nativeRequirementChecks();
    assert.equal(checks[1].status, trusted === true ? 'pass' : 'fail');
    assert.match(checks[1].summary, trusted === undefined ? /trust is unknown/ : new RegExp(`accessibilityTrusted=${trusted}`));
    assert.equal(f.calls.length, 2);
    assert.ok(f.calls.every(call => call.opts.timeout > 0));
  });
}

test('doctor preserves native compile/runtime failure instead of diagnosing permission denial', () => {
  const f = doctorRunner([{ ok: true, stdout: '/usr/bin/swiftc' }, { ok: false, stderr: 'Native helper compilation failed: missing SDK' }]);
  const checks = nativeRequirementChecks();
  assert.equal(checks[1].status, 'fail');
  assert.match(checks[1].summary, /trust unknown.*compilation failed: missing SDK/);
  doctorRunner([], 'linux');
  assert.equal(nativeRequirementChecks()[0].status, 'fail');
});
