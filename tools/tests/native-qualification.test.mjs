import assert from 'node:assert/strict';
import test from 'node:test';
import { qualifyActivityMonitor, qualifyActuatorFixture } from '../qualify-native-actuator.mjs';

// Scripted observations exercise runner cleanup/reporting, not native guards, app behavior, or permissions.
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8ioAAAAASUVORK5CYII=';
function activity({ failAfterApply = false, replaceWindow = false, corruptImage, app = 'com.apple.ActivityMonitor',
  title = 'Activity Monitor', path = '/fixture/ActuatorFixture.app', fixtureText = false,
  failAfterTextApply = false, falselyVerifyContextDrift = false } = {}) {
  let selected = 'Energy', sequence = 0, attempted = false, revision = 0, text = 'prefix ORIGINAL suffix', textFailed = false;
  let contextText = 'postwrite ORIGINAL';
  const observations = new Map(), actions = [];
  const window = { token: 'original-window', title, document: null, frame: { x: 0, y: 0, width: 800, height: 600 } };
  return {
    actions,
    async observe({ expectedPid, expectedPath } = {}) {
      if ((expectedPid !== undefined && expectedPid !== 123) || (expectedPath !== undefined && expectedPath !== path)) {
        throw Object.assign(new Error('Trusted app PID/path identity mismatch; no AX content was read'),
          { dispatched: false, mutationAttempted: false });
      }
      const observationId = `snapshot-${++sequence}`;
      observations.set(observationId, revision);
      const current = replaceWindow && attempted ? { ...window, token: 'replacement-window' } : window;
      const elements = ['CPU', 'Memory', 'Energy'].map(title => ({ token: title, windowToken: current.token,
        role: 'AXRadioButton', title, description: '', value: title === selected ? 1 : 0, actions: ['AXPress'] }));
      if (fixtureText) elements.push({ token: 'field', identifier: 'macuse-fixture-field', windowToken: current.token,
        role: 'AXTextField', value: text, valueSettable: true }, {
        token: 'context-field', identifier: 'macuse-fixture-context-field', windowToken: current.token,
        role: 'AXTextField', value: contextText, valueSettable: true });
      return { observationId, fullSnapshot: true, app: { bundleId: app, pid: 123, path }, windows: [current], elements };
    },
    async screenshot() {
      return { coordinateSpace: 'screenshot-pixels', windowToken: window.token, windowFrame: window.frame,
        captureRect: { x: 0, y: 0, width: 1, height: 1 }, pointPixelScale: corruptImage === 'scale' ? 2 : 1,
        image: { mimeType: 'image/png', data: png, width: corruptImage === 'width' ? 2 : 1, height: 1 } };
    },
    async act(request) {
      if (!request.allowMutating) throw Object.assign(new Error('Missing mutation authorization'),
        { dispatched: false, mutationAttempted: false });
      if (observations.get(request.observationId) !== revision) throw Object.assign(new Error('Observed app context changed'),
        { dispatched: false, mutationAttempted: false });
      revision++;
      if (request.action === 'setValue') {
        actions.push(`setValue:${request.value}`);
        if (request.elementToken === 'context-field') {
          contextText = request.value;
          const drifted = selected !== 'CPU';
          selected = 'CPU';
          if (drifted && !falselyVerifyContextDrift) return { status: 'unverified', mutationAttempted: true,
            nativeAccepted: true, verified: false, outcome: 'unknown' };
          return { status: 'applied', mutationAttempted: true, nativeAccepted: true, verified: true };
        }
        text = request.value;
        if (failAfterTextApply && !textFailed) {
          textFailed = true;
          throw Object.assign(new Error('Lost field acknowledgement'), { dispatched: true, mutationAttempted: true });
        }
        return { status: 'applied', mutationAttempted: true, nativeAccepted: true, verified: true };
      }
      actions.push(request.elementToken);
      selected = request.elementToken;
      attempted = true;
      if (failAfterApply && actions.length === 1) throw Object.assign(new Error('Lost acknowledgement after dispatch'),
        { dispatched: true, mutationAttempted: true });
      return { status: 'applied', mutationAttempted: true, nativeAccepted: true, verified: false };
    },
  };
}

test('qualification restores the actual non-CPU original tab and does not claim full independence', async () => {
  const actuator = activity();
  const result = await qualifyActivityMonitor(actuator);
  assert.equal(result.ok, true);
  assert.deepEqual(actuator.actions, ['Memory', 'Energy']);
  assert.equal(result.checks.find(check => check.name === 'original tab independently verified').restoredTab, 'Energy');
  assert.equal(result.fullNativeQualification, false);
  assert.equal(result.chatgptIndependenceQualified, false);
  assert.ok(result.unattempted.includes('Independent persistent sandboxed execution'));
});

