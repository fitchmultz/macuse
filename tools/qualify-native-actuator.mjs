#!/usr/bin/env node
import assert from "node:assert/strict";
import { isAbsolute } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import {
  isActuatorRejection,
  isFixtureHandle,
  isProofObservation,
  isRecord,
  isScreenshotResult,
  observedTab,
  screenshotEvidence,
  tabTarget,
} from "./qualify-actuator-observation.mjs";
import { qualifyFixtureText } from "./qualify-fixture-text.mjs";

/** @typedef {import("./qualify-actuator-observation.mjs").ActuatorLike} ActuatorLike */
/** @typedef {import("./qualify-actuator-observation.mjs").CheckRecord} CheckRecord */
/** @typedef {import("./qualify-actuator-observation.mjs").FixtureHandle} FixtureHandle */
/** @typedef {import("./qualify-actuator-observation.mjs").ObservedElement} ObservedElement */
/** @typedef {import("./qualify-actuator-observation.mjs").ObservedTabState} ObservedTabState */
/** @typedef {import("./qualify-actuator-observation.mjs").ProofObservation} ProofObservation */
/** @typedef {import("./qualify-actuator-observation.mjs").QualifyReport} QualifyReport */

/** @typedef {{ actuator: ActuatorLike, app: string, safetyNote: string, checks: CheckRecord[] }} TabBaseContext */
/** @typedef {TabBaseContext & { request: (observation: ProofObservation, element: ObservedElement, allowMutating?: boolean) => Record<string, unknown> }} TabRefusalContext */
/** @typedef {TabBaseContext & { observe: () => Promise<ProofObservation>, press: (observation: ProofObservation, name: string) => Promise<unknown> }} TabRestoreContext */
/** @typedef {{ app: string, safetyNote: string, scope: string, expectedPid?: number, expectedPath?: string, expectedTitle?: string }} QualifyTabsOptions */

const activityMonitorApp = "com.apple.ActivityMonitor";
const activityMonitorSafetyNote =
  "Activity Monitor only: select a named tab and restore its observed original selection. Never stop processes, open Inspector, or use process actions.";

/**
 * Observe the proof target app, pinning the trusted identity when supplied.
 * @param {ActuatorLike} actuator
 * @param {{ app: string, expectedPid?: number | undefined, expectedPath?: string | undefined }} options
 * @returns {Promise<ProofObservation>}
 */
async function observeTabs(actuator, options) {
  const result = await actuator.observe({
    app: options.app,
    ...(options.expectedPath !== undefined && options.expectedPath !== ""
      ? { expectedPid: options.expectedPid, expectedPath: options.expectedPath }
      : {}),
  });
  return isProofObservation(result) ? result : assert.fail("Invalid observation payload");
}

/**
 * Build a press request bound to an observation and element.
 * @param {{ app: string, safetyNote: string }} options
 * @param {ProofObservation} observation
 * @param {ObservedElement} element
 * @param {boolean} allowMutating
 * @returns {Record<string, unknown>}
 */
function pressRequest(options, observation, element, allowMutating) {
  return {
    app: options.app,
    observationId: observation.observationId,
    elementToken: element.token,
    action: "press",
    allowMutating,
    safetyNote: options.safetyNote,
  };
}

/**
 * Assemble the bounded tab-qualification report.
 * @param {string} scope
 * @param {CheckRecord[]} checks
 * @param {Error[]} failures
 * @returns {QualifyReport}
 */
function buildTabReport(scope, checks, failures) {
  for (const error of failures) {
    checks.push({ name: "qualification failure", status: "fail", detail: error.message });
  }
  return {
    ok: failures.length === 0,
    scope,
    fullNativeQualification: false,
    chatgptIndependenceQualified: false,
    checks,
    unattempted: [
      "Visual screenshot content and pointer-coordinate action mapping",
      "Unicode selection preservation",
      "Keyboard/pointer focus and transition coverage",
      "Replaced-window and cross-app negative controls beyond the fixture context challenge",
      "Native abort/timeout and unknown-outcome lifecycle",
      "Independent persistent sandboxed execution",
      "Fresh Pi, CLI, and MCP end-to-end paths",
      "Recording and Computer History independence",
    ],
  };
}

