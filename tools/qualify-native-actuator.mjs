#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { parseArgs } from "node:util";
import { firstText } from "./macuse-utils.mjs";
import { fileURLToPath } from "node:url";

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
/**
 * @param {unknown} value
 * @returns {value is string[]}
 */
const isStringArray = (value) =>
  Array.isArray(value) && value.every((item) => typeof item === "string");
/** @typedef {{ bundleId?: string, pid: number, path?: string }} ObservedApp */
/** @typedef {{ x: number, y: number, width: number, height: number }} FrameRect */
/** @typedef {{ token: string, title?: string, document?: unknown, frame?: FrameRect }} ObservedWindow */
/** @typedef {{ token: string, role?: string, value?: unknown, description?: string, title?: string, identifier?: string, windowToken?: string, actions?: string[], valueSettable?: boolean }} ObservedElement */
/** @typedef {{ observationId: string, fullSnapshot?: boolean, app: ObservedApp, windows: ObservedWindow[], elements: ObservedElement[] }} ProofObservation */
/** @typedef {{ coordinateSpace: string, windowToken: string, image: { mimeType: string, data: string, width: number, height: number }, windowFrame: FrameRect, captureRect: FrameRect & Record<string, number>, pointPixelScale: number }} ScreenshotResult */
/** @typedef {{ name: string | undefined, pid?: number, window: ObservedWindow, element?: ObservedElement, field?: ObservedElement, contextField?: ObservedElement }} ObservedTabState */
/** @typedef {{ observe: (input: Record<string, unknown>) => Promise<unknown>, act: (input: Record<string, unknown>) => Promise<unknown>, screenshot: (input: Record<string, unknown>) => Promise<unknown>, stop: () => Promise<void> }} ActuatorLike */
/** @typedef {{ app: string, pid: number, path: string, title: string, stop: () => Promise<void> }} FixtureHandle */
/** @typedef {{ name: string, status: string, [key: string]: unknown }} CheckRecord */
/** @typedef {{ ok: boolean, scope: string, fullNativeQualification: boolean, chatgptIndependenceQualified: boolean, checks: CheckRecord[], unattempted: string[] }} QualifyReport */
/** @typedef {{ app: string, safetyNote: string, scope: string, expectedPid?: number, expectedPath?: string, expectedTitle?: string }} QualifyTabsOptions */
/**
 * @param {unknown} value
 * @returns {value is ProofObservation}
 */
const isProofObservation = (value) =>
  isRecord(value) &&
  typeof value.observationId === "string" &&
  isRecord(value.app) &&
  typeof value.app.pid === "number" &&
  Array.isArray(value.windows) &&
  value.windows.every((window) => isRecord(window) && typeof window.token === "string") &&
  Array.isArray(value.elements) &&
  value.elements.every((element) => isRecord(element) && typeof element.token === "string");
/**
 * @param {unknown} value
 * @returns {value is ScreenshotResult}
 */
const isScreenshotResult = (value) =>
  isRecord(value) &&
  typeof value.coordinateSpace === "string" &&
  typeof value.windowToken === "string" &&
  isRecord(value.image) &&
  typeof value.image.data === "string" &&
  isRecord(value.windowFrame) &&
  isRecord(value.captureRect) &&
  typeof value.pointPixelScale === "number";
/**
 * @param {unknown} value
 * @returns {value is FixtureHandle}
 */
const isFixtureHandle = (value) =>
  isRecord(value) &&
  typeof value.app === "string" &&
  typeof value.pid === "number" &&
  typeof value.path === "string" &&
  typeof value.title === "string" &&
  typeof value.stop === "function";
/**
 * Narrow an actuator rejection to its dispatch-evidence shape.
 *
 * @param {unknown} value
 * @returns {value is Error & { dispatched?: unknown, mutationAttempted?: unknown, outcome?: string }}
 */
const isActuatorRejection = (value) => value instanceof Error;

const activityMonitorApp = "com.apple.ActivityMonitor";
const tabs = new Set(["CPU", "Memory", "Energy", "Disk", "Network"]);
const activityMonitorSafetyNote =
  "Activity Monitor only: select a named tab and restore its observed original selection. Never stop processes, open Inspector, or use process actions.";

/**
 * @param {ProofObservation} observation
 * @param {ObservedTabState | undefined} original
 * @param {string} app
 * @returns {{ name: string | undefined, element: ObservedElement, window: ObservedWindow }}
 */
