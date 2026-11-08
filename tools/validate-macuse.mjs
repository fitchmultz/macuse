#!/usr/bin/env node
import assert from "node:assert/strict";
import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MacuseSession } from "../lib/macuse-session.mjs";
import { MAX_CUA_TIMEOUT_MS } from "../lib/cua-timeout.mjs";
import { tools } from "../lib/tools.mjs";
import { VERSION } from "./macuse-utils.mjs";

/** @typedef {import("../lib/macuse-session.mjs").SessionResult} SessionResult */
/** Structural tab view activityMonitorCheck reads from runtime observations. */
/** @typedef {{ elements: Array<{ index?: string, role: string, name: string, description?: string, value?: string }> }} TabObservation */
/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
/**
 * @template {{ isError?: boolean | undefined, content: Array<{ type: string, text?: string | undefined }> }} T
 * @param {T} result
 * @returns {T}
 */
const checked = (result) => {
  assert.equal(
    result.isError,
    false,
    result.content.map((p) => (p.type === "text" ? p.text : "")).join("\n"),
  );
  return result;
};
/**
 * @param {TabObservation | undefined} observation
 * @returns {string | undefined}
 */
const selectedTab = (observation) => {
  const selected = observation?.elements.filter(
    (e) =>
      e.role === "radio button" &&
      e.value === "1" &&
      ["CPU", "Memory", "Energy", "Disk", "Network"].includes(e.description ?? e.name),
  );
  const first = selected?.[0];
  return selected?.length === 1 && first !== undefined
    ? (first.description ?? first.name)
    : undefined;
};

/**
 * A validated Activity Monitor session surface for tab probes.
 * @typedef {{ runtime: { getObservation: (app: string) => TabObservation | undefined }, callTool: (tool: string, args: Record<string, unknown>) => Promise<SessionResult> }} ActivitySession
 */

/**
 * Shared state for one Activity Monitor tab probe.
 * @typedef {{ session: ActivitySession, app: string, timeoutMs: number, results: SessionResult[], original: string | undefined, attempted: boolean }} ActivityProbe
 */

/**
 * @param {unknown} error
 * @returns {Error}
 */
const asError = (error) => (error instanceof Error ? error : new Error(String(error)));

const ACTIVITY_SAFETY_NOTE =
  "Activity Monitor only: select a tab and restore its original selection; never Stop, Inspector, Actions, or terminate processes.";

/**
 * One guarded macuse call, recorded with the probe's results.
 * @param {ActivityProbe} probe
 * @param {string} code
 * @returns {Promise<SessionResult>}
 */
const probeCall = async (probe, code) => {
  const result = await probe.session.callTool("macuse", {
    code,
    apps: [probe.app],
    allowMutating: true,
    safetyNote: ACTIVITY_SAFETY_NOTE,
    timeoutMs: probe.timeoutMs,
  });
  probe.results.push(result);
  return checked(result);
};

/**
 * The unique radio button for one Activity Monitor tab.
 * @param {ActivityProbe} probe
 * @param {string} name
 * @returns {TabObservation["elements"][number]}
 */
const probeElement = (probe, name) => {
  const observation = probe.session.runtime.getObservation(probe.app);
  if (observation === undefined) {
    assert.fail(`Expected one ${name} tab`);
  }
  const matches = observation.elements.filter(
    (e) => e.role === "radio button" && (e.description ?? e.name) === name,
  );
  assert.equal(matches.length, 1, `Expected one ${name} tab`);
  const target = matches[0];
  if (target === undefined) {
    assert.fail(`Expected one ${name} tab`);
  }
  return target;
};

/**
 * Press one Activity Monitor tab radio button and re-read state.
 * @param {ActivityProbe} probe
 * @param {string} name
 * @returns {Promise<SessionResult>}
 */
const probePress = async (probe, name) => {
  const target = probeElement(probe, name);
  return probeCall(
    probe,
    `await activity.performSecondaryAction(${Number(target.index)}, "Press"); await activity.getAXState()`,
  );
};

/**
 * @param {unknown} focus
 */
