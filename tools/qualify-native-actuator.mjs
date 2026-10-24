#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const activityMonitorApp = 'com.apple.ActivityMonitor';
const tabs = new Set(['CPU', 'Memory', 'Energy', 'Disk', 'Network']);
const activityMonitorSafetyNote = 'Activity Monitor only: select a named tab and restore its observed original selection. Never stop processes, open Inspector, or use process actions.';

function observedTab(observation, original, app) {
  assert.equal(observation.fullSnapshot, true, 'A complete native snapshot is required');
  assert.equal(observation.app?.bundleId, app, 'The observed app must match the exact proof target');
  assert.ok(observation.observationId, 'Missing native observation identity');
  const selected = observation.elements.filter(element => element.role === 'AXRadioButton'
    && tabs.has(element.description || element.title) && [1, '1', true].includes(element.value));
  assert.equal(selected.length, 1, 'The actual original/selected tab is unknown');
  const element = selected[0];
  const window = observation.windows.find(window => window.token === element.windowToken);
  assert.ok(window, 'Selected tab is not bound to an observed window');
  if (original) {
    assert.equal(observation.app.pid, original.pid, 'Observed app process changed');
    assert.equal(window.token, original.window.token, 'Observed window changed');
    assert.equal(window.title, original.window.title, 'Observed window title changed');
    assert.equal(window.document, original.window.document, 'Observed document changed');
  }
  return { name: element.description || element.title, element, window };
}

function tabTarget(observation, name, windowToken) {
  const matches = observation.elements.filter(element => element.role === 'AXRadioButton'
    && (element.description || element.title) === name && element.windowToken === windowToken);
  assert.equal(matches.length, 1, `Expected exactly one ${name} tab in the original window`);
  assert.ok(matches[0].actions.includes('AXPress'), `The ${name} tab does not expose AXPress`);
  return matches[0];
}

function screenshotEvidence(result, window) {
  assert.equal(result.coordinateSpace, 'screenshot-pixels');
  assert.equal(result.windowToken, window.token);
  assert.equal(result.image?.mimeType, 'image/png');
  const bytes = Buffer.from(result.image.data, 'base64');
  assert.ok(bytes.length >= 24, 'Screenshot is too short for a PNG header');
  assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), 'Screenshot bytes are not PNG');
  assert.equal(bytes.toString('ascii', 12, 16), 'IHDR');
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  assert.ok(width > 0 && height > 0, 'Screenshot dimensions are empty');
  assert.equal(result.image.width, width, 'Reported width differs from PNG bytes');
  assert.equal(result.image.height, height, 'Reported height differs from PNG bytes');
  assert.deepEqual(result.windowFrame, window.frame, 'Screenshot belongs to a different window frame');
  assert.ok(Number.isFinite(result.pointPixelScale) && result.pointPixelScale > 0, 'Missing pixel-to-point scale');
  assert.ok(result.captureRect && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(result.captureRect[key]))
    && result.captureRect.width > 0 && result.captureRect.height > 0, 'Missing screenshot capture rectangle');
  assert.ok(Math.abs(width - result.captureRect.width * result.pointPixelScale) <= 0.5
    && Math.abs(height - result.captureRect.height * result.pointPixelScale) <= 0.5,
  'PNG dimensions disagree with the reported capture rectangle and pixel scale');
  return { width, height, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
    windowFrame: result.windowFrame, captureRect: result.captureRect, pointPixelScale: result.pointPixelScale,
    coordinateSpace: result.coordinateSpace, visualContentVerified: false };
}