function observedTab(observation, original, app) {
  assert.equal(observation.fullSnapshot, true, "A complete native snapshot is required");
  assert.equal(observation.app.bundleId, app, "The observed app must match the exact proof target");
  const selected = observation.elements.filter(
    (element) =>
      element.role === "AXRadioButton" &&
      tabs.has(firstText([element.description, element.title]) ?? "") &&
      (element.value === 1 || element.value === "1" || element.value === true),
  );
  assert.equal(selected.length, 1, "The actual original/selected tab is unknown");
  const element = selected[0];
  if (element === undefined) assert.fail("The actual original/selected tab is unknown");
  const window = observation.windows.find((window) => window.token === element.windowToken);
  assert.ok(window !== undefined, "Selected tab is not bound to an observed window");
  if (original !== undefined) {
    assert.equal(observation.app.pid, original.pid, "Observed app process changed");
    assert.equal(window.token, original.window.token, "Observed window changed");
    assert.equal(window.title, original.window.title, "Observed window title changed");
    assert.equal(window.document, original.window.document, "Observed document changed");
  }
  return { name: firstText([element.description, element.title]) ?? "", element, window };
}

/**
 * @param {ProofObservation} observation
 * @param {string} name
 * @param {string} windowToken
 * @returns {ObservedElement}
 */
function tabTarget(observation, name, windowToken) {
  const matches = observation.elements.filter(
    (element) =>
      element.role === "AXRadioButton" &&
      firstText([element.description, element.title]) === name &&
      element.windowToken === windowToken,
  );
  assert.equal(matches.length, 1, `Expected exactly one ${name} tab in the original window`);
  const target = matches[0];
  if (target === undefined) assert.fail(`Expected exactly one ${name} tab in the original window`);
  if (!isStringArray(target.actions)) assert.fail(`The ${name} tab does not expose AXPress`);
  assert.ok(target.actions.includes("AXPress"), `The ${name} tab does not expose AXPress`);
  return target;
}

/**
 * @param {ScreenshotResult} result
 * @param {ObservedWindow} window
 */
