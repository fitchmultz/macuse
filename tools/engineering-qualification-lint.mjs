import assert from "node:assert/strict";

/** @typedef {import("./engineering-qualification-workspace.mjs").QualificationWorkspace} Workspace */
/** @typedef {{ name: string, path: string, valid: string, invalid: string, rule: string, line: number }} Control */
/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @param {Control} control */
function matchesDiagnostic(value, control) {
  if (
    !isRecord(value) ||
    value.code !== control.rule ||
    value.filename !== control.path ||
    !Array.isArray(value.labels)
  ) {
    return false;
  }
  return value.labels.some(
    (label) => isRecord(label) && isRecord(label.span) && label.span.line === control.line,
  );
}

/** @param {Workspace} ws @param {Control} control */
export function checkControl(ws, control) {
  ws.write(control.path, control.valid);
  const good = ws.run("./node_modules/.bin/oxlint", [
    "--deny-warnings",
    "--format=json",
    control.path,
  ]);
  assert.equal(good.status, 0, `${control.name}: valid control: ${good.stdout} ${good.stderr}`);
  ws.write(control.path, control.invalid);
  const bad = ws.run("./node_modules/.bin/oxlint", [
    "--deny-warnings",
    "--format=json",
    control.path,
  ]);
  assert.equal(
    bad.status,
    1,
    `${control.name}: violation did not fail: ${bad.stdout} ${bad.stderr}`,
  );
  const result = /** @type {unknown} */ (JSON.parse(bad.stdout));
  assert.ok(
    isRecord(result) && Array.isArray(result.diagnostics),
    `${control.name}: no lint diagnostics`,
  );
  assert.ok(
    result.diagnostics.some((diagnostic) => matchesDiagnostic(diagnostic, control)),
    `${control.name}: expected ${control.rule} at ${control.path}:${control.line}; got ${bad.stdout}`,
  );
  ws.remove(control.path);
  console.log(
    `PASS ${control.name}: valid pass, ${control.rule} at ${control.path}:${control.line}`,
  );
}