const activationCoverage = (focus) => {
  if (!isRecord(focus) || focus.observationAvailable !== true) {
    assert.fail("Native activation coverage unavailable; background behavior is unproven");
  }
  const coverage = focus.coverage;
  const before = focus.before;
  const after = focus.after;
  const transitions = focus.transitions;
  if (!isRecord(coverage) || !isRecord(before) || !isRecord(after) || !Array.isArray(transitions)) {
    assert.fail("Native activation coverage unavailable; background behavior is unproven");
  }
  return { coverage, before, after, transitions };
};

/**
 * Whether one value is the Activity Monitor application record.
 * @param {unknown} value
 * @returns {boolean}
 */
const isMonitorApp = (value) => isRecord(value) && value.bundleId === "com.apple.ActivityMonitor";

/**
 * A tool result must prove no Activity Monitor activation happened.
 * @param {SessionResult} result
 */
const checkFocusResult = (result) => {
  const { coverage, before, after, transitions } = activationCoverage(result.details.macuse.focus);
  assert.ok(
    coverage.applicationActivation === true && coverage.truncated !== true,
    "Native activation coverage unavailable; background behavior is unproven",
  );
  const beforeFrontmost = before.frontmost;
  const afterFrontmost = after.frontmost;
  if (!isRecord(beforeFrontmost) || !isRecord(afterFrontmost)) {
    assert.fail("Native activation coverage unavailable; background behavior is unproven");
  }
  assert.equal(
    isMonitorApp(beforeFrontmost),
    false,
    "Activity Monitor is already frontmost; background behavior is unproven",
  );
  assert.equal(
    isMonitorApp(afterFrontmost) ||
      transitions.some((e) => isRecord(e) && e.kind === "activation" && isMonitorApp(e.app)),
    false,
    "Activity Monitor activation observed; attribution unknown",
  );
};

/**
 * Capture the original tab selection and its verified alternate.
 * @param {ActivityProbe} probe
 * @param {boolean} strictFocus
 * @returns {Promise<{ original: string, alternate: string }>}
 */
const captureOriginalTab = async (probe, strictFocus) => {
  const first = await probeCall(probe, 'var activity = await cua.getApp("Activity Monitor")');
  const original = selectedTab(probe.session.runtime.getObservation(probe.app));
  assert.ok(
    original !== undefined && original !== "",
    "Original Activity Monitor tab is unknown; no mutation performed",
  );
  if (strictFocus) {
    checkFocusResult(first);
  }
  return { original, alternate: original === "Memory" ? "CPU" : "Memory" };
};

/**
 * Restore the original Activity Monitor tab selection.
 * @param {ActivityProbe} probe
 * @param {string} original
 * @returns {Promise<void>}
 */
const restoreOriginalTab = async (probe, original) => {
  await probeCall(probe, "await activity.getAXState()");
  if (selectedTab(probe.session.runtime.getObservation(probe.app)) !== original) {
    await probePress(probe, original);
  }
  assert.equal(
    selectedTab(probe.session.runtime.getObservation(probe.app)),
    original,
    "Original tab was not restored",
  );
};

/**
 * Focus violations across recorded results, one failure per result.
 * @param {SessionResult[]} results
 * @returns {Error[]}
 */
const focusFailures = (results) => {
  /** @type {Error[]} */
  const failures = [];
  for (const result of results) {
    try {
      checkFocusResult(result);
    } catch (error) {
      failures.push(asError(error));
    }
  }
  return failures;
};

/**
 * @param {ActivitySession} session
 * @param {{ strictFocus?: boolean, timeoutMs?: number }} [options]
 */
export async function activityMonitorCheck(
  session,
  { strictFocus = false, timeoutMs = 90000 } = {},
) {
  /** @type {ActivityProbe} */
  const probe = {
    session,
    app: "Activity Monitor",
    timeoutMs,
    results: [],
    original: undefined,
    attempted: false,
  };
  /** @type {Error[]} */
  const failures = [];
  try {
    const { original, alternate } = await captureOriginalTab(probe, strictFocus);
    probe.original = original;
    probeElement(probe, alternate);
    probe.attempted = true;
    await probePress(probe, alternate);
    assert.equal(selectedTab(probe.session.runtime.getObservation(probe.app)), alternate);
  } catch (error) {
    failures.push(asError(error));
  } finally {
    if (probe.original !== undefined && probe.attempted) {
      try {
        await restoreOriginalTab(probe, probe.original);
      } catch (error) {
        failures.push(new Error(`Activity Monitor cleanup failed: ${asError(error).message}`));
      }
    }
  }
  if (strictFocus) {
    failures.push(...focusFailures(probe.results));
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, failures.map((e) => e.message).join("; "));
  }
  return {
    originalTab: probe.original,
    restored: true,
    inputAttribution: "unknown",
    operations: probe.results.map((r) => r.details.macuse),
  };
}