function screenshotEvidence(result, window) {
  assert.equal(result.coordinateSpace, "screenshot-pixels");
  assert.equal(result.windowToken, window.token);
  assert.equal(result.image.mimeType, "image/png");
  const bytes = Buffer.from(result.image.data, "base64");
  assert.ok(bytes.length >= 24, "Screenshot is too short for a PNG header");
  assert.deepEqual(
    bytes.subarray(0, 8),
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    "Screenshot bytes are not PNG",
  );
  assert.equal(bytes.toString("ascii", 12, 16), "IHDR");
  const width = bytes.readUInt32BE(16),
    height = bytes.readUInt32BE(20);
  assert.ok(width > 0 && height > 0, "Screenshot dimensions are empty");
  assert.equal(result.image.width, width, "Reported width differs from PNG bytes");
  assert.equal(result.image.height, height, "Reported height differs from PNG bytes");
  assert.deepEqual(
    result.windowFrame,
    window.frame,
    "Screenshot belongs to a different window frame",
  );
  assert.ok(
    Number.isFinite(result.pointPixelScale) && result.pointPixelScale > 0,
    "Missing pixel-to-point scale",
  );
  const rect = result.captureRect;
  assert.ok(
    ["x", "y", "width", "height"].every((key) => Number.isFinite(rect[key])) &&
      rect.width > 0 &&
      rect.height > 0,
    "Missing screenshot capture rectangle",
  );
  assert.ok(
    Math.abs(width - result.captureRect.width * result.pointPixelScale) <= 0.5 &&
      Math.abs(height - result.captureRect.height * result.pointPixelScale) <= 0.5,
    "PNG dimensions disagree with the reported capture rectangle and pixel scale",
  );
  return {
    width,
    height,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    windowFrame: result.windowFrame,
    captureRect: result.captureRect,
    pointPixelScale: result.pointPixelScale,
    coordinateSpace: result.coordinateSpace,
    visualContentVerified: false,
  };
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
  const observe = async () => {
    const result = await actuator.observe({
      app,
      ...(expectedPath !== undefined && expectedPath !== "" ? { expectedPid, expectedPath } : {}),
    });
    return isProofObservation(result) ? result : assert.fail("Invalid observation payload");
  };
  const request = (
    /** @type {ProofObservation} */ observation,
    /** @type {ObservedElement} */ element,
    allowMutating = true,
  ) => ({
    app,
    observationId: observation.observationId,
    elementToken: element.token,
    action: "press",
    allowMutating,
    safetyNote,
  });
  const press = async (
    /** @type {ProofObservation} */ observation,
    /** @type {string | undefined} */ name,
  ) => {
    if (original === undefined) assert.fail("Original tab state is missing");
    const target = tabTarget(observation, name ?? "", original.window.token);
    mutationRequested = true;
    const acted = await actuator.act(request(observation, target));
    if (!isRecord(acted)) assert.fail("Invalid actuator action result");
    const result = acted;
    assert.equal(
      result.status,
      "applied",
      "Native press did not complete; inspect fresh state, do not replay",
    );
    assert.equal(result.mutationAttempted, true);
    assert.equal(result.nativeAccepted, true);
    return result;
  };
  try {
    let observation = await observe();
    const selected = observedTab(observation, undefined, app);
    if (expectedPid !== undefined)
      assert.equal(observation.app.pid, expectedPid, "Fixture process identity changed");
    if (expectedPath !== undefined)
      assert.equal(observation.app.path, expectedPath, "Fixture app path changed");
    if (expectedTitle !== undefined)
      assert.equal(selected.window.title, expectedTitle, "Fixture window identity changed");
    original = { name: selected.name, pid: observation.app.pid, window: selected.window };
    const originalTab = original;
    checks.push({
      name: "complete observation and known original tab",
      status: "pass",
      originalTab: originalTab.name,
    });
    const shot = await actuator.screenshot({
      app,
      observationId: observation.observationId,
      windowToken: originalTab.window.token,
    });
    if (!isScreenshotResult(shot)) assert.fail("Invalid screenshot payload");
    checks.push({
      name: "window-bound PNG metadata",
      status: "pass",
      detail: screenshotEvidence(shot, originalTab.window),
    });
    observation = await observe();
    observedTab(observation, original, app);
    const alternate = originalTab.name === "Memory" ? "CPU" : "Memory";
    const target = tabTarget(observation, alternate, originalTab.window.token);
    mutationRequested = true;
    let refused = false;
    try {
      await actuator.act(request(observation, target, false));
    } catch (error) {
      if (!isActuatorRejection(error)) assert.fail("Unauthorized request did not reject");
      assert.equal(error.dispatched, false, "Unauthorized request may have dispatched");
      assert.equal(error.mutationAttempted, false, "Unauthorized request may have mutated");
      refused = true;
    }
    assert.equal(refused, true, "Missing mutation authorization was not refused");
    checks.push({ name: "missing authorization refused before dispatch", status: "pass" });
    observation = await observe();
    assert.equal(
      observedTab(observation, original, app).name,
      original.name,
      "Refused action changed the selected tab",
    );
    await press(observation, alternate);
    observation = await observe();
    assert.equal(
      observedTab(observation, original, app).name,
      alternate,
      "Native press result was not observed",
    );
    checks.push({ name: "AXPress independently observed", status: "pass", selectedTab: alternate });
  } catch (error) {
    failures.push(error instanceof Error ? error : new Error(String(error)));
  } finally {
    if (original !== undefined) {
      const originalTab = original;
      try {
        let observation = await observe();
        const current = observedTab(observation, original, app);
        // Fresh, known state makes restoration a new bounded action, not a retry of an uncertain press.
        if (mutationRequested && current.name !== originalTab.name) {
          await press(observation, originalTab.name);
          observation = await observe();
        }
        assert.equal(
          observedTab(observation, original, app).name,
          original.name,
          "Original tab was not restored",
        );
        checks.push({
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
  }
  for (const error of failures)
    checks.push({ name: "qualification failure", status: "fail", detail: error.message });
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
 * @param {ActuatorLike} challenger
 * @param {FixtureHandle} fixture
 * @returns {Promise<CheckRecord[]>}
 */
async function qualifyFixtureText(actuator, challenger, fixture) {
  /** @type {CheckRecord[]} */
  const checks = [];
  const replacement = "prefix 独立 👩🏽‍💻 e\u0301 suffix";
  const contextReplacement = "postwrite MUTATED 🧪";
  /** @type {ObservedTabState | undefined} */
  let original;
  const observe = async () => {
    const result = await actuator.observe({
      app: fixture.app,
      expectedPid: fixture.pid,
      expectedPath: fixture.path,
    });
    return isProofObservation(result) ? result : assert.fail("Invalid observation payload");
  };
  /**
   * @param {ProofObservation} observation
   * @param {string} [identifier]
   * @returns {ObservedElement}
   */
  const field = (observation, identifier = "macuse-fixture-field") => {
    if (original === undefined) assert.fail("Original fixture state is missing");
    const state = original;
    const matches = observation.elements.filter(
      (element) => element.identifier === identifier && element.windowToken === state.window.token,
    );
    assert.equal(matches.length, 1, "Expected one owned fixture text field");
    const target = matches[0];
    if (target === undefined) assert.fail("Expected one owned fixture text field");
    assert.equal(target.role, "AXTextField");
    assert.equal(target.valueSettable, true);
    assert.equal(typeof target.value, "string");
    const saved = identifier === "macuse-fixture-field" ? original.field : original.contextField;
    if (saved !== undefined)
      assert.equal(target.token, saved.token, "Fixture text field identity changed");
    return target;
  };
  /**
   * @param {ProofObservation} observation
   * @param {ObservedElement} target
   * @param {string} value
   * @returns {Promise<unknown>}
   */
  const setValue = (observation, target, value) =>
    actuator.act({
      app: fixture.app,
      observationId: observation.observationId,
      elementToken: target.token,
      action: "setValue",
      value,
      allowMutating: true,
      safetyNote:
        "Owned disposable macuse fixture text field only: replace its complete test value and restore its captured original. No user document or selected-range claim.",
    });
  try {
    let observation = await observe();
    const selected = observedTab(observation, undefined, fixture.app);
    assert.equal(observation.app.pid, fixture.pid, "Fixture process identity changed");
    assert.equal(selected.window.title, fixture.title, "Fixture window identity changed");
    original = { name: selected.name, pid: fixture.pid, window: selected.window };
    original.field = field(observation);
    original.contextField = field(observation, "macuse-fixture-context-field");
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
    const alternate = original.name === "Memory" ? "CPU" : "Memory";
    const pressed = await challenger.act({
      app: fixture.app,
      observationId: challenge.observationId,
      elementToken: tabTarget(challenge, alternate, challengeTab.window.token).token,
      action: "press",
      allowMutating: true,
      safetyNote:
        "Owned disposable fixture only: change a radio control to invalidate the other helper observation, then restore its captured original selection.",
    });
    if (!isRecord(pressed)) assert.fail("Invalid challenger action result");
    assert.equal(pressed.nativeAccepted, true);
    // tsgo requires this guard (optional field) while tsgolint resolves the
    // same property as non-optional; both cannot be satisfied at once.
    const originalField = original.field;
    // oxlint-disable-next-line no-unnecessary-condition
    if (originalField === undefined) assert.fail("missing original fixture field");
    await assert.rejects(
      setValue(observation, originalField, replacement),
      (/** @type {unknown} */ error) => {
        if (!isActuatorRejection(error)) return false;
        return (
          error.dispatched === false &&
          error.mutationAttempted === false &&
          /app context.*changed/i.test(error.message)
        );
      },
      "Changed fixture context must reject the stale field edit before dispatch",
    );
    checks.push({ name: "changed fixture context refused before field dispatch", status: "pass" });
    observation = await observe();
    assert.equal(
      observedTab(observation, original, fixture.app).name,
      alternate,
      "Context challenge did not change the actual radio state",
    );
    assert.equal(
      field(observation).value,
      original.field.value,
      "Refused stale edit changed the field",
    );
    const applied = await setValue(observation, field(observation), replacement);
    if (!isRecord(applied)) assert.fail("Invalid setValue result");
    assert.equal(applied.status, "applied");
    assert.equal(applied.nativeAccepted, true);
    assert.equal(applied.verified, true);
    observation = await observe();
    observedTab(observation, original, fixture.app);
    assert.equal(field(observation).value, replacement, "Unicode whole-field readback differs");
    checks.push({
      name: "Unicode whole-field value independently observed",
      status: "pass",
      selectedRangeQualified: false,
    });
    const changed = await setValue(
      observation,
      field(observation, "macuse-fixture-context-field"),
      contextReplacement,
    );
    if (!isRecord(changed)) assert.fail("Invalid changed-field result");
    assert.equal(changed.mutationAttempted, true);
    assert.equal(changed.nativeAccepted, true);
    assert.equal(
      changed.status,
      "unverified",
      "Context drift during the setter must not be reported as a verified edit",
    );
    assert.equal(changed.verified, false);
    assert.equal(changed.outcome, "unknown");
    observation = await observe();
    assert.equal(
      observedTab(observation, original, fixture.app).name,
      "CPU",
      "Adversarial setter did not change the actual fixture context",
    );
    assert.equal(field(observation, "macuse-fixture-context-field").value, contextReplacement);
    checks.push({
      name: "context drift during AX write retained as attempted and unknown",
      status: "pass",
    });
  } catch (error) {
    checks.push({
      name: "fixture text qualification failure",
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
    });
  } finally {
    if (original !== undefined && original.field !== undefined) {
      const originalTab = original;
      try {
        let observation = await observe();
        observedTab(observation, original, fixture.app);
        /** @type {[ObservedElement | undefined, string][]} */
        const restores = [
          [original.field, replacement],
          [original.contextField, contextReplacement],
        ];
        for (const [saved, planned] of restores) {
          if (saved === undefined) continue;
          const current = field(observation, saved.identifier ?? "");
          assert.ok(
            [saved.value, planned].includes(current.value),
            "Fixture field changed to an unexpected value; refusing cleanup overwrite",
          );
          const savedValue = typeof saved.value === "string" ? saved.value : "";
          if (current.value !== saved.value) {
            const restoreResult = await setValue(observation, current, savedValue);
            if (!isRecord(restoreResult)) assert.fail("Invalid restore setValue result");
            assert.equal(restoreResult.verified, true);
            observation = await observe();
            observedTab(observation, original, fixture.app);
          }
          assert.equal(
            field(observation, saved.identifier ?? "").value,
            savedValue,
            "Original fixture field value was not restored",
          );
        }
        if (observedTab(observation, original, fixture.app).name !== originalTab.name) {
          const restored = await actuator.act({
            app: fixture.app,
            observationId: observation.observationId,
            elementToken: tabTarget(observation, originalTab.name ?? "", originalTab.window.token)
              .token,
            action: "press",
            allowMutating: true,
            safetyNote:
              "Owned disposable fixture only: restore its captured original radio selection after the stale-context test.",
          });
          if (!isRecord(restored)) assert.fail("Invalid restore result");
          assert.equal(restored.nativeAccepted, true);
          observation = await observe();
        }
        assert.equal(observedTab(observation, original, fixture.app).name, originalTab.name);
        assert.equal(field(observation).value, original.field.value);
        if (original.contextField)
          assert.equal(
            field(observation, original.contextField.identifier).value,
            original.contextField.value,
          );
        checks.push({
          name: "original fixture text and radio state independently verified",
          status: "pass",
        });
      } catch (error) {
        checks.push({
          name: "fixture text cleanup failure",
          status: "fail",
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return checks;
}

/**
 * @param {ActuatorLike} actuator
 * @param {unknown} fixture
 * @param {{ challenger?: ActuatorLike | undefined }} [options]
 * @returns {Promise<QualifyReport>}
 */
export async function qualifyActuatorFixture(actuator, fixture, { challenger } = {}) {
  // A borrowed app is refused before any other handle detail is trusted.
  if (!isRecord(fixture) || typeof fixture.app !== "string") assert.fail("Invalid fixture handle");
  assert.match(
    fixture.app,
    /^com\.macuse\.actuator-fixture\.[0-9a-f-]{36}$/,
    "An exact task-owned fixture identity is required",
  );
  if (!isFixtureHandle(fixture)) assert.fail("Invalid fixture handle");
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
        if (!isActuatorRejection(error)) return false;
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
  } else report.unattempted.push("Fixture stale-context and Unicode whole-field checks");
  return report;
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
    console.log(
      "Experimental native proof: node tools/qualify-native-actuator.mjs --live [--fixture]\nDefault: authorized Activity Monitor tab selection/restoration. --fixture: launch, exercise, and dispose an owned real AppKit test app instead; not real-world app parity. Native permissions required. No recording, vendor runtime, or default-backend changes. Without --live, no desktop access occurs.",
    );
    if (values.help !== true) process.exitCode = 1;
    return;
  }
  const { NativeActuator } = await import("./native-actuator.mjs");
  const actuator = new NativeActuator();
  const withFixture = values.fixture === true;
  /** @type {import("./native-actuator.mjs").NativeActuator | undefined} */
  const challenger = withFixture ? new NativeActuator() : undefined;
  /** @type {FixtureHandle | undefined} */
  let fixture;
  /** @type {QualifyReport | undefined} */
  let report;
  try {
    if (withFixture) {
      const { startActuatorFixture } = await import("./actuator-fixture.mjs");
      const started = await startActuatorFixture();
      if (!isFixtureHandle(started)) assert.fail("Invalid fixture handle");
      fixture = started;
    }
    report = fixture
      ? await qualifyActuatorFixture(actuator, fixture, { challenger })
      : await qualifyActivityMonitor(actuator);
  } finally {
    try {
      await Promise.all([actuator.stop(), challenger?.stop()]);
    } finally {
      await fixture?.stop();
    }
  }
  // tsgo requires this guard (assigned only inside try) while tsgolint
  // infers the post-try value as always assigned; both cannot be satisfied.
  // oxlint-disable-next-line no-unnecessary-condition
  if (report === undefined) assert.fail("qualification produced no report");
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1])
  main().catch((/** @type {unknown} */ error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