test('owned-fixture qualification refuses borrowed app or mismatched process identity before mutation', async () => {
  await assert.rejects(qualifyActuatorFixture(activity(), { app: 'com.apple.ActivityMonitor' }), /task-owned fixture/);
  const fixture = { app: 'com.macuse.actuator-fixture.11111111-1111-4111-8111-111111111111',
    pid: 124, path: '/fixture/ActuatorFixture.app', title: 'macuse disposable actuator fixture' };
  const actuator = activity(fixture);
  const result = await qualifyActuatorFixture(actuator, fixture);
  assert.equal(result.ok, false);
  assert.deepEqual(actuator.actions, []);
  assert.ok(result.checks.some(check => check.status === 'fail' && /identity mismatch/.test(check.detail)));
});

test('lost acknowledgement fails proof without replaying the attempted press; known fresh state can be restored', async () => {
  const actuator = activity({ failAfterApply: true });
  const result = await qualifyActivityMonitor(actuator);
  assert.equal(result.ok, false);
  assert.deepEqual(actuator.actions, ['Memory', 'Energy']);
  assert.match(result.checks.find(check => check.status === 'fail').detail, /Lost acknowledgement/);
  assert.ok(result.checks.some(check => check.restoredTab === 'Energy'));
});

test('lost whole-field acknowledgement restores only the known fixture value without replaying Unicode replacement', async () => {
  const fixture = { app: 'com.macuse.actuator-fixture.11111111-1111-4111-8111-111111111111',
    pid: 123, path: '/fixture/ActuatorFixture.app', title: 'macuse disposable actuator fixture' };
  const actuator = activity({ ...fixture, fixtureText: true, failAfterTextApply: true });
  const result = await qualifyActuatorFixture(actuator, fixture, { challenger: actuator });
  assert.equal(result.ok, false);
  assert.deepEqual(actuator.actions.filter(action => action.startsWith('setValue:')),
    ['setValue:prefix 独立 👩🏽‍💻 e\u0301 suffix', 'setValue:prefix ORIGINAL suffix']);
  assert.ok(result.checks.some(check => check.status === 'fail' && /Lost field acknowledgement/.test(check.detail)));
  assert.ok(result.checks.some(check => check.name === 'original fixture text and radio state independently verified'));
});

test('a falsely verified context-changing setter fails qualification and still restores both fields', async () => {
  const fixture = { app: 'com.macuse.actuator-fixture.11111111-1111-4111-8111-111111111111',
    pid: 123, path: '/fixture/ActuatorFixture.app', title: 'macuse disposable actuator fixture' };
  const actuator = activity({ ...fixture, fixtureText: true, falselyVerifyContextDrift: true });
  const result = await qualifyActuatorFixture(actuator, fixture, { challenger: actuator });
  assert.equal(result.ok, false);
  assert.ok(result.checks.some(check => check.status === 'fail' && /Context drift during the setter/.test(check.detail)));
  assert.ok(result.checks.some(check => check.name === 'original fixture text and radio state independently verified'));
  assert.deepEqual(actuator.actions.filter(action => action.startsWith('setValue:')), [
    'setValue:prefix 独立 👩🏽‍💻 e\u0301 suffix', 'setValue:postwrite MUTATED 🧪',
    'setValue:prefix ORIGINAL suffix', 'setValue:postwrite ORIGINAL',
  ]);
});

test('replacement window blocks cleanup rather than mutating a similarly named window', async () => {
  const actuator = activity({ replaceWindow: true });
  const result = await qualifyActivityMonitor(actuator);
  assert.equal(result.ok, false);
  assert.deepEqual(actuator.actions, ['Memory']);
  assert.ok(result.checks.some(check => check.status === 'fail' && /Cleanup failed: Observed window changed/.test(check.detail)));
  assert.equal(result.checks.some(check => check.restoredTab), false);
});

for (const [corruptImage, reason] of [['width', /Reported width differs/], ['scale', /dimensions disagree/]]) test(`screenshot ${corruptImage} mismatch fails before an authorized mutation`, async () => {
  const actuator = activity({ corruptImage });
  const result = await qualifyActivityMonitor(actuator);
  assert.equal(result.ok, false);
  assert.deepEqual(actuator.actions, []);
  assert.ok(result.checks.some(check => check.status === 'fail' && reason.test(check.detail)));
});
