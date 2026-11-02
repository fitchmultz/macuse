import assert from "node:assert/strict";
import { compatGates } from "./compat-gates.mjs";

/** @typedef {import("./engineering-qualification-workspace.mjs").QualificationWorkspace} Workspace */
/** @typedef {{name: string, gate: string, path: string, source: string, expected: string, replace?: [string, string]}} Fault */

/** @returns {Fault[]} */
function faults() {
  return [
    {
      name: "native lint",
      gate: "lint",
      path: "tools/qualification-fault.mjs",
      source: "debugger;\n",
      expected: "no-debugger",
    },
    {
      name: "semantic lint",
      gate: "lint",
      path: "tools/qualification-fault.mjs",
      source: 'export const value = JSON.parse("{}");\n',
      expected: "no-unsafe-assignment",
    },
    {
      name: "source compiler",
      gate: "compiler:source",
      path: "tools/qualification-fault.mjs",
      source: '/** @type {number} */\nexport const value = "bad";\n',
      expected: "TS2322",
    },
    {
      name: "declaration compiler",
      gate: "compiler:declarations",
      path: "tools/qualification-fault.d.mts",
      source: "export declare const value: MissingQualificationType;\n",
      expected: "TS2304",
    },
    {
      name: "formatter",
      gate: "format",
      path: "tools/qualification-fault.mjs",
      source: "export const value=1;\n",
      expected: "qualification-fault.mjs",
    },
    {
      name: "test assertion",
      gate: "test",
      path: "tools/tests/qualification-fault.test.mjs",
      source:
        'import assert from "node:assert/strict";\nimport nodeTest from "node:test";\nnodeTest("qualification assertion failure", () => {\n  assert.equal(1, 2);\n});\n',
      expected: "qualification assertion failure",
    },
    {
      name: "policy",
      gate: "policy",
      path: ".gitignore",
      source: "",
      replace: ["node_modules/\n", "node_modules/\n# unexpected policy change\n"],
      expected: "Git ignore classifications",
    },
    {
      name: "lock freshness",
      gate: "lock-freshness",
      path: "package.json",
      source: "",
      replace: ['"oxfmt": "0.75.0"', '"oxfmt": "0.74.0"'],
      expected: "package-lock.json is stale",
    },
  ];
}

/** @param {Workspace} ws @param {Fault} fault */
function checkFault(ws, fault) {
  const previous = fault.replace === undefined ? undefined : ws.read(fault.path);
  let changed = fault.source;
  if (previous !== undefined && fault.replace !== undefined) {
    assert.ok(previous.includes(fault.replace[0]), `${fault.name}: mutation anchor missing`);
    changed = previous.replace(fault.replace[0], fault.replace[1]);
  }
  ws.write(fault.path, changed);
  try {
    const result = ws.run("npm", ["run", "check:compat"]);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.notEqual(result.status, 0, `${fault.name}: aggregate swallowed failure`);
    assert.ok(
      output.includes(`${fault.gate}: failed`),
      `${fault.name}: intended gate did not fail`,
    );
    assert.ok(output.includes(fault.expected), `${fault.name}: missing intended diagnostic`);
    for (const gate of compatGates) {
      assert.ok(output.includes(`=== ${gate.name} ===`), `${fault.name}: skipped ${gate.name}`);
    }
  } finally {
    if (previous === undefined) {
      ws.remove(fault.path);
    } else {
      ws.write(fault.path, previous);
    }
  }
  console.log(`PASS acceptance propagates ${fault.name} and runs every independent gate`);
}

/** @param {Workspace} ws */
export function qualifyAcceptance(ws) {
  for (const fault of faults()) {
    checkFault(ws, fault);
  }
}