/**
 * @param {{ live?: boolean, timeoutMs?: number }} [options]
 */
async function mcpCheck({ live = false, timeoutMs = 90000 } = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("./macuse-mcp.mjs", import.meta.url))],
    stderr: "pipe",
  });
  const client = new Client({ name: "macuse-validation", version: VERSION });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((t) => t.name).sort(), tools.map((t) => t.name).sort());
    /** @type {[string, Record<string, unknown>][]} */
    const refusalCases = [
      ["event_stream_start", {}],
      ["computer_history_update_settings", {}],
    ];
    for (const [name, args] of refusalCases) {
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.isError, true);
      const meta = result._meta;
      const macuse = isRecord(meta) ? meta.macuse : undefined;
      assert.ok(isRecord(macuse), "Refusal must carry macuse metadata");
      assert.equal(macuse.dispatched, false);
    }
    if (live) {
      const liveResult = await client.callTool(
        {
          name: "macuse",
          arguments: { code: "await cua.getState()", timeoutMs, trackFocus: false },
        },
        undefined,
        { timeout: timeoutMs + 10000 },
      );
      assert.ok(!("toolResult" in liveResult), "Unexpected toolResult envelope");
      checked(liveResult);
    }
    return { tools: listed.tools.length, live };
  } finally {
    await client.close();
  }
}

/**
 * One native persistent-JavaScript probe across two macuse calls.
 * @param {import("../lib/macuse-session.mjs").MacuseSession} session
 * @param {number} timeoutMs
 * @returns {Promise<unknown>}
 */
async function nativeSessionCheck(session, timeoutMs) {
  checked(
    await session.callTool("macuse", {
      code: "var macuseProbe = 41; nodeRepl.write(macuseProbe)",
      trackFocus: false,
      timeoutMs,
    }),
  );
  const result = checked(
    await session.callTool("macuse", {
      code: "nodeRepl.write(macuseProbe + 1)",
      trackFocus: false,
      timeoutMs,
    }),
  );
  assert.match(result.content.map((p) => (p.type === "text" ? p.text : "")).join("\n"), /42/);
  return session.status();
}

/**
 * The native runtime exposes no browser surface.
 * @param {import("../lib/macuse-session.mjs").MacuseSession} session
 * @param {number} timeoutMs
 * @returns {Promise<unknown>}
 */
async function nativeInventoryCheck(session, timeoutMs) {
  return checked(
    await session.callTool("macuse", {
      code: 'var inventory = await cua.getState(); if (inventory.browsers.length) throw new Error("Unexpected browser surface")',
      trackFocus: false,
      timeoutMs,
    }),
  ).details;
}

/**
 * A native app observation with a screenshot and parsed window title.
 * @param {import("../lib/macuse-session.mjs").MacuseSession} session
 * @param {string} app
 * @param {number} timeoutMs
 * @returns {Promise<unknown>}
 */
async function nativeAppStateCheck(session, app, timeoutMs) {
  checked(
    await session.callTool("macuse", {
      code: `var inspected = await cua.getApp(${JSON.stringify(app)})`,
      apps: [app],
      timeoutMs,
    }),
  );
  const result = checked(
    await session.callTool("macuse", {
      code: "await inspected.getAXStateAndScreenshot()",
      apps: [app],
      timeoutMs,
    }),
  );
  assert.ok(
    result.content.some((p) => p.type === "image"),
    "No screenshot returned",
  );
  const observedTitle = session.runtime.getObservation(app)?.title;
  assert.ok(
    observedTitle !== undefined && observedTitle !== null && observedTitle !== "",
    "No parsed window title",
  );
  return result.details;
}

/**
 * Offline extension-contract checks.
 * @param {(name: string, run: () => unknown) => Promise<void>} check
 * @returns {Promise<void>}
 */
