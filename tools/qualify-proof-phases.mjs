import assert from "node:assert/strict";
import {
  contextField,
  contextValue,
  ordinaryField,
  requireExited,
  resetTool,
  unicode,
} from "./qualify-proof-transport.mjs";
import {
  callCode,
  evidence,
  executionValue,
  imageReceipts,
  noMutation,
  state,
  tab,
  visible,
} from "./qualify-proof-checks.mjs";

/** @typedef {import("./qualify-proof-transport.mjs").TransportSpec} TransportSpec */
/** @typedef {import("./qualify-proof-transport.mjs").FixtureHandle} FixtureHandle */
/** @typedef {import("./qualify-proof-transport.mjs").ObservedState} ObservedState */
/** @typedef {import("./qualify-proof-transport.mjs").ProofObservation} ProofObservation */
/** @typedef {import("./qualify-proof-transport.mjs").ObservedElement} ObservedElement */
/** @typedef {import("./qualify-proof-transport.mjs").TransportClient} TransportClient */
/** @typedef {import("./qualify-proof-transport.mjs").TransportResult} TransportResult */
/** @typedef {import("./qualify-proof-transport.mjs").OwnedWorker} OwnedWorker */
/** @typedef {import("./qualify-proof-transport.mjs").NativeActionRecord} NativeActionRecord */
/** @typedef {import("./qualify-proof-transport.mjs").NativeActuatorLike} NativeActuatorLike */

/**
 * @typedef {{ spec: TransportSpec, root: string, observer: NativeActuatorLike, workers: Map<number, OwnedWorker>, checks: Array<{ name: string, status: string, detail?: unknown }>, failures: string[], alternate: string, fixture: () => FixtureHandle, client: () => TransportClient, original: () => ObservedState, hasFixture: () => boolean, hasOriginal: () => boolean, markClientClosed: () => void, closeClientIfOpen: () => Promise<void>, pass: (name: string, detail?: unknown) => void, run: (code: string, mutate?: boolean, timeoutMs?: number) => Promise<TransportResult>, observe: () => Promise<ProofObservation>, act: (observation: ProofObservation, element: ObservedElement, action: string, fieldValue?: unknown) => Promise<NativeActionRecord>, observeActual: () => Promise<{ observation: ProofObservation, current: ObservedState }>, rememberWorkers: () => Promise<OwnedWorker[]> }} QualifyContext
 */

/**
 * The values a fixture field may hold before a bounded original-value restore.
 * @param {QualifyContext} qc
 * @param {string} identifier
 * @returns {unknown[]}
 */
export function allowedFieldValues(qc, identifier) {
  return identifier === contextField
    ? [qc.original().fields[identifier]?.value, contextValue]
    : [qc.original().fields[identifier]?.value, unicode];
}

/**
 * Wrong-app and missing-flag mutations must be refused without native effect.
 * @param {QualifyContext} qc
 */
export async function assertScopeRefusal(qc) {
  const deniedScope = await qc.run(`${callCode("observe", { app: "not.the.owned.fixture" })};42`);
  noMutation(deniedScope);
  assert.match(visible(deniedScope).nativeEvidence[0]?.error ?? "", /trusted target/);
  const observation = await qc.observe();
  const old = {
    observationId: observation.observationId,
    elementToken: tab(observation, qc.alternate).token,
  };
  const deniedFlags = await qc.run(
    callCode("act", { app: qc.fixture().app, ...old, action: "press" }),
  );
  noMutation(deniedFlags);
  const deniedActions = evidence(deniedFlags).execution?.actions;
  if (deniedActions === undefined) {
    assert.fail("missing denied execution actions");
  }
  assert.ok(deniedActions.some((action) => action.method === "act" && !action.dispatched));
  assert.equal((await qc.observeActual()).current.name, qc.original().name);
  qc.pass("wrong app and missing parent mutation flags refused without native effect");
}

/**
 * Two parent PNG captures survive a third refused capture.
 * @param {QualifyContext} qc
 */