/**
 * Capture the original selected tab and record the observation check.
 * @param {ActuatorLike} actuator
 * @param {{ app: string, expectedPid?: number | undefined, expectedPath?: string | undefined, expectedTitle?: string | undefined }} options
 * @param {CheckRecord[]} checks
 * @returns {Promise<{ observation: ProofObservation, originalTab: ObservedTabState }>}
 */
async function captureTabOriginal(actuator, options, checks) {
  const observation = await observeTabs(actuator, options);
  const selected = observedTab(observation, undefined, options.app);
  assertFixtureIdentity(observation, selected, options);
  /** @type {ObservedTabState} */
  const originalTab = { name: selected.name, pid: observation.app.pid, window: selected.window };
  checks.push({
    name: "complete observation and known original tab",
    status: "pass",
    originalTab: originalTab.name,
  });
  return { observation, originalTab };
}

/**
 * Assert the fixture's trusted identity before any element is trusted.
 * @param {ProofObservation} observation
 * @param {{ name: string | undefined, element: ObservedElement, window: import("./qualify-actuator-observation.mjs").ObservedWindow }} selected
 * @param {{ expectedPid?: number | undefined, expectedPath?: string | undefined, expectedTitle?: string | undefined }} expected
 */
function assertFixtureIdentity(observation, selected, expected) {
  if (expected.expectedPid !== undefined) {
    assert.equal(observation.app.pid, expected.expectedPid, "Fixture process identity changed");
  }
  if (expected.expectedPath !== undefined) {
    assert.equal(observation.app.path, expected.expectedPath, "Fixture app path changed");
  }
  if (expected.expectedTitle !== undefined) {
    assert.equal(selected.window.title, expected.expectedTitle, "Fixture window identity changed");
  }
}

/**
 * Capture a window-bound screenshot and record its PNG metadata evidence.
 * @param {TabBaseContext} ctx
 * @param {ProofObservation} observation
 * @param {ObservedTabState} originalTab
 */
async function assertWindowScreenshot(ctx, observation, originalTab) {
  const shot = await ctx.actuator.screenshot({
    app: ctx.app,
    observationId: observation.observationId,
    windowToken: originalTab.window.token,
  });
  if (!isScreenshotResult(shot)) {
    assert.fail("Invalid screenshot payload");
  }
  ctx.checks.push({
    name: "window-bound PNG metadata",
    status: "pass",
    detail: screenshotEvidence(shot, originalTab.window),
  });
}

/**
 * A request without allowMutating must be refused before dispatch.
 * @param {TabRefusalContext} ctx
 * @param {ProofObservation} observation
 * @param {ObservedTabState} originalTab
 * @param {string} alternate
 */
async function assertRefusedMutation(ctx, observation, originalTab, alternate) {
  const target = tabTarget(observation, alternate, originalTab.window.token);
  let refused = false;
  try {
    await ctx.actuator.act(ctx.request(observation, target, false));
  } catch (error) {
    if (!isActuatorRejection(error)) {
      assert.fail("Unauthorized request did not reject");
    }
    assert.equal(error.dispatched, false, "Unauthorized request may have dispatched");
    assert.equal(error.mutationAttempted, false, "Unauthorized request may have mutated");
    refused = true;
  }
  assert.equal(refused, true, "Missing mutation authorization was not refused");
  ctx.checks.push({ name: "missing authorization refused before dispatch", status: "pass" });
}

/**
 * Refuse the unauthorized press, then apply and observe the real one.
 * @param {TabRestoreContext & { request: TabRefusalContext["request"] }} ctx
 * @param {ProofObservation} observation
 * @param {ObservedTabState} originalTab
 * @param {string} alternate
 */
async function runTabMutations(ctx, observation, originalTab, alternate) {
  await assertRefusedMutation(ctx, observation, originalTab, alternate);
  let current = await ctx.observe();
  assert.equal(
    observedTab(current, originalTab, ctx.app).name,
    originalTab.name,
    "Refused action changed the selected tab",
  );
  await ctx.press(current, alternate);
  current = await ctx.observe();
  assert.equal(
    observedTab(current, originalTab, ctx.app).name,
    alternate,
    "Native press result was not observed",
  );
  ctx.checks.push({
    name: "AXPress independently observed",
    status: "pass",
    selectedTab: alternate,
  });
}

