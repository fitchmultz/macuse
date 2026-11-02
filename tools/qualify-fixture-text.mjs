import assert from "node:assert/strict";
import {
  isActuatorRejection,
  isProofObservation,
  isRecord,
  observedTab,
  tabTarget,
} from "./qualify-actuator-observation.mjs";

/** @typedef {import("./qualify-actuator-observation.mjs").ActuatorLike} ActuatorLike */
/** @typedef {import("./qualify-actuator-observation.mjs").CheckRecord} CheckRecord */
/** @typedef {import("./qualify-actuator-observation.mjs").FixtureHandle} FixtureHandle */
/** @typedef {import("./qualify-actuator-observation.mjs").ObservedElement} ObservedElement */
/** @typedef {import("./qualify-actuator-observation.mjs").ObservedTabState} ObservedTabState */
/** @typedef {import("./qualify-actuator-observation.mjs").ProofObservation} ProofObservation */
/** @typedef {{ actuator: ActuatorLike, fixture: FixtureHandle }} FixtureActionContext */
/** @typedef {{ actuator: ActuatorLike, fixture: FixtureHandle, original: ObservedTabState, checks: CheckRecord[] }} FixtureTextContext */

const fixtureFieldSafetyNote =
  "Owned disposable macuse fixture text field only: replace its complete test value and restore its captured original. No user document or selected-range claim.";
const fixtureRadioSafetyNote =
  "Owned disposable fixture only: change a radio control to invalidate the other helper observation, then restore its captured original selection.";

/**
 * @param {ActuatorLike} actuator
 * @param {FixtureHandle} fixture
 * @returns {Promise<ProofObservation>}
 */
async function fixtureObserve(actuator, fixture) {
  const result = await actuator.observe({
    app: fixture.app,
    expectedPid: fixture.pid,
    expectedPath: fixture.path,
  });
  return isProofObservation(result) ? result : assert.fail("Invalid observation payload");
}

/**
 * @param {ProofObservation} observation
 * @param {string} identifier
 * @param {ObservedTabState} original
 * @returns {ObservedElement}
 */
function fixtureField(observation, identifier, original) {
  const matches = observation.elements.filter(
    (element) => element.identifier === identifier && element.windowToken === original.window.token,
  );
  assert.equal(matches.length, 1, "Expected one owned fixture text field");
  const target = matches[0];
  if (target === undefined) {
    assert.fail("Expected one owned fixture text field");
  }
  assert.equal(target.role, "AXTextField");
  assert.equal(target.valueSettable, true);
  assert.equal(typeof target.value, "string");
  const saved = identifier === "macuse-fixture-field" ? original.field : original.contextField;
  if (saved !== undefined) {
    assert.equal(target.token, saved.token, "Fixture text field identity changed");
  }
  return target;
}

/**
 * @param {FixtureActionContext} ctx
 * @param {ProofObservation} observation
 * @param {ObservedElement} target
 * @param {string} value
 * @returns {Promise<unknown>}
 */
function setFieldValue(ctx, observation, target, value) {
  return ctx.actuator.act({
    app: ctx.fixture.app,
    observationId: observation.observationId,
    elementToken: target.token,
    action: "setValue",
    value,
    allowMutating: true,
    safetyNote: fixtureFieldSafetyNote,
  });
}

/**
 * Capture the fixture's original tab state and both owned text fields.
 * @param {ActuatorLike} actuator
 * @param {FixtureHandle} fixture
 * @returns {Promise<{ observation: ProofObservation, original: ObservedTabState }>}
 */
async function captureFixtureOriginal(actuator, fixture) {
  const observation = await fixtureObserve(actuator, fixture);
  const selected = observedTab(observation, undefined, fixture.app);
  assert.equal(observation.app.pid, fixture.pid, "Fixture process identity changed");
  assert.equal(selected.window.title, fixture.title, "Fixture window identity changed");
  /** @type {ObservedTabState} */
  const original = { name: selected.name, pid: fixture.pid, window: selected.window };
  original.field = fixtureField(observation, "macuse-fixture-field", original);
  original.contextField = fixtureField(observation, "macuse-fixture-context-field", original);
  return { observation, original };
}

/**
 * Have the challenger helper press the alternate fixture radio tab.
 * @param {ActuatorLike} challenger
 * @param {FixtureHandle} fixture
 * @returns {Promise<{ alternate: string }>}
 */
async function pressChallengeTab(challenger, fixture) {
  const challengeResult = await challenger.observe({
    app: fixture.app,
    expectedPid: fixture.pid,
    expectedPath: fixture.path,
  });
  const challenge = isProofObservation(challengeResult)
    ? challengeResult
    : assert.fail("Invalid challenge observation");
  const challengeTab = observedTab(challenge, undefined, fixture.app);
  assert.equal(challenge.app.pid, fixture.pid);
  assert.equal(challengeTab.window.title, fixture.title);
  const alternate = challengeTab.name === "Memory" ? "CPU" : "Memory";
  const pressed = await challenger.act({
    app: fixture.app,
    observationId: challenge.observationId,
    elementToken: tabTarget(challenge, alternate, challengeTab.window.token).token,
    action: "press",
    allowMutating: true,
    safetyNote: fixtureRadioSafetyNote,
  });
  if (!isRecord(pressed)) {
    assert.fail("Invalid challenger action result");
  }
  assert.equal(pressed.nativeAccepted, true);
  return { alternate };
}