async function extensionModeChecks(check) {
  await check("Pi extension contract (no desktop)", () => {
    const result = spawnSync(
      process.execPath,
      ["--test", "tools/tests/pi-extension.test.mjs", "tools/tests/pi-lifecycle.test.mjs"],
      { encoding: "utf8", env: { ...process.env, PI_OFFLINE: "1" }, timeout: 60000 },
    );
    assert.equal(result.status, 0, result.stderr + result.stdout);
    return "Registration, native SDK selection recovery and runtime cleanup, partial error flags, scoped original-image restoration";
  });
  await check("MCP schemas and pre-dispatch refusal", () => mcpCheck());
}

/**
 * Live native-runtime checks for the selected mode.
 * @param {(name: string, run: () => unknown) => Promise<void>} check
 * @param {import("../lib/macuse-session.mjs").MacuseSession} session
 * @param {{ mode: string, timeoutMs: number, app: string }} config
 * @returns {Promise<void>}
 */
async function nativeModeChecks(check, session, { mode, timeoutMs, app }) {
  await check("Native persistent JavaScript", async () => nativeSessionCheck(session, timeoutMs));
  await check("Native computer-only inventory", async () =>
    nativeInventoryCheck(session, timeoutMs),
  );
  if (mode === "read-only") {
    await check("Native app state and image", async () =>
      nativeAppStateCheck(session, app, timeoutMs),
    );
  }
  if (["mutating", "focus"].includes(mode)) {
    await check("Activity Monitor tab restoration", () =>
      activityMonitorCheck(session, { strictFocus: mode === "focus", timeoutMs }),
    );
  }
  if (mode === "mcp") {
    await check("MCP live native runtime", () => mcpCheck({ live: true, timeoutMs }));
  }
}

/**
 * @param {Array<{ name: string, status: string, detail: unknown }>} checks
 * @param {string} mode
 */
function buildReport(checks, mode) {
  return {
    ok: checks.every((c) => c.status === "pass"),
    mode,
    generatedAt: new Date().toISOString(),
    counts: {
      pass: checks.filter((c) => c.status === "pass").length,
      warn: 0,
      fail: checks.filter((c) => c.status === "fail").length,
    },
    checks,
  };
}

/**
 * @param {{ ok: boolean, checks: Array<{ name: string, status: string, detail: unknown }> }} report
 * @param {{ json?: boolean | undefined }} values
 */
function printReport(report, values) {
  if (values.json === true) {
    console.log(JSON.stringify(report, null, 2));
  } else if (!report.ok) {
    const last = report.checks.at(-1);
    if (last !== undefined) {
      console.error(last.detail);
    }
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      json: { type: "boolean" },
      verbose: { type: "boolean" },
      app: { type: "string", default: "Activity Monitor" },
      "tool-timeout-ms": { type: "string", default: "90000" },
      help: { type: "boolean", short: "h" },
    },
  });
  const mode = positionals[0] ?? "quick";
  if (values.help === true) {
    console.log(
      "macuse validation: extension (offline) | quick | read-only | mutating | focus | mcp\nmutating/focus select an Activity Monitor tab and restore the captured original in finally. No recording/privacy changes.",
    );
    return;
  }
  assert.ok(
    ["extension", "quick", "read-only", "mutating", "focus", "mcp"].includes(mode),
    `Unknown mode: ${mode}`,
  );
  const timeoutMs = Number(values["tool-timeout-ms"]);
  assert.ok(
    Number.isInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= MAX_CUA_TIMEOUT_MS,
    "Invalid timeout",
  );
  /** @type {Array<{ name: string, status: string, detail: unknown }>} */
  const checks = [];
  /**
   * @param {string} name
   * @param {() => unknown} run
   */
  const check = async (name, run) => {
    const detail = await run();
    checks.push({ name, status: "pass", detail });
    if (values.json !== true) {
      console.log(`PASS ${name}`);
    }
  };
  const session = new MacuseSession();
  try {
    if (mode === "extension") {
      await extensionModeChecks(check);
    } else {
      await nativeModeChecks(check, session, { mode, timeoutMs, app: values.app });
    }
  } catch (error) {
    checks.push({
      name: "Validation failure",
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
    });
  } finally {
    await session.stop();
  }
  const report = buildReport(checks, mode);
  printReport(report, values);
  if (!report.ok) {
    process.exitCode = 1;
  }
}
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((/** @type {unknown} */ error) => {
    console.error(error instanceof Error ? error : String(error));
    process.exitCode = 1;
  });
}
