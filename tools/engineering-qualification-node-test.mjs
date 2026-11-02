import { checkControl } from "./engineering-qualification-lint.mjs";

/** @typedef {import("./engineering-qualification-workspace.mjs").QualificationWorkspace} Workspace */
/** @typedef {import("./engineering-qualification-lint.mjs").Control} Control */

/** @returns {Control[]} */
function controls() {
  const path = "tools/tests/qualification-registration.test.mjs";
  const prefix = `import nodeTest from "node:test";\nimport assert from "node:assert/strict";\n`;
  const valid = `${prefix}nodeTest("parent", () => { assert.ok(true); });\n`;
  return [
    {
      name: "context subtest",
      path,
      valid,
      invalid: `${prefix}nodeTest("parent", (t) => { t.test("child", () => { assert.ok(true); }); });\n`,
      rule: "typescript(no-floating-promises)",
      line: 3,
    },
    {
      name: "same-named local function",
      path,
      valid,
      invalid: `function nodeTest() { return Promise.resolve(); }\nnodeTest();\n`,
      rule: "typescript(no-floating-promises)",
      line: 2,
    },
    {
      name: "same-named foreign import",
      path,
      valid,
      invalid: `import { nodeTest } from "./qualification-registration-helper.mjs";\nnodeTest();\n`,
      rule: "typescript(no-floating-promises)",
      line: 2,
    },
    {
      name: "floating work in test",
      path,
      valid: `${prefix}nodeTest("parent", async () => { assert.ok(true); await Promise.resolve(); });\n`,
      invalid: `${prefix}nodeTest("parent", () => { assert.ok(true); Promise.resolve(); });\n`,
      rule: "typescript(no-floating-promises)",
      line: 3,
    },
    {
      name: "unrelated floating work",
      path,
      valid: `${valid}await Promise.resolve();\n`,
      invalid: `${valid}Promise.resolve();\n`,
      rule: "typescript(no-floating-promises)",
      line: 4,
    },
  ];
}

/** @param {Workspace} ws */
export function qualifyNodeTest(ws) {
  ws.write(
    "tools/tests/qualification-registration-helper.mjs",
    "export function nodeTest() { return Promise.resolve(); }\n",
  );
  for (const control of controls()) {
    checkControl(ws, control);
  }
  const path = "tools/tests/qualification-registration.test.mjs";
  ws.write(
    path,
    `import { test as nodeTest, describe as nodeDescribe } from "node:test";\nimport assert from "node:assert/strict";\nnodeTest("top", () => { assert.ok(true); });\nawait nodeDescribe("suite", () => { nodeTest("inner", () => { assert.ok(true); }); });\n`,
  );
  const result = ws.run("./node_modules/.bin/oxlint", ["--deny-warnings", path]);
  if (result.status !== 0) {
    throw new Error(`named/suite registration: ${result.stdout} ${result.stderr}`);
  }
  ws.remove(path);
  ws.remove("tools/tests/qualification-registration-helper.mjs");
  console.log("PASS default and named Node registration, including suite-body registration");
}
