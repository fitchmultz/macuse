import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { parse as parseYaml } from "yaml";
import { compatGates } from "./compat-gates.mjs";

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** @param {string} path @returns {Record<string, unknown>} */
function jsonObject(path) {
  const value = /** @type {unknown} */ (JSON.parse(readFileSync(path, "utf8")));
  if (!isRecord(value)) {
    throw new Error(`${path}: expected an object`);
  }
  return value;
}
/** @param {string} label @param {unknown} actual @param {unknown} expected */
function same(label, actual, expected) {
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error(`${label}: policy mismatch`);
  }
}

/** Parse the baseline from the adopted standard, not a second editable baseline. */
function standardLint() {
  const standard = readFileSync("docs/reference/engineering-standard.md", "utf8");
  const appendix =
    standard.split("## Appendix A: Base Oxlint configuration")[1]?.split("## Appendix B:")[0] ?? "";
  const text = /```json\n([\s\S]*?)\n```/.exec(appendix)?.[1];
  if (text === undefined) {
    throw new Error("Cannot read the adopted Oxlint baseline");
  }
  const baseline = /** @type {unknown} */ (JSON.parse(text));
  if (
    !isRecord(baseline) ||
    !Array.isArray(baseline.overrides) ||
    !isRecord(baseline.overrides[0]) ||
    !isRecord(baseline.overrides[0].rules)
  ) {
    throw new Error("Invalid baseline override");
  }
  baseline.overrides[0].rules["typescript/no-floating-promises"] = [
    "error",
    {
      checkThenables: true,
      ignoreIIFE: false,
      ignoreVoid: false,
      allowForKnownSafeCalls: [{ from: "package", package: "node:test", name: ["nodeTest"] }],
      allowForKnownSafePromises: [],
    },
  ];
  return baseline;
}

function checkLintConfig() {
  const actual = jsonObject(".oxlintrc.json");
  const expected = {
    ...standardLint(),
    ignorePatterns: ["node_modules", ".scratch", "subagent-output"],
  };
  same("Oxlint effective configuration", actual, expected);
}

function checkFormatter() {
  const standard = readFileSync("docs/reference/engineering-standard.md", "utf8");
  const section = standard.split("### 7.1 Formatter ownership")[1]?.split("### 7.2")[0] ?? "";
  const text = /```json\n([\s\S]*?)\n```/.exec(section)?.[1];
  if (text === undefined) {
    throw new Error("Cannot read formatter baseline");
  }
  same(
    "Oxfmt configuration",
    jsonObject(".oxfmtrc.json"),
    /** @type {unknown} */ (JSON.parse(text)),
  );
  same(
    "Git ignore classifications",
    readFileSync(".gitignore", "utf8"),
    ".scratch/\nsubagent-output/\nconfigs/*.local.json\nnode_modules/\n",
  );
}

/** @type {[string, string, string[]]} */
const piHostGate = ["pi-host", "node", ["tools/validate-pi-host.mjs"]];
/** @type {Array<[string, string, string[]]>} */
const requiredGates = [
  ["lint", "npm", ["run", "lint"]],
  ["lint:agent", "npm", ["run", "lint:agent"]],
  ["compiler:source", "npm", ["exec", "--", "tsc", "--noEmit"]],
  [
    "compiler:declarations",
    "npm",
    ["exec", "--", "tsc", "--noEmit", "-p", "tsconfig.declarations.json"],
  ],
  ["test", "npm", ["test"]],
  ["format", "npm", ["run", "format:check"]],
  ["lock-freshness", "node", ["tools/check-lock-freshness.mjs"]],
  ["policy", "node", ["tools/check-engineering-policy.mjs"]],
  ["extension", "node", ["tools/validate-macuse.mjs", "extension"]],
  // Mirrors compat-gates.mjs: the host probe drives the macuse Pi tool, which registers only on macOS.
  ...(process.platform === "darwin" ? [piHostGate] : []),
  ["package", "npm", ["run", "pack:check"]],
  ["proof-help", "node", ["tools/qualify-independent-proof.mjs", "--help"]],
];

function checkScripts() {
  const pkg = jsonObject("package.json");
  if (!isRecord(pkg.scripts)) {
    throw new Error("Missing package scripts");
  }
  const required = {
    lint: "oxlint --deny-warnings .",
    "lint:agent": "oxlint --deny-warnings --format=agent .",
    "format:check": "oxfmt --check .",
    "check:compat": "node tools/check-compat.mjs",
    test: "node --test tools/tests/*.test.mjs",
    "pack:check": "npm pack --dry-run",
    ci: "npm run check:compat && node tools/validate-macuse.mjs quick",
  };
  for (const [name, command] of Object.entries(required)) {
    same(`package script ${name}`, pkg.scripts[name], command);
  }
  same(
    "Compatibility gates",
    compatGates.map((gate) => [gate.name, gate.command, gate.args]),
    requiredGates,
  );
}

function contractsJob() {
  const workflow = /** @type {unknown} */ (
    parseYaml(readFileSync(".github/workflows/ci.yml", "utf8"))
  );
  if (!isRecord(workflow) || !isRecord(workflow.jobs) || !isRecord(workflow.jobs.contracts)) {
    throw new Error("CI contracts job is missing");
  }
  same("CI triggers", workflow.on, {
    pull_request: { branches: ["main"] },
    push: { branches: ["main"] },
    workflow_dispatch: null,
  });
  return workflow.jobs.contracts;
}

/** @param {Record<string, unknown>} job */
function checkCiJob(job) {
  if (
    job.if !== undefined ||
    job.needs !== undefined ||
    job.strategy !== undefined ||
    job["continue-on-error"] !== undefined
  ) {
    throw new Error("CI contracts job may not skip or ignore failure");
  }
}

function checkCi() {
  const job = contractsJob();
  checkCiJob(job);
  const steps = job.steps;
  if (!Array.isArray(steps)) {
    throw new Error("CI contracts steps are missing");
  }
  const matches = steps.filter((step) => isRecord(step) && step.run === "npm run check:compat");
  if (matches.length !== 1 || !isRecord(matches[0])) {
    throw new Error("CI must run compatibility acceptance exactly once");
  }
  const step = matches[0];
  if (
    step.if !== undefined ||
    step["continue-on-error"] !== undefined ||
    step.shell !== undefined
  ) {
    throw new Error("CI acceptance step may not skip or ignore failure");
  }
}

export function checkPolicyConfig() {
  const standard = readFileSync("docs/reference/engineering-standard.md");
  same(
    "Adopted standard digest",
    createHash("sha256").update(standard).digest("hex"),
    "41b6d505b36007218ca56b7b3443fcbd96d994715da5a83aaca52b58af47d3d6",
  );
  checkLintConfig();
  checkFormatter();
  checkScripts();
  checkCi();
}
