#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { release } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs, promisify } from "node:util";
import {
  descendants,
  hash,
  isActuatorClass,
  isFixtureLauncher,
  isRecord,
  isProofObservation,
  proofTool,
  safetyNote,
  sourceHashes,
} from "./qualify-proof-transport.mjs";
import { openClient } from "./qualify-proof-client.mjs";
import { callCode, evidence, executionValue, state } from "./qualify-proof-checks.mjs";
import {
  assertDeadlineReset,
  assertImageRefusal,
  assertScopeRefusal,
  assertUnknownOutcome,
  assertUnverifiedPress,
  restorePublicOriginalState,
} from "./qualify-proof-phases.mjs";
import { cleanupOriginalState, stopOwnedProcesses } from "./qualify-proof-cleanup.mjs";

/** @typedef {import("./qualify-proof-transport.mjs").TransportSpec} TransportSpec */
/** @typedef {import("./qualify-proof-transport.mjs").NativeActuatorLike} NativeActuatorLike */
/** @typedef {import("./qualify-proof-transport.mjs").FixtureHandle} FixtureHandle */
/** @typedef {import("./qualify-proof-transport.mjs").ObservedState} ObservedState */
/** @typedef {import("./qualify-proof-transport.mjs").ProofObservation} ProofObservation */
/** @typedef {import("./qualify-proof-transport.mjs").ObservedElement} ObservedElement */
/** @typedef {import("./qualify-proof-transport.mjs").TransportClient} TransportClient */
/** @typedef {import("./qualify-proof-transport.mjs").TransportResult} TransportResult */
/** @typedef {import("./qualify-proof-transport.mjs").OwnedWorker} OwnedWorker */
/** @typedef {import("./qualify-proof-transport.mjs").NativeActionRecord} NativeActionRecord */
/** @typedef {import("./qualify-proof-phases.mjs").QualifyContext} QualifyContext */

const exec = promisify(execFile);

/**
 * @param {TransportSpec} spec
 * @param {string} root
 * @param {new () => NativeActuatorLike} NativeActuator
 * @param {() => Promise<FixtureHandle>} startFixture
 * @returns {Promise<{ transport: string, host?: string, ok: boolean, transportStderr: string, checks: Array<{ name: string, status: string, detail?: unknown }>, failures: string[], fullIndependenceQualified: boolean }>}
 */
async function qualify(spec, root, NativeActuator, startFixture) {
  /** @type {Array<{ name: string, status: string, detail?: unknown }>} */
  const checks = [];
  /** @type {string[]} */
  const failures = [];
  /** @type {Map<number, OwnedWorker>} */
  const workers = new Map();
  const observer = new NativeActuator();
  /** @type {{ fixture?: FixtureHandle, client?: TransportClient, original?: ObservedState, clientClosed?: boolean }} */
  const owned = {};
  /**
   * @param {string} name
   * @param {unknown} [detail]
   */
  const pass = (name, detail) =>
    checks.push({ name, status: "pass", ...(detail !== undefined ? { detail } : {}) });
  const qc = buildQualifyContext({ spec, root, observer, workers, checks, failures, owned, pass });
  try {
    owned.fixture = await startFixture();
    owned.original = (await qc.observeActual()).current;
    pass("operator-owned original state captured", {
      selectedTab: owned.original.name,
      birth: owned.original.birth,
    });
    qc.alternate = owned.original.name === "Memory" ? "Energy" : "Memory";
    owned.client = await openClient(spec, root, proofEnvironment(owned.fixture));
    await assertScopeRefusal(qc);
    await assertImageRefusal(qc);
    const deadlineWorkers = await assertUnverifiedPress(qc);
    await assertDeadlineReset(qc, deadlineWorkers);
    await assertUnknownOutcome(qc);
    await restorePublicOriginalState(qc);
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  } finally {
    await qc.closeClientIfOpen();
    if (qc.hasFixture() && qc.hasOriginal()) {
      await cleanupOriginalState(qc);
    }
    await stopOwnedProcesses(qc);
  }
  return {
    transport: spec.name,
    ...hostField(spec),
    ok: failures.length === 0,
    transportStderr: owned.client?.stderr ?? "",
    checks,
    failures,
    fullIndependenceQualified: false,
  };
}

/**
 * @param {TransportSpec} spec
 * @returns {{ host?: string }}
 */
function hostField(spec) {
  return spec.host !== undefined && spec.host !== "" ? { host: spec.host } : {};
}

/**
 * Build the pinned-trust environment for the public transport child.
 * @param {FixtureHandle} fixture
 * @returns {NodeJS.ProcessEnv}
 */
function proofEnvironment(fixture) {
  return {
    ...process.env,
    PI_OFFLINE: "1",
    MACUSE_CHATGPT_RESOURCES: "/no-vendor-installation-in-independent-proof",
    MACUSE_INDEPENDENT_PROOF_TARGET: JSON.stringify({
      bundleId: fixture.app,
      pid: fixture.pid,
      path: fixture.path,
      windowTitle: fixture.title,
    }),
  };
}