/** @param {number} count */
function branches(count) {
  return `export function run(value) {\n${Array.from({ length: count }, (_, i) => `  if (value === ${i}) { return ${i}; }`).join("\n")}\n  return -1;\n}\n`;
}
/** @param {number} depth */
function nested(depth) {
  return `export function run(a, b, c, d) {\n${["a", "b", "c", "d", "a"]
    .slice(0, depth)
    .map((x) => `if (${x} === true) {`)
    .join("\n")}\nconsole.log(a, b, c, d);\n${"}\n".repeat(depth)}}\n`;
}
/** @param {number} count */
function declarations(count) {
  return Array.from({ length: count }, (_, i) => `export const item${i} = ${i};`).join("\n") + "\n";
}
/** @param {number} count */
function multiline(count) {
  return `export function run() {\n  return [\n${"    1,\n".repeat(count)}  ];\n}\n`;
}
/** @param {number} count */
function statements(count) {
  return `export function run() { ${"console.log(1); ".repeat(count)} }\n`;
}

const path = "tools/qualification-control.mjs";
const testPath = "tools/tests/qualification-control.test.mjs";

/** @returns {Control[]} */
function semanticControls() {
  const simple = "export const value = 1;\n";
  return [
    {
      name: "explicit baseline",
      path,
      valid: simple,
      invalid: "debugger;\n",
      rule: "eslint(no-debugger)",
      line: 1,
    },
    {
      name: "category-only",
      path,
      valid: "export function run(x) { switch (x) { case 1: return 1; default: return 0; } }\n",
      invalid:
        "export function run(x) { switch (x) { case 1: return 1; case 1: return 2; default: return 0; } }\n",
      rule: "eslint(no-duplicate-case)",
      line: 1,
    },
    {
      name: "unsafe assignment",
      path,
      valid: "const value = /** @type {unknown} */ (JSON.parse('{}'));\nexport { value };\n",
      invalid: "const value = JSON.parse('{}');\nexport { value };\n",
      rule: "typescript(no-unsafe-assignment)",
      line: 1,
    },
    {
      name: "unsafe assertion",
      path,
      valid: "const value = /** @type {unknown} */ (1);\nexport { value };\n",
      invalid:
        "const value = /** @type {string} */ (/** @type {unknown} */ (1));\nexport { value };\n",
      rule: "typescript(no-unsafe-type-assertion)",
      line: 1,
    },
    {
      name: "floating promise",
      path,
      valid: "await Promise.resolve();\n",
      invalid: "Promise.resolve();\n",
      rule: "typescript(no-floating-promises)",
      line: 1,
    },
    {
      name: "async callback",
      path,
      valid: "setTimeout(() => { Promise.resolve().catch(() => null); }, 0);\n",
      invalid: "setTimeout(async () => { await Promise.resolve(); }, 0);\n",
      rule: "typescript(no-misused-promises)",
      line: 1,
    },
    {
      name: "invalid rejection",
      path,
      valid:
        "/** @param {unknown} error */\nexport function forward(error) { return Promise.reject(error); }\n",
      invalid:
        "Promise.reject('failure').catch((/** @type {unknown} */ error) => { console.error(error); });\n",
      rule: "typescript(prefer-promise-reject-errors)",
      line: 1,
    },
  ];
}

/** @returns {Control[]} */
function projectScopeControls() {
  const typescriptPath = "extensions/qualification-control.ts";
  const testScope = "tools/tests/qualification-control.test.mjs";
  const declarationPath = "tools/qualification-control.d.mts";
  return [
    {
      name: "TypeScript semantic scope",
      path: typescriptPath,
      valid: "export const value: unknown = JSON.parse('{}');\n",
      invalid: "export const value = JSON.parse('{}');\n",
      rule: "typescript(no-unsafe-assignment)",
      line: 1,
    },
    {
      name: "test semantic scope",
      path: testScope,
      valid: "const value = /** @type {unknown} */ (JSON.parse('{}'));\nexport { value };\n",
      invalid: "const value = JSON.parse('{}');\nexport { value };\n",
      rule: "typescript(no-unsafe-assignment)",
      line: 1,
    },
    {
      name: "declaration type-safety scope",
      path: declarationPath,
      valid: "export type Value = unknown;\n",
      invalid: "export type Value = any;\n",
      rule: "typescript(no-explicit-any)",
      line: 1,
    },
    {
      name: "declaration semantic scope",
      path: declarationPath,
      valid: "type A = string; type B = number;\nexport type Value = A | B;\n",
      invalid: "type A = string; type B = string;\nexport type Value = A | B;\n",
      rule: "typescript(no-duplicate-type-constituents)",
      line: 2,
    },
  ];
}

/** @returns {Control[]} */
function productionControls() {
  return [
    {
      name: "production complexity",
      path,
      valid: branches(9),
      invalid: branches(10),
      rule: "eslint(complexity)",
      line: 1,
    },
    {
      name: "production depth",
      path,
      valid: nested(3),
      invalid: nested(4),
      rule: "eslint(max-depth)",
      line: 5,
    },
    {
      name: "production parameters",
      path,
      valid: "export function run(a = 1, b = 1, c = 1, d = 1) { return [a, b, c, d]; }\n",
      invalid:
        "export function run(a = 1, b = 1, c = 1, d = 1, e = 1) { return [a, b, c, d, e]; }\n",
      rule: "eslint(max-params)",
      line: 1,
    },
    {
      name: "production statements",
      path,
      valid: statements(40),
      invalid: statements(41),
      rule: "eslint(max-statements)",
      line: 1,
    },
    {
      name: "production function lines",
      path,
      valid: multiline(76),
      invalid: multiline(79),
      rule: "eslint(max-lines-per-function)",
      line: 1,
    },
    {
      name: "production file lines",
      path,
      valid: declarations(500),
      invalid: declarations(501),
      rule: "eslint(max-lines)",
      line: 501,
    },
  ];
}

/** @returns {Control[]} */
function testControls() {
  return [
    {
      name: "test complexity",
      path: testPath,
      valid: branches(14),
      invalid: branches(15),
      rule: "eslint(complexity)",
      line: 1,
    },
    {
      name: "test depth",
      path: testPath,
      valid: nested(4),
      invalid: nested(5),
      rule: "eslint(max-depth)",
      line: 6,
    },
    {
      name: "test parameters",
      path: testPath,
      valid:
        "export function run(a = 1, b = 1, c = 1, d = 1, e = 1, f = 1) { return [a, b, c, d, e, f]; }\n",
      invalid:
        "export function run(a = 1, b = 1, c = 1, d = 1, e = 1, f = 1, g = 1) { return [a, b, c, d, e, f, g]; }\n",
      rule: "eslint(max-params)",
      line: 1,
    },
  ];
}

/** @param {Workspace} ws */
export function qualifyLint(ws) {
  for (const control of [
    ...semanticControls(),
    ...projectScopeControls(),
    ...productionControls(),
    ...testControls(),
  ]) {
    checkControl(ws, control);
  }
  const longTest = "tools/tests/qualification-long.test.mjs";
  ws.write(longTest, declarations(550));
  const result = ws.run("./node_modules/.bin/oxlint", ["--deny-warnings", longTest]);
  assert.equal(result.status, 0, `long test profile: ${result.stdout} ${result.stderr}`);
  ws.remove(longTest);
  console.log("PASS test profile permits long source");
}
