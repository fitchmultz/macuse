import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { nativeRequirementChecks } from '../macuse-doctor.mjs';

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
afterEach(() => {
  mock.restoreAll();
  syncBuiltinESMExports();
  Object.defineProperty(process, 'platform', platformDescriptor);
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