/**
 * Wire the run/observe/act/observeActual/rememberWorkers helpers over the
 * owned mutable state.
 * @param {{ spec: TransportSpec, root: string, observer: NativeActuatorLike, workers: Map<number, OwnedWorker>, checks: Array<{ name: string, status: string, detail?: unknown }>, failures: string[], owned: { fixture?: FixtureHandle, client?: TransportClient, original?: ObservedState, clientClosed?: boolean }, pass: (name: string, detail?: unknown) => void }} base
 * @returns {QualifyContext}
 */
function buildQualifyContext(base) {
  const { owned, observer, workers, pass } = base;
  const activeFixture = () => owned.fixture ?? assert.fail("fixture not started");
  const activeClient = () => owned.client ?? assert.fail("transport not started");
  const activeOriginal = () => owned.original ?? assert.fail("original state not captured");
  const rememberWorkers = async () => {
    const current = await descendants(activeClient().pid);
    for (const worker of current) {
      workers.set(worker.pid, worker);
    }
    return current;
  };
  const observeActual = async () => {
    const target = activeFixture();
    const observation = await observer.observe({
      app: target.app,
      expectedPid: target.pid,
      expectedPath: target.path,
      ...(owned.original ? { expectedProcessStartToken: owned.original.birth } : {}),
    });
    return { observation, current: state(observation, target, owned.original) };
  };
  /**
   * @param {string} code
   * @param {boolean} [mutate]
   * @param {number} [timeoutMs]
   */
  const run = (code, mutate = false, timeoutMs = 10000) =>
    activeClient().call(proofTool, {
      code,
      apps: [activeFixture().app],
      timeoutMs,
      ...(mutate ? { allowMutating: true, safetyNote } : {}),
    });
  const calls = wireObserveAct(activeFixture, run);
  /** @type {QualifyContext} */
  const qc = {
    ...base,
    alternate: "",
    fixture: activeFixture,
    client: activeClient,
    original: activeOriginal,
    hasFixture: () => owned.fixture !== undefined,
    hasOriginal: () => owned.original !== undefined,
    markClientClosed: () => {
      owned.clientClosed = true;
    },
    closeClientIfOpen: async () => {
      if (owned.client !== undefined && owned.clientClosed !== true) {
        try {
          await owned.client.close();
        } catch (error) {
          base.failures.push(
            `Transport cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    },
    pass,
    run,
    observe: calls.observe,
    act: calls.act,
    observeActual,
    rememberWorkers,
  };
  return qc;
}

/**
 * Wire the public-transport observe and act calls.
 * @param {() => FixtureHandle} activeFixture
 * @param {(code: string, mutate?: boolean, timeoutMs?: number) => Promise<TransportResult>} run
 */
function wireObserveAct(activeFixture, run) {
  const observe = async () => {
    const result = await run(
      `var retainedProof=41; var proofState=${callCode("observe", { app: activeFixture().app })}; proofState`,
    );
    assert.equal(result.isError, false);
    const observed = executionValue(result);
    if (!isProofObservation(observed)) {
      assert.fail("observe result is not an observation");
    }
    state(observed, activeFixture());
    return observed;
  };
  /**
   * @param {ProofObservation} observation
   * @param {ObservedElement} element
   * @param {string} action
   * @param {unknown} [fieldValue]
   */
  const act = async (observation, element, action, fieldValue) => {
    const result = await run(
      callCode("act", {
        app: activeFixture().app,
        observationId: observation.observationId,
        elementToken: element.token,
        action,
        ...(action === "setValue" ? { value: fieldValue } : {}),
      }),
      true,
    );
    assert.equal(result.isError, false, result.content[0]?.text);
    const nativeActions = evidence(result).nativeActions;
    if (nativeActions === undefined) {
      assert.fail("missing native action records");
    }
    const accepted = nativeActions.find((item) => item.method === "act");
    if (accepted === undefined) {
      assert.fail("missing accepted act record");
    }
    assert.equal(accepted.mutationAttempted, true);
    assert.equal(accepted.nativeAccepted, true);
    return accepted;
  };
  return { observe, act };
}

/**
 * @param {{ help?: boolean | undefined, live?: boolean | undefined }} values
 */
function printProofUsage(values) {
  console.log(
    "Usage: node tools/qualify-independent-proof.mjs --live --package-root ROOT --official-pi PI_PACKAGE_DIR --fork-pi PI_PACKAGE_DIR\nExplicit research-only owned AppKit fixture qualification through real CLI/MCP/official-Pi/fork-Pi tool paths. Without --live, no desktop access. Uses/restores only owned fixture fields and radio controls; no user apps, recording/history, selected-range, keyboard/pointer or full-independence claim.",
  );
  if (values.help !== true) {
    process.exitCode = 1;
  }
}

/**
 * @param {string} root
 * @returns {Promise<{ NativeActuator: new () => NativeActuatorLike, startActuatorFixture: () => Promise<FixtureHandle> }>}
 */
async function loadActuatorModules(root) {
  /** @type {unknown} */
  const nativeActuatorModule = await import(
    pathToFileURL(join(root, "tools/native-actuator.mjs")).href
  );
  const actuatorCandidate = isRecord(nativeActuatorModule)
    ? nativeActuatorModule.NativeActuator
    : undefined;
  if (!isActuatorClass(actuatorCandidate)) {
    assert.fail("NativeActuator export missing");
  }
  /** @type {unknown} */
  const actuatorFixtureModule = await import(
    pathToFileURL(join(root, "tools/actuator-fixture.mjs")).href
  );
  const launcherCandidate = isRecord(actuatorFixtureModule)
    ? actuatorFixtureModule.startActuatorFixture
    : undefined;
  if (!isFixtureLauncher(launcherCandidate)) {
    assert.fail("startActuatorFixture export missing");
  }
  return { NativeActuator: actuatorCandidate, startActuatorFixture: launcherCandidate };
}

/**
 * @param {{ "official-pi"?: string | undefined, "fork-pi"?: string | undefined }} values
 * @returns {TransportSpec[]}
 */
function buildTransportSpecs(values) {
  const officialPi = values["official-pi"];
  const forkPi = values["fork-pi"];
  assert.ok(officialPi !== undefined && officialPi !== "");
  assert.ok(forkPi !== undefined && forkPi !== "");
  return [
    { kind: "cli", name: "CLI JSONL" },
    { kind: "mcp", name: "MCP stdio" },
    { kind: "pi", name: "official Pi public SDK tools", host: resolve(officialPi) },
    { kind: "pi", name: "fork Pi public SDK tools", host: resolve(forkPi) },
  ];
}

/**
 * @param {TransportSpec[]} specs
 * @returns {Promise<Array<{ name: string, path: string | undefined, version: unknown, packageManifestSha256: string }>>}
 */
async function hostSummaries(specs) {
  return Promise.all(
    specs
      .filter((spec) => spec.host !== undefined && spec.host !== "")
      .map(async (spec) => {
        const host = spec.host ?? "";
        /** @type {unknown} */
        const pkg = JSON.parse(await readFile(join(host, "package.json"), "utf8"));
        return {
          name: spec.name,
          path: spec.host,
          version: isRecord(pkg) ? pkg.version : undefined,
          packageManifestSha256: await hash(join(host, "package.json")),
        };
      }),
  );
}

/**
 * Require both exact official and fork Pi package directories.
 * @param {{ "official-pi"?: string | undefined, "fork-pi"?: string | undefined }} values
 */
function requirePiHosts(values) {
  assert.ok(
    values["official-pi"] !== undefined &&
      values["official-pi"] !== "" &&
      values["fork-pi"] !== undefined &&
      values["fork-pi"] !== "",
    "Both exact official and fork Pi package directories are required",
  );
}

async function main() {
  const { values } = parseArgs({
    options: {
      live: { type: "boolean" },
      "package-root": { type: "string" },
      "official-pi": { type: "string" },
      "fork-pi": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help === true || values.live !== true) {
    printProofUsage(values);
    return;
  }
  assert.equal(process.platform, "darwin", "Live independent qualification requires macOS");
  requirePiHosts(values);
  const root = resolve(values["package-root"] ?? fileURLToPath(new URL("..", import.meta.url)));
  const before = await sourceHashes(root);
  const qualifierSourceSha256 = await hash(fileURLToPath(import.meta.url));
  const { NativeActuator, startActuatorFixture } = await loadActuatorModules(root);
  const specs = buildTransportSpecs(values);
  const results = [];
  for (const spec of specs) {
    results.push(await qualify(spec, root, NativeActuator, startActuatorFixture));
  }
  const after = await sourceHashes(root);
  const unchanged =
    JSON.stringify(before) === JSON.stringify(after) &&
    qualifierSourceSha256 === (await hash(fileURLToPath(import.meta.url)));
  const report = {
    ok: unchanged && results.every((result) => result.ok),
    scope: "owned-fixture-independent-core-through-public-transports",
    fullIndependenceQualified: false,
    sourceUnchanged: unchanged,
    qualifierSourceSha256,
    sourceHashes: before,
    node: { path: process.execPath, version: process.version },
    os: {
      platform: process.platform,
      arch: process.arch,
      release: release(),
      macOS: (await exec("/usr/bin/sw_vers")).stdout.trim(),
    },
    hosts: await hostSummaries(specs),
    results,
    unattempted: [
      "General-app and Activity Monitor compatibility",
      "Selected-range insertion",
      "Visual screenshot content and pointer-coordinate action mapping",
      "Keyboard/pointer/focus and transition coverage",
      "Record & Replay and Computer History independence",
      "Independent pinning of Apple system JavaScriptCore",
      "Production signed helper deployment/default migration",
    ],
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) {
    process.exitCode = 1;
  }
}
main().catch((/** @type {unknown} */ error) => {
  console.error(
    `Independent qualification failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