export async function assertImageRefusal(qc) {
  const observation = await qc.observe();
  const imageWindow = observation.windows[0];
  if (imageWindow === undefined) {
    assert.fail("missing window for screenshot");
  }
  const imageCall = callCode("screenshot", {
    app: qc.fixture().app,
    observationId: observation.observationId,
    windowToken: imageWindow.token,
  });
  const captures = await qc.run(
    `var firstImage=${imageCall};var secondImage=${imageCall};var refusedImage=${imageCall};({firstImage,secondImage,refusedImage})`,
  );
  noMutation(captures);
  const captureResult = executionValue(captures);
  if (!isRecordResult(captureResult)) {
    assert.fail("missing capture result");
  }
  const refusedImage = captureResult.refusedImage;
  if (!isRecordResult(refusedImage)) {
    assert.fail("missing refused image result");
  }
  assert.equal(refusedImage.status, "refused");
  const images = imageReceipts(captures);
  qc.pass("two parent PNG images survive third-capture refusal through public transport", images);
}

/**
 * Whether a value is a plain record (capture-result shapes).
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecordResult(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * AXPress stays explicitly unverified until independently observed; the
 * Unicode whole-field write is verified against a fresh observation.
 * @param {QualifyContext} qc
 * @returns {Promise<OwnedWorker[]>}
 */
export async function assertUnverifiedPress(qc) {
  let observation = await qc.observe();
  const pressed = await qc.act(observation, tab(observation, qc.alternate), "press");
  assert.equal(pressed.verified, false);
  assert.equal(pressed.outcome, "requires-fresh-observation");
  assert.equal((await qc.observeActual()).current.name, qc.alternate);
  qc.pass("AXPress remains explicitly unverified until independently observed");
  observation = await qc.observe();
  const ordinary =
    state(observation, qc.fixture()).fields[ordinaryField] ?? assert.fail("missing ordinary field");
  assert.equal((await qc.act(observation, ordinary, "setValue", unicode)).verified, true);
  assert.equal((await qc.observeActual()).current.fields[ordinaryField]?.value, unicode);
  qc.pass("Unicode whole-field value independently observed");
  const deadlineWorkers = await qc.rememberWorkers();
  qc.pass("actual owned native and independent JSC process artifacts observed", deadlineWorkers);
  return deadlineWorkers;
}

/**
 * A real deadline interrupt and a public reset clear execution and
 * observation state without any replay.
 * @param {QualifyContext} qc
 * @param {OwnedWorker[]} deadlineWorkers
 */
export async function assertDeadlineReset(qc, deadlineWorkers) {
  const deadline = await qc.run("while(true){}", false, 100);
  assert.equal(deadline.isError, true);
  const deadlineExecution = evidence(deadline).execution;
  if (deadlineExecution === undefined) {
    assert.fail("missing deadline execution");
  }
  assert.equal(deadlineExecution.interruption, "deadline");
  requireExited(deadlineWorkers, "Immediately after deadline, before recovery");
  const unchanged = (await qc.observeActual()).current;
  assert.equal(unchanged.name, qc.alternate);
  assert.equal(unchanged.fields[ordinaryField]?.value, unicode);
  const observation = await qc.observe();
  assert.equal(
    executionValue(await qc.run("retainedProof+1")),
    42,
    "Native observation must retain bindings before reset",
  );
  const beforeReset = {
    observationId: observation.observationId,
    elementToken: tab(observation, qc.alternate).token,
  };
  assert.equal((await qc.client().call(resetTool, {})).isError, false);
  assert.equal(executionValue(await qc.run("typeof retainedProof")), "undefined");
  const staleAfterReset = await qc.run(
    callCode("act", { app: qc.fixture().app, ...beforeReset, action: "press" }),
    true,
  );
  noMutation(staleAfterReset);
  const staleActions = evidence(staleAfterReset).nativeActions;
  if (staleActions === undefined) {
    assert.fail("missing stale native actions");
  }
  assert.match(staleActions[0]?.error ?? "", /fresh same-session native observation/);
  qc.pass("actual deadline and reset clear execution/observation state without replay");
}

/**
 * A real context-changing setter retains attempted/unknown, blocks further
 * mutation, and survives reset.
 * @param {QualifyContext} qc
 */