/**
 * The stale field edit (observed before the challenge press) must be refused
 * before dispatch once the fixture context changed.
 * @param {FixtureActionContext} ctx
 * @param {ProofObservation} observation
 * @param {ObservedElement} originalField
 * @param {string} replacement
 * @returns {Promise<void>}
 */
async function assertStaleContextRefusal(ctx, observation, originalField, replacement) {
  await assert.rejects(
    setFieldValue(ctx, observation, originalField, replacement),
    (/** @type {unknown} */ error) => {
      if (!isActuatorRejection(error)) {
        return false;
      }
      return (
        error.dispatched === false &&
        error.mutationAttempted === false &&
        /app context.*changed/i.test(error.message)
      );
    },
    "Changed fixture context must reject the stale field edit before dispatch",
  );
}

/**
 * Replace the primary field with a Unicode value and verify the whole-field
 * readback from a fresh observation.
 * @param {FixtureTextContext} ctx
 * @param {string} alternate
 * @param {string} replacement
 * @returns {Promise<ProofObservation>}
 */
async function applyUnicodeReplacement(ctx, alternate, replacement) {
  const { actuator, fixture, original, checks } = ctx;
  let observation = await fixtureObserve(actuator, fixture);
  assert.equal(
    observedTab(observation, original, fixture.app).name,
    alternate,
    "Context challenge did not change the actual radio state",
  );
  assert.equal(
    fixtureField(observation, "macuse-fixture-field", original).value,
    original.field?.value,
    "Refused stale edit changed the field",
  );
  const applied = await setFieldValue(
    ctx,
    observation,
    fixtureField(observation, "macuse-fixture-field", original),
    replacement,
  );
  if (!isRecord(applied)) {
    assert.fail("Invalid setValue result");
  }
  assert.equal(applied.status, "applied");
  assert.equal(applied.nativeAccepted, true);
  assert.equal(applied.verified, true);
  observation = await fixtureObserve(actuator, fixture);
  observedTab(observation, original, fixture.app);
  assert.equal(
    fixtureField(observation, "macuse-fixture-field", original).value,
    replacement,
    "Unicode whole-field readback differs",
  );
  checks.push({
    name: "Unicode whole-field value independently observed",
    status: "pass",
    selectedRangeQualified: false,
  });
  return observation;
}

/**
 * A context drift during the setter must come back attempted-but-unknown,
 * never verified.
 * @param {FixtureTextContext} ctx
 * @param {string} contextReplacement
 * @returns {Promise<ProofObservation>}
 */
async function applyContextDrift(ctx, contextReplacement) {
  const { actuator, fixture, original, checks } = ctx;
  let observation = await fixtureObserve(actuator, fixture);
  const changed = await setFieldValue(
    ctx,
    observation,
    fixtureField(observation, "macuse-fixture-context-field", original),
    contextReplacement,
  );
  if (!isRecord(changed)) {
    assert.fail("Invalid changed-field result");
  }
  assert.equal(changed.mutationAttempted, true);
  assert.equal(changed.nativeAccepted, true);
  assert.equal(
    changed.status,
    "unverified",
    "Context drift during the setter must not be reported as a verified edit",
  );
  assert.equal(changed.verified, false);
  assert.equal(changed.outcome, "unknown");
  observation = await fixtureObserve(actuator, fixture);
  assert.equal(
    observedTab(observation, original, fixture.app).name,
    "CPU",
    "Adversarial setter did not change the actual fixture context",
  );
  assert.equal(
    fixtureField(observation, "macuse-fixture-context-field", original).value,
    contextReplacement,
  );
  checks.push({
    name: "context drift during AX write retained as attempted and unknown",
    status: "pass",
  });
  return observation;
}

/**
 * Restore one fixture field if it drifted to the planned replacement value.
 * @param {FixtureTextContext} ctx
 * @param {ProofObservation} observation
 * @param {ObservedElement} saved
 * @param {string} planned
 * @returns {Promise<ProofObservation>}
 */
async function restoreOneFixtureField(ctx, observation, saved, planned) {
  const { actuator, fixture, original } = ctx;
  const current = fixtureField(observation, saved.identifier ?? "", original);
  assert.ok(
    [saved.value, planned].includes(current.value),
    "Fixture field changed to an unexpected value; refusing cleanup overwrite",
  );
  const savedValue = typeof saved.value === "string" ? saved.value : "";
  if (current.value !== saved.value) {
    const restoreResult = await setFieldValue(ctx, observation, current, savedValue);
    if (!isRecord(restoreResult)) {
      assert.fail("Invalid restore setValue result");
    }
    assert.equal(restoreResult.verified, true);
    const next = await fixtureObserve(actuator, fixture);
    observedTab(next, original, fixture.app);
    assert.equal(
      fixtureField(next, saved.identifier ?? "", original).value,
      savedValue,
      "Original fixture field value was not restored",
    );
    return next;
  }
  assert.equal(
    fixtureField(observation, saved.identifier ?? "", original).value,
    savedValue,
    "Original fixture field value was not restored",
  );
  return observation;
}