/**
 * Restore and independently verify the original tab selection.
 * @param {TabRestoreContext} ctx
 * @param {ObservedTabState} originalTab
 * @param {boolean} mutationRequested
 * @param {Error[]} failures
 */
async function restoreOriginalTab(ctx, originalTab, mutationRequested, failures) {
  try {
    let observation = await ctx.observe();
    const current = observedTab(observation, originalTab, ctx.app);
    // Fresh, known state makes restoration a new bounded action, not a retry of an uncertain press.
    if (mutationRequested && current.name !== originalTab.name) {
      await ctx.press(observation, originalTab.name ?? "");
      observation = await ctx.observe();
    }
    assert.equal(
      observedTab(observation, originalTab, ctx.app).name,
      originalTab.name,
      "Original tab was not restored",
    );
    ctx.checks.push({
      name: "original tab independently verified",
      status: "pass",
      restoredTab: originalTab.name,
    });
  } catch (error) {
    failures.push(
      new Error(`Cleanup failed: ${error instanceof Error ? error.message : String(error)}`),
    );
  }
}

/** A bounded live proof, not full native or execution qualification. The caller owns stop(). */
/**
 * @param {ActuatorLike} actuator
 * @param {QualifyTabsOptions} options
 * @returns {Promise<QualifyReport>}
 */
async function qualifyTabs(
  actuator,
  { app, safetyNote, scope, expectedPid, expectedPath, expectedTitle },
) {
  /** @type {CheckRecord[]} */
  const checks = [];
  /** @type {Error[]} */
  const failures = [];
  /** @type {ObservedTabState | undefined} */
  let original;
  let mutationRequested = false;
  const observe = () => observeTabs(actuator, { app, expectedPid, expectedPath });
  const request = (
    /** @type {ProofObservation} */ observation,
    /** @type {ObservedElement} */ element,
    allowMutating = true,
  ) => pressRequest({ app, safetyNote }, observation, element, allowMutating);
  const press = async (
    /** @type {ProofObservation} */ observation,
    /** @type {string | undefined} */ name,
  ) => {
    if (original === undefined) {
      assert.fail("Original tab state is missing");
    }
    const target = tabTarget(observation, name ?? "", original.window.token);
    mutationRequested = true;
    const acted = await actuator.act(request(observation, target));
    if (!isRecord(acted)) {
      assert.fail("Invalid actuator action result");
    }
    assert.equal(
      acted.status,
      "applied",
      "Native press did not complete; inspect fresh state, do not replay",
    );
    assert.equal(acted.mutationAttempted, true);
    assert.equal(acted.nativeAccepted, true);
  };
  try {
    const captured = await captureTabOriginal(
      actuator,
      { app, expectedPid, expectedPath, expectedTitle },
      checks,
    );
    original = captured.originalTab;
    const originalTab = original;
    await assertWindowScreenshot(
      { actuator, app, safetyNote, checks },
      captured.observation,
      originalTab,
    );
    const observation = await observe();
    observedTab(observation, originalTab, app);
    const alternate = originalTab.name === "Memory" ? "CPU" : "Memory";
    mutationRequested = true;
    await runTabMutations(
      { actuator, app, safetyNote, checks, request, observe, press },
      observation,
      originalTab,
      alternate,
    );
  } catch (error) {
    failures.push(error instanceof Error ? error : new Error(String(error)));
  } finally {
    if (original !== undefined) {
      await restoreOriginalTab(
        { actuator, app, safetyNote, checks, observe, press },
        original,
        mutationRequested,
        failures,
      );
    }
  }
  return buildTabReport(scope, checks, failures);
}

/**
 * @param {ActuatorLike} actuator
 * @returns {Promise<QualifyReport>}
 */
export function qualifyActivityMonitor(actuator) {
  return qualifyTabs(actuator, {
    app: activityMonitorApp,
    safetyNote: activityMonitorSafetyNote,
    scope: "experimental-native-activity-monitor-slice",
  });
}

/**
 * @param {ActuatorLike} actuator
 * @param {unknown} fixture
 * @param {{ challenger?: ActuatorLike | undefined }} [options]
 * @returns {Promise<QualifyReport>}
 */