export async function assertUnknownOutcome(qc) {
  const observation = await qc.observe();
  const changing =
    state(observation, qc.fixture()).fields[contextField] ?? assert.fail("missing context field");
  const unknownWorkers = await qc.rememberWorkers();
  const unknown = await qc.run(
    `${callCode("act", {
      app: qc.fixture().app,
      observationId: observation.observationId,
      elementToken: changing.token,
      action: "setValue",
      value: contextValue,
    })};42`,
    true,
  );
  assert.equal(unknown.isError, true);
  assert.equal(evidence(unknown).priorUnknown, true);
  requireExited(unknownWorkers, "Immediately after unknown response, before recovery");
  assert.ok(
    visible(unknown).nativeEvidence.some(
      (item) =>
        item.mutationAttempted === true && item.outcome === "unknown" && item.verified !== true,
    ),
  );
  const changed = (await qc.observeActual()).current;
  assert.equal(changed.fields[contextField]?.value, contextValue);
  assert.equal(changed.name, "CPU");
  const fresh = await qc.observe();
  noMutation(
    await qc.run(
      callCode("act", {
        app: qc.fixture().app,
        observationId: fresh.observationId,
        elementToken:
          state(fresh, qc.fixture()).fields[ordinaryField]?.token ??
          assert.fail("missing ordinary field token"),
        action: "setValue",
        value: "DO NOT WRITE",
      }),
      true,
    ),
  );
  assert.equal((await qc.observeActual()).current.fields[ordinaryField]?.value, unicode);
  const reset = await qc.client().call(resetTool, {});
  assert.equal(reset.isError, false);
  assert.equal(evidence(reset).priorUnknown, true);
  assert.match(reset.content[0]?.text ?? "", /prior.*unknown/i);
  qc.pass(
    "real context-changing setter retains attempted/unknown, blocks further mutation and survives reset",
  );
}

/**
 * Restore the original fields and radio selection through public transport,
 * then verify settlement and close the transport.
 * @param {QualifyContext} qc
 */
export async function restorePublicOriginalState(qc) {
  await restorePublicFields(qc);
  const observation = await qc.observe();
  if (state(observation, qc.fixture()).name !== qc.original().name) {
    await qc.act(observation, tab(observation, qc.original().name ?? ""), "press");
  }
  await verifyPublicRestoration(qc);
  await settleAndCloseTransport(qc);
}

/**
 * Restore both fields to their captured originals through public transport.
 * @param {QualifyContext} qc
 */
async function restorePublicFields(qc) {
  for (const identifier of [contextField, ordinaryField]) {
    const observation = await qc.observe();
    const current = state(observation, qc.fixture()).fields[identifier];
    if (current === undefined) {
      assert.fail(`missing fixture field ${identifier}`);
    }
    const allowed = allowedFieldValues(qc, identifier);
    assert.ok(
      allowed.includes(current.value),
      "Unexpected fixture field value; refusing public restoration overwrite",
    );
    if (current.value !== qc.original().fields[identifier]?.value) {
      await qc.act(observation, current, "setValue", qc.original().fields[identifier]?.value);
    }
  }
}

/**
 * Verify the restored radio selection and field values.
 * @param {QualifyContext} qc
 */
async function verifyPublicRestoration(qc) {
  const final = (await qc.observeActual()).current;
  assert.equal(final.name, qc.original().name);
  for (const identifier of [ordinaryField, contextField]) {
    assert.equal(final.fields[identifier]?.value, qc.original().fields[identifier]?.value);
  }
  qc.pass("original fields and actual radio selection restored through public transport");
}

/**
 * Require settled owned work, then close the transport and verify worker exit.
 * @param {QualifyContext} qc
 */
async function settleAndCloseTransport(qc) {
  const finalWorkers = await qc.rememberWorkers();
  const finalReset = await qc.client().call(resetTool, {});
  assert.equal(finalReset.isError, false);
  const settlement = evidence(finalReset).settlement;
  if (settlement === undefined) {
    assert.fail("missing settlement record");
  }
  assert.equal(settlement.settled, true);
  assert.equal(settlement.workerStopped, true);
  assert.equal(settlement.nativeStopped, true);
  assert.equal(settlement.hostCallsPending, 0);
  requireExited(finalWorkers, "Immediately after final public reset");
  qc.pass("final public reset reports settled owned work", settlement);
  const close = await qc.client().close();
  qc.markClientClosed();
  requireExited(qc.workers.values(), "After transport close");
  qc.pass("owned transport/executor/native workers exited", {
    close,
    workers: [...qc.workers.values()],
  });
}
