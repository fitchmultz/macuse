#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { findPackageJSON } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tools } from "../../lib/tools.mjs";

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isRecord = (value) => typeof value === "object" && value !== null;

/** @param {string | null | undefined} stderr @param {string | null | undefined} stdout */
function processOutput(stderr, stdout) {
  return stderr !== null && stderr !== undefined && stderr !== "" ? stderr : (stdout ?? "");
}

/**
 * Parses the RPC event stream and checks the probe completed without a model turn.
 *
 * @param {string} stdout
 * @returns {Record<string, unknown>[]}
 */
function probeEvents(stdout) {
  /** @type {Record<string, unknown>[]} */
  const events = [];
  for (const line of stdout.split("\n")) {
    if (line === "") {
      continue;
    }
    const parsed = /** @type {unknown} */ (JSON.parse(line));
    if (isRecord(parsed)) {
      events.push(parsed);
    }
  }
  assert.deepEqual(
    events.filter((event) => event.type === "extension_error"),
    [],
    "Pi extension startup failed",
  );
  assert.ok(
    events.some(
      (event) => event.id === "macuse-ci" && event.type === "response" && event.success === true,
    ),
    "Probe command did not complete",
  );
  assert.ok(!events.some((event) => event.type === "agent_start"), "Probe started a model turn");
  return events;
}

/** @param {Record<string, unknown>} event */
function isUnreachableWarning(event) {
  return (
    event.type === "extension_ui_request" &&
    event.method === "notify" &&
    typeof event.message === "string" &&
    event.message.startsWith("macuse recording and history tools that are not selected directly")
  );
}

/**
 * Reads the CI observer's record of the loaded host, tools, and commands.
 *
 * @param {string} path
 */
function readObservation(path) {
  const observedJson = /** @type {unknown} */ (JSON.parse(readFileSync(path, "utf8")));
  if (!isRecord(observedJson)) {
    throw new Error("The CI observer produced a malformed observation.");
  }
  const packageDir = observedJson.packageDir;
  if (typeof packageDir !== "string") {
    throw new Error("The CI observer reported no package directory.");
  }
  const observedVersion = observedJson.version;
  if (typeof observedVersion !== "string") {
    throw new Error("The CI observer reported no version.");
  }
  /**
   * @param {string} key
   * @returns {string[]}
   */
  const readStringArray = (key) => {
    const value = observedJson[key];
    if (!Array.isArray(value) || !value.every((name) => typeof name === "string")) {
      throw new Error(`The CI observer reported no usable ${key}.`);
    }
    return value;
  };
  return {
    packageDir,
    version: observedVersion,
    tools: readStringArray("tools"),
    activeTools: readStringArray("activeTools"),
    commands: readStringArray("commands"),
  };
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(
    "Usage: node .github/scripts/validate-pi-cli.mjs [PI_PACKAGE_DIR] [MACUSE_PACKAGE_DIR]\nOffline CLI extension-registration check.\nExample: node .github/scripts/validate-pi-cli.mjs /tmp/pi/node_modules/@earendil-works/pi-coding-agent /tmp/packed/package\nExit: 0 checks passed; 1 validation failure.",
  );
  process.exit(0);
}
const discovered = findPackageJSON("@earendil-works/pi-coding-agent", import.meta.url);
if (discovered === undefined) {
  throw new Error(
    "Cannot locate the installed @earendil-works/pi-coding-agent package; pass PI_PACKAGE_DIR explicitly.",
  );
}
const packageArg = process.argv[2];
const root = packageArg !== undefined ? resolve(packageArg) : dirname(discovered);
/** @type {unknown} */
const manifestJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
if (!isRecord(manifestJson)) {
  throw new Error(`The Pi host package manifest at ${root} is malformed.`);
}
const bin = manifestJson.bin;
if (!isRecord(bin) || typeof bin.pi !== "string") {
  throw new Error(`The Pi host package manifest at ${root} has no usable pi binary.`);
}
const piBin = join(root, bin.pi);
const manifestVersion = manifestJson.version;
if (typeof manifestVersion !== "string") {
  throw new Error(`The Pi host package manifest at ${root} has no version.`);
}
const macuseArg = process.argv[3];
const extension =
  macuseArg !== undefined
    ? join(resolve(macuseArg), "extensions/macuse.ts")
    : fileURLToPath(new URL("../../extensions/macuse.ts", import.meta.url));
const directory = mkdtempSync(join(tmpdir(), "macuse-cli-"));
try {
  const observer = join(directory, "observe.ts");
  const observation = join(directory, "observation.json");
  cpSync(fileURLToPath(new URL("./ci-observer.ts", import.meta.url)), observer);
  const env = {
    ...process.env,
    PI_PACKAGE_DIR: root,
    PI_CODING_AGENT_DIR: join(directory, "agent"),
    PI_TELEMETRY: "0",
    MACUSE_CI_OBSERVATION: observation,
  };
  /**
   * Runs the probe command through the real CLI in RPC mode and returns its events and observation.
   *
   * @param {readonly string[]} hostExtensions extension sources loaded before macuse
   */
  const probe = (hostExtensions) => {
    const result = spawnSync(
      process.execPath,
      [
        piBin,
        "--offline",
        "--mode",
        "rpc",
        "-ne",
        "-ns",
        "-np",
        "-nc",
        "--no-themes",
        "--no-approve",
        "--no-session",
        ...hostExtensions,
        "-e",
        extension,
        "-e",
        observer,
      ],
      {
        cwd: directory,
        env,
        encoding: "utf8",
        input: `${JSON.stringify({ id: "macuse-ci", type: "prompt", message: "/macuse-ci-probe" })}\n`,
        timeout: 45_000,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    if (result.error) {
      throw result.error;
    }
    assert.equal(result.status, 0, processOutput(result.stderr, result.stdout));
    const events = probeEvents(result.stdout);
    return {
      unreachableWarnings: events.filter(isUnreachableWarning),
      observed: readObservation(observation),
    };
  };
  // -ne loads neither tool_search nor codemode, so nothing can reach the deferred tools.
  const { observed, unreachableWarnings } = probe([]);
  assert.equal(
    unreachableWarnings.length,
    1,
    "macuse must warn once that its deferred tools are unreachable",
  );
  assert.equal(realpathSync(observed.packageDir), realpathSync(root), "The wrong Pi host loaded");
  assert.equal(observed.version, manifestVersion);
  const expectedTools = tools.map((tool) => tool.name);
  assert.deepEqual(
    observed.tools.filter((name) => expectedTools.includes(name)).sort(),
    expectedTools.sort(),
    "macuse tools were not all registered",
  );
  for (const name of ["macuse", "macuse_reset"]) {
    assert.ok(observed.activeTools.includes(name), `${name} was not active`);
  }
  for (const deferred of expectedTools.filter((tool) => !tool.startsWith("macuse"))) {
    assert.ok(
      !observed.activeTools.includes(deferred),
      `${deferred} was active instead of deferred`,
    );
  }
  assert.ok(observed.commands.includes("macuse-status"), "macuse commands were not registered");
  const withSearch = probe(["-e", "builtin:tool-search"]);
  assert.ok(
    withSearch.observed.activeTools.includes("tool_search"),
    "macuse did not activate tool_search",
  );
  assert.deepEqual(
    withSearch.unreachableWarnings,
    [],
    "macuse warned although tool_search reaches its deferred tools",
  );
  console.log(
    JSON.stringify({
      host: observed.packageDir,
      version: observed.version,
      activeTools: observed.activeTools.filter((name) => name.startsWith("macuse")),
    }),
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