/** A bounded live proof, not full native or execution qualification. The caller owns stop(). */
async function qualifyTabs(actuator, { app, safetyNote, scope, expectedPid, expectedTitle }) {
  const checks = [], failures = [];
  let original, mutationRequested = false;
  const observe = () => actuator.observe({ app });
  const request = (observation, element, allowMutating = true) => ({ app,
    observationId: observation.observationId, elementToken: element.token, action: 'press', allowMutating, safetyNote });
  const press = async (observation, name) => {
    const target = tabTarget(observation, name, original.window.token);
    mutationRequested = true;
    const result = await actuator.act(request(observation, target));
    assert.equal(result.status, 'applied', 'Native press did not complete; inspect fresh state, do not replay');
    assert.equal(result.mutationAttempted, true);
    assert.equal(result.nativeAccepted, true);
    return result;
  };
  try {
    let observation = await observe();
    const selected = observedTab(observation, undefined, app);
    if (expectedPid !== undefined) assert.equal(observation.app.pid, expectedPid, 'Fixture process identity changed');
    if (expectedTitle !== undefined) assert.equal(selected.window.title, expectedTitle, 'Fixture window identity changed');
    original = { name: selected.name, pid: observation.app.pid, window: selected.window };
    checks.push({ name: 'complete observation and known original tab', status: 'pass', originalTab: original.name });
    const screenshot = await actuator.screenshot({ app, observationId: observation.observationId, windowToken: original.window.token });
    checks.push({ name: 'window-bound PNG metadata', status: 'pass', detail: screenshotEvidence(screenshot, original.window) });
    observation = await observe();
    observedTab(observation, original, app);
    const alternate = original.name === 'Memory' ? 'CPU' : 'Memory';
    const target = tabTarget(observation, alternate, original.window.token);
    mutationRequested = true;
    let refused = false;
    try { await actuator.act(request(observation, target, false)); }
    catch (error) {
      assert.equal(error.dispatched, false, 'Unauthorized request may have dispatched');
      assert.equal(error.mutationAttempted, false, 'Unauthorized request may have mutated');
      refused = true;
    }
    assert.equal(refused, true, 'Missing mutation authorization was not refused');
    checks.push({ name: 'missing authorization refused before dispatch', status: 'pass' });
    observation = await observe();
    assert.equal(observedTab(observation, original, app).name, original.name, 'Refused action changed the selected tab');
    await press(observation, alternate);
    observation = await observe();
    assert.equal(observedTab(observation, original, app).name, alternate, 'Native press result was not observed');
    checks.push({ name: 'AXPress independently observed', status: 'pass', selectedTab: alternate });
  } catch (error) {
    failures.push(error);
  } finally {
    if (original) {
      try {
        let observation = await observe();
        const current = observedTab(observation, original, app);
        // Fresh, known state makes restoration a new bounded action, not a retry of an uncertain press.
        if (mutationRequested && current.name !== original.name) {
          await press(observation, original.name);
          observation = await observe();
        }
        assert.equal(observedTab(observation, original, app).name, original.name, 'Original tab was not restored');
        checks.push({ name: 'original tab independently verified', status: 'pass', restoredTab: original.name });
      } catch (error) { failures.push(new Error(`Cleanup failed: ${error.message}`)); }
    }
  }
  for (const error of failures) checks.push({ name: 'qualification failure', status: 'fail', detail: error.message });
  return { ok: failures.length === 0, scope,
    fullNativeQualification: false, chatgptIndependenceQualified: false, checks,
    unattempted: ['Visual screenshot content and pointer-coordinate action mapping', 'Unicode selection preservation',
      'Keyboard/pointer focus and transition coverage', 'Replaced-window and cross-app negative controls beyond the fixture context challenge',
      'Native abort/timeout and unknown-outcome lifecycle', 'Independent persistent sandboxed execution',
      'Fresh Pi, CLI, and MCP end-to-end paths', 'Recording and Computer History independence'] };
}

export function qualifyActivityMonitor(actuator) {
  return qualifyTabs(actuator, { app: activityMonitorApp, safetyNote: activityMonitorSafetyNote,
    scope: 'experimental-native-activity-monitor-slice' });
}