/**
 * Restore both fixture fields to their captured original values.
 * @param {FixtureTextContext} ctx
 * @param {string} replacement
 * @param {string} contextReplacement
 * @returns {Promise<ProofObservation>}
 */
async function restoreFixtureFields(ctx, replacement, contextReplacement) {
  const { actuator, fixture, original } = ctx;
  let observation = await fixtureObserve(actuator, fixture);
  observedTab(observation, original, fixture.app);
  /** @type {[ObservedElement | undefined, string][]} */
  const restores = [
    [original.field, replacement],
    [original.contextField, contextReplacement],
  ];
  for (const [saved, planned] of restores) {
    if (saved === undefined) {
      continue;
    }
    observation = await restoreOneFixtureField(ctx, observation, saved, planned);
  }
  return observation;
}

/**
 * Restore the original radio tab after the stale-context test.
 * @param {ActuatorLike} actuator
 * @param {FixtureHandle} fixture
 * @param {ObservedTabState} original
 * @param {ProofObservation} observation
 * @returns {Promise<ProofObservation>}
 */
async function restoreFixtureRadio(actuator, fixture, original, observation) {
  if (observedTab(observation, original, fixture.app).name === original.name) {
    return observation;
  }
  const restored = await actuator.act({
    app: fixture.app,
    observationId: observation.observationId,
    elementToken: tabTarget(observation, original.name ?? "", original.window.token).token,
    action: "press",
    allowMutating: true,
    safetyNote:
      "Owned disposable fixture only: restore its captured original radio selection after the stale-context test.",
  });
  if (!isRecord(restored)) {
    assert.fail("Invalid restore result");
  }
  assert.equal(restored.nativeAccepted, true);
  return fixtureObserve(actuator, fixture);
}

/**
 * Independently verify the restored fixture state and record the check.
 * @param {FixtureTextContext} ctx
 * @param {ProofObservation} restored
 */
function assertRestoredFixtureState(ctx, restored) {
  const { fixture, original, checks } = ctx;
  const originalTab = original;
  assert.equal(observedTab(restored, originalTab, fixture.app).name, originalTab.name);
  assert.equal(
    fixtureField(restored, "macuse-fixture-field", originalTab).value,
    originalTab.field?.value,
  );
  if (originalTab.contextField !== undefined) {
    assert.equal(
      fixtureField(restored, originalTab.contextField.identifier ?? "", originalTab).value,
      originalTab.contextField.value,
    );
  }
  checks.push({
    name: "original fixture text and radio state independently verified",
    status: "pass",
  });
}

/**
 * Restore the fixture's captured state after the qualification phases.
 * @param {FixtureTextContext} ctx
 * @param {string} replacement
 * @param {string} contextReplacement
 */
async function cleanupFixtureState(ctx, replacement, contextReplacement) {
  const { actuator, fixture, original, checks } = ctx;
  try {
    const observation = await restoreFixtureFields(ctx, replacement, contextReplacement);
    const restored = await restoreFixtureRadio(actuator, fixture, original, observation);
    assertRestoredFixtureState(ctx, restored);
  } catch (error) {
    checks.push({
      name: "fixture text cleanup failure",
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * @param {ActuatorLike} actuator
 * @param {ActuatorLike} challenger
 * @param {FixtureHandle} fixture
 * @returns {Promise<CheckRecord[]>}
 */
export async function qualifyFixtureText(actuator, challenger, fixture) {
  /** @type {CheckRecord[]} */
  const checks = [];
  const replacement = "prefix 独立 👩🏽‍💻 e\u0301 suffix";
  const contextReplacement = "postwrite MUTATED 🧪";
  /** @type {ObservedTabState | undefined} */
  let original;
  try {
    const captured = await captureFixtureOriginal(actuator, fixture);
    original = captured.original;
    const { alternate } = await pressChallengeTab(challenger, fixture);
    // tsgo requires this guard (optional field) while tsgolint resolves the
    // same property as non-optional; both cannot be satisfied at once.
    const originalField = original.field;
    if (originalField === undefined) {
      assert.fail("missing original fixture field");
    }
    const ctx = { actuator, fixture, original, checks };
    await assertStaleContextRefusal(
      { actuator, fixture },
      captured.observation,
      originalField,
      replacement,
    );
    checks.push({ name: "changed fixture context refused before field dispatch", status: "pass" });
    await applyUnicodeReplacement(ctx, alternate, replacement);
    await applyContextDrift(ctx, contextReplacement);
  } catch (error) {
    checks.push({
      name: "fixture text qualification failure",
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
    });
  } finally {
    if (original !== undefined && original.field !== undefined) {
      await cleanupFixtureState(
        { actuator, fixture, original, checks },
        replacement,
        contextReplacement,
      );
    }
  }
  return checks;
}