export async function qualifyActuatorFixture(actuator, fixture, { challenger } = {}) {
  // A borrowed app is refused before any other handle detail is trusted.
  if (!isRecord(fixture) || typeof fixture.app !== "string") {
    assert.fail("Invalid fixture handle");
  }
  assert.match(
    fixture.app,
    /^com\.macuse\.actuator-fixture\.[0-9a-f-]{36}$/,
    "An exact task-owned fixture identity is required",
  );
  if (!isFixtureHandle(fixture)) {
    assert.fail("Invalid fixture handle");
  }
  assert.ok(Number.isSafeInteger(fixture.pid) && fixture.pid > 0, "Fixture PID is required");
  assert.ok(
    typeof fixture.path === "string" && isAbsolute(fixture.path),
    "An absolute owned fixture app path is required",
  );
  assert.equal(fixture.title, "macuse disposable actuator fixture");
  for (const expected of [
    { expectedPid: fixture.pid + 1, expectedPath: fixture.path },
    { expectedPid: fixture.pid, expectedPath: `${fixture.path}.must-not-match` },
  ]) {
    await assert.rejects(
      actuator.observe({ app: fixture.app, ...expected }),
      (/** @type {unknown} */ error) => {
        if (!isActuatorRejection(error)) {
          return false;
        }
        return (
          error.dispatched === false &&
          error.mutationAttempted === false &&
          /Trusted app PID\/path identity mismatch/.test(error.message)
        );
      },
      "Wrong trusted fixture PID/path must refuse before reading AX content",
    );
  }
  const report = await qualifyTabs(actuator, {
    app: fixture.app,
    expectedPid: fixture.pid,
    expectedPath: fixture.path,
    expectedTitle: fixture.title,
    safetyNote:
      "Task-owned disposable macuse fixture only: select an alternate radio control and restore its actual original selection. No user apps or documents.",
    scope: "experimental-owned-native-fixture-slice",
  });
  report.checks.unshift({
    name: "wrong trusted PID/path refused before AX content",
    status: "pass",
  });
  if (report.ok && challenger) {
    report.checks.push(...(await qualifyFixtureText(actuator, challenger, fixture)));
    report.ok = report.checks.every((check) => check.status === "pass");
  } else {
    report.unattempted.push("Fixture stale-context and Unicode whole-field checks");
  }
  return report;
}

/**
 * Print the usage banner; without --live no desktop access occurs.
 * @param {{ help?: boolean | undefined, live?: boolean | undefined }} values
 */
function printUsage(values) {
  console.log(
    "Experimental native proof: node tools/qualify-native-actuator.mjs --live [--fixture]\nDefault: authorized Activity Monitor tab selection/restoration. --fixture: launch, exercise, and dispose an owned real AppKit test app instead; not real-world app parity. Native permissions required. No recording, vendor runtime, or default-backend changes. Without --live, no desktop access occurs.",
  );
  if (values.help !== true) {
    process.exitCode = 1;
  }
}

/**
 * @param {import("./native-actuator.mjs").NativeActuator} actuator
 * @param {import("./native-actuator.mjs").NativeActuator | undefined} challenger
 * @param {boolean} withFixture
 * @returns {Promise<QualifyReport>}
 */
async function runSelectedMode(actuator, challenger, withFixture) {
  /** @type {FixtureHandle | undefined} */
  let fixture;
  try {
    if (withFixture) {
      const { startActuatorFixture } = await import("./actuator-fixture.mjs");
      const started = await startActuatorFixture();
      if (!isFixtureHandle(started)) {
        assert.fail("Invalid fixture handle");
      }
      fixture = started;
    }
    return fixture
      ? await qualifyActuatorFixture(actuator, fixture, { challenger })
      : await qualifyActivityMonitor(actuator);
  } finally {
    try {
      await Promise.all([actuator.stop(), challenger?.stop()]);
    } finally {
      await fixture?.stop();
    }
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      live: { type: "boolean" },
      fixture: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help === true || values.live !== true) {
    printUsage(values);
    return;
  }
  const { NativeActuator } = await import("./native-actuator.mjs");
  const actuator = new NativeActuator();
  const withFixture = values.fixture === true;
  /** @type {import("./native-actuator.mjs").NativeActuator | undefined} */
  const challenger = withFixture ? new NativeActuator() : undefined;
  const report = await runSelectedMode(actuator, challenger, withFixture);
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) {
    process.exitCode = 1;
  }
}
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((/** @type {unknown} */ error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