async function qualifyFixtureText(actuator, challenger, fixture) {
  const checks = [];
  const replacement = 'prefix 独立 👩🏽‍💻 e\u0301 suffix';
  let original;
  const observe = () => actuator.observe({ app: fixture.app });
  const field = observation => {
    const matches = observation.elements.filter(element => element.identifier === 'macuse-fixture-field'
      && element.windowToken === original.window.token);
    assert.equal(matches.length, 1, 'Expected one owned fixture text field');
    assert.equal(matches[0].role, 'AXTextField');
    assert.equal(matches[0].valueSettable, true);
    assert.equal(typeof matches[0].value, 'string');
    if (original.field) assert.equal(matches[0].token, original.field.token, 'Fixture text field identity changed');
    return matches[0];
  };
  const setValue = (observation, target, value) => actuator.act({ app: fixture.app,
    observationId: observation.observationId, elementToken: target.token, action: 'setValue', value,
    allowMutating: true, safetyNote: 'Owned disposable macuse fixture text field only: replace its complete test value and restore its captured original. No user document or selected-range claim.' });
  try {
    let observation = await observe();
    const selected = observedTab(observation, undefined, fixture.app);
    assert.equal(observation.app.pid, fixture.pid, 'Fixture process identity changed');
    assert.equal(selected.window.title, fixture.title, 'Fixture window identity changed');
    original = { name: selected.name, pid: fixture.pid, window: selected.window };
    original.field = field(observation);
    const challenge = await challenger.observe({ app: fixture.app });
    const challengeTab = observedTab(challenge, undefined, fixture.app);
    assert.equal(challenge.app.pid, fixture.pid);
    assert.equal(challengeTab.window.title, fixture.title);
    const alternate = original.name === 'Memory' ? 'CPU' : 'Memory';
    const pressed = await challenger.act({ app: fixture.app, observationId: challenge.observationId,
      elementToken: tabTarget(challenge, alternate, challengeTab.window.token).token, action: 'press',
      allowMutating: true, safetyNote: 'Owned disposable fixture only: change a radio control to invalidate the other helper observation, then restore its captured original selection.' });
    assert.equal(pressed.nativeAccepted, true);
    await assert.rejects(setValue(observation, original.field, replacement), error =>
      error.dispatched === false && error.mutationAttempted === false && /app context.*changed/i.test(error.message),
    'Changed fixture context must reject the stale field edit before dispatch');
    checks.push({ name: 'changed fixture context refused before field dispatch', status: 'pass' });
    observation = await observe();
    assert.equal(observedTab(observation, original, fixture.app).name, alternate, 'Context challenge did not change the actual radio state');
    assert.equal(field(observation).value, original.field.value, 'Refused stale edit changed the field');
    const result = await setValue(observation, field(observation), replacement);
    assert.equal(result.status, 'applied');
    assert.equal(result.nativeAccepted, true);
    assert.equal(result.verified, true);
    observation = await observe();
    observedTab(observation, original, fixture.app);
    assert.equal(field(observation).value, replacement, 'Unicode whole-field readback differs');
    checks.push({ name: 'Unicode whole-field value independently observed', status: 'pass', selectedRangeQualified: false });
  } catch (error) { checks.push({ name: 'fixture text qualification failure', status: 'fail', detail: error.message }); }
  finally {
    if (original?.field) {
      try {
        let observation = await observe();
        observedTab(observation, original, fixture.app);
        const current = field(observation);
        assert.ok([original.field.value, replacement].includes(current.value), 'Fixture field changed to an unexpected value; refusing cleanup overwrite');
        if (current.value !== original.field.value) {
          const restored = await setValue(observation, current, original.field.value);
          assert.equal(restored.verified, true);
          observation = await observe();
          observedTab(observation, original, fixture.app);
        }
        assert.equal(field(observation).value, original.field.value, 'Original fixture field value was not restored');
        if (observedTab(observation, original, fixture.app).name !== original.name) {
          const restored = await actuator.act({ app: fixture.app, observationId: observation.observationId,
            elementToken: tabTarget(observation, original.name, original.window.token).token, action: 'press',
            allowMutating: true, safetyNote: 'Owned disposable fixture only: restore its captured original radio selection after the stale-context test.' });
          assert.equal(restored.nativeAccepted, true);
          observation = await observe();
        }
        assert.equal(observedTab(observation, original, fixture.app).name, original.name);
        assert.equal(field(observation).value, original.field.value);
        checks.push({ name: 'original fixture text and radio state independently verified', status: 'pass' });
      } catch (error) { checks.push({ name: 'fixture text cleanup failure', status: 'fail', detail: error.message }); }
    }
  }
  return checks;
}

export async function qualifyActuatorFixture(actuator, fixture, { challenger } = {}) {
  assert.match(fixture.app, /^com\.macuse\.actuator-fixture\.[0-9a-f-]{36}$/, 'An exact task-owned fixture identity is required');
  assert.ok(Number.isSafeInteger(fixture.pid) && fixture.pid > 0, 'Fixture PID is required');
  assert.equal(fixture.title, 'macuse disposable actuator fixture');
  const report = await qualifyTabs(actuator, { app: fixture.app, expectedPid: fixture.pid, expectedTitle: fixture.title,
    safetyNote: 'Task-owned disposable macuse fixture only: select an alternate radio control and restore its actual original selection. No user apps or documents.',
    scope: 'experimental-owned-native-fixture-slice' });
  if (report.ok && challenger) {
    report.checks.push(...await qualifyFixtureText(actuator, challenger, fixture));
    report.ok = report.checks.every(check => check.status === 'pass');
  } else report.unattempted.push('Fixture stale-context and Unicode whole-field checks');
  return report;
}

async function main() {
  const { values } = parseArgs({ options: { live: { type: 'boolean' }, fixture: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } });
  if (values.help || !values.live) {
    console.log('Experimental native proof: node tools/qualify-native-actuator.mjs --live [--fixture]\nDefault: authorized Activity Monitor tab selection/restoration. --fixture: launch, exercise, and dispose an owned real AppKit test app instead; not real-world app parity. Native permissions required. No recording, vendor runtime, or default-backend changes. Without --live, no desktop access occurs.');
    if (!values.help) process.exitCode = 1;
    return;
  }
  const { NativeActuator } = await import('./native-actuator.mjs');
  const actuator = new NativeActuator();
  const challenger = values.fixture ? new NativeActuator() : undefined;
  let report, fixture;
  try {
    if (values.fixture) {
      const { startActuatorFixture } = await import('./actuator-fixture.mjs');
      fixture = await startActuatorFixture();
    }
    report = fixture ? await qualifyActuatorFixture(actuator, fixture, { challenger }) : await qualifyActivityMonitor(actuator);
  } finally {
    try { await Promise.all([actuator.stop(), challenger?.stop()]); }
    finally { await fixture?.stop(); }
  }
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
