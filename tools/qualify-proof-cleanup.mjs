import assert from "node:assert/strict";
import { contextField, exited, ordinaryField, safetyNote } from "./qualify-proof-transport.mjs";
import { tab } from "./qualify-proof-checks.mjs";
import { allowedFieldValues } from "./qualify-proof-phases.mjs";

/** @typedef {import("./qualify-proof-phases.mjs").QualifyContext} QualifyContext */

/**
 * Restore one field's captured original value through the private observer.
 * Failure cleanup is a fresh bounded original-value restoration, never an
 * attempted-value replay.
 * @param {QualifyContext} qc
 * @param {string} identifier
 */
export async function cleanupOneField(qc, identifier) {
  let { observation, current } = await qc.observeActual();
  assert.ok(
    allowedFieldValues(qc, identifier).includes(current.fields[identifier]?.value),
    "Unexpected fixture field value; refusing cleanup overwrite",
  );
  if (current.fields[identifier]?.value === qc.original().fields[identifier]?.value) {
    return;
  }
  if (identifier === contextField && current.name !== "CPU") {
    await pressCpuTab(qc, observation);
    ({ observation, current } = await qc.observeActual());
  }
  const restored = await qc.observer.act({
    app: qc.fixture().app,
    observationId: observation.observationId,
    elementToken: current.fields[identifier]?.token,
    action: "setValue",
    value: qc.original().fields[identifier]?.value,
    allowMutating: true,
    safetyNote,
  });
  assert.equal(restored.verified, true);
}

/**
 * Press the fixture's CPU tab so the context field becomes writable again.
 * @param {QualifyContext} qc
 * @param {import("./qualify-proof-transport.mjs").ProofObservation} observation
 */
async function pressCpuTab(qc, observation) {
  await qc.observer.act({
    app: qc.fixture().app,
    observationId: observation.observationId,
    elementToken: tab(observation, "CPU").token,
    action: "press",
    allowMutating: true,
    safetyNote,
  });
}

/**
 * Restore and independently verify the original radio selection.
 * @param {QualifyContext} qc
 */
export async function cleanupOriginalRadio(qc) {
  const initialRead = await qc.observeActual();
  const observation = initialRead.observation;
  let { current } = initialRead;
  if (current.name !== qc.original().name) {
    await qc.observer.act({
      app: qc.fixture().app,
      observationId: observation.observationId,
      elementToken: tab(observation, qc.original().name ?? "").token,
      action: "press",
      allowMutating: true,
      safetyNote,
    });
    ({ current } = await qc.observeActual());
  }
  assert.equal(current.name, qc.original().name);
  for (const identifier of [ordinaryField, contextField]) {
    assert.equal(current.fields[identifier]?.value, qc.original().fields[identifier]?.value);
  }
}

/**
 * After a failed run, restore the original state through the private observer.
 * @param {QualifyContext} qc
 */
export async function cleanupOriginalState(qc) {
  try {
    for (const identifier of [contextField, ordinaryField]) {
      await cleanupOneField(qc, identifier);
    }
    await cleanupOriginalRadio(qc);
    qc.pass("independent final original-state verification");
  } catch (error) {
    qc.failures.push(
      `Original-state cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Stop the private observer and the owned fixture.
 * @param {QualifyContext} qc
 */
export async function stopOwnedProcesses(qc) {
  try {
    await qc.observer.stop();
  } catch (error) {
    qc.failures.push(
      `Observer stop failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (qc.hasFixture()) {
    try {
      const fixture = qc.fixture();
      await fixture.stop();
      assert.equal(exited(fixture.pid), true, "Owned fixture remains running");
      qc.pass("owned fixture exited");
    } catch (error) {
      qc.failures.push(
        `Fixture stop failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
