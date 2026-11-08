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
  const result = spawnSync(
    process.execPath,
    [
      join(root, bin.pi),
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
  const output = processOutput(result.stderr, result.stdout);
  assert.equal(result.status, 0, output);
  /** @type {Record<string, unknown>[]} */
  const events = [];
  for (const line of result.stdout.split("\n")) {
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
  const observedJson = /** @type {unknown} */ (JSON.parse(readFileSync(observation, "utf8")));
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
  const observed = {
    packageDir,
    version: observedVersion,
    tools: readStringArray("tools"),
    activeTools: readStringArray("activeTools"),
    commands: readStringArray("commands"),
  };
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
