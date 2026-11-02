import assert from "node:assert/strict";

/** @typedef {import("./engineering-qualification-workspace.mjs").QualificationWorkspace} Workspace */
/** @param {Workspace} ws @param {boolean} valid @param {string} expected */
function checkPolicy(ws, valid, expected) {
  const result = ws.run("node", ["tools/check-engineering-policy.mjs"]);
  if (valid) {
    assert.equal(result.status, 0, `policy baseline: ${result.stdout} ${result.stderr}`);
    return;
  }
  assert.notEqual(result.status, 0, `policy accepted ${expected}`);
  assert.ok(
    `${result.stdout}\n${result.stderr}`.includes(expected),
    `policy failed for another reason: ${result.stdout} ${result.stderr}`,
  );
}

/** @param {Workspace} ws @param {string} path @param {[string, string]} change @param {string} expected */
function policyMutation(ws, path, [before, after], expected) {
  const original = ws.read(path);
  assert.ok(original.includes(before), `${path}: missing control anchor`);
  ws.write(path, original.replace(before, after));
  try {
    checkPolicy(ws, false, expected);
  } finally {
    ws.write(path, original);
  }
  console.log(`PASS integrity rejects ${expected}`);
}

/** @param {Workspace} ws */
function checkDirectiveFaults(ws) {
  const path = "tools/qualification-unauthorized.mjs";
  ws.write(
    path,
    `export function run(value) {\n  // oxlint-disable-next-line no-param-reassign -- QX-006: Unauthorized copy.\n  value.field = 1;\n}\n`,
  );
  try {
    checkPolicy(ws, false, "Directive inventory mismatch");
  } finally {
    ws.remove(path);
  }
  policyMutation(
    ws,
    "tools/independent-proof-mcp.mjs",
    ["server.onclose = shutdown;", "server.onclose = () => { shutdown(); };"],
    "Directive inventory mismatch",
  );
  const unused = "tools/qualification-unused.mjs";
  ws.write(
    unused,
    "// oxlint-disable-next-line no-debugger -- QX-900: Unused control.\nexport const value = 1;\n",
  );
  const result = ws.run("./node_modules/.bin/oxlint", ["--deny-warnings", unused]);
  assert.equal(result.status, 1, "unused directive must fail lint");
  assert.ok(
    result.stdout.includes("Unused oxlint-disable directive"),
    `wrong unused-directive finding: ${result.stdout}`,
  );
  ws.remove(unused);
  console.log("PASS unauthorized, replaced, and unused directives fail");
}

/** @param {Workspace} ws */
function checkFormatting(ws) {
  const path = "tools/qualification-format.mjs";
  ws.write(path, "export const value = 1;\n");
  let result = ws.run("npm", ["run", "format:check"]);
  assert.equal(result.status, 0, `formatted tree failed: ${result.stdout} ${result.stderr}`);
  ws.write(path, "export const value=1;\n");
  result = ws.run("npm", ["run", "format:check"]);
  assert.notEqual(result.status, 0, "unformatted maintained source passed the actual gate");
  assert.ok(
    `${result.stdout}\n${result.stderr}`.includes(path),
    "format failure did not identify the source",
  );
  result = ws.run("./node_modules/.bin/oxfmt", [path]);
  assert.equal(result.status, 0, `format write failed: ${result.stdout} ${result.stderr}`);
  const formatted = ws.read(path);
  result = ws.run("./node_modules/.bin/oxfmt", [path]);
  assert.equal(result.status, 0, "second format failed");
  assert.equal(ws.read(path), formatted, "formatter is not idempotent");
  ws.remove(path);
  console.log("PASS formatting gate and idempotence");
}

/** @param {Workspace} ws */
function checkLockFreshness(ws) {
  const good = ws.run("node", ["tools/check-lock-freshness.mjs"]);
  assert.equal(good.status, 0, `fresh lockfile failed: ${good.stdout} ${good.stderr}`);
  const original = ws.read("package.json");
  assert.ok(original.includes('"oxfmt": "0.75.0"'), "lock control dependency is missing");
  ws.write("package.json", original.replace('"oxfmt": "0.75.0"', '"oxfmt": "0.74.0"'));
  try {
    const stale = ws.run("node", ["tools/check-lock-freshness.mjs"]);
    assert.notEqual(stale.status, 0, "stale lockfile passed freshness gate");
    assert.ok(
      stale.stderr.includes("package-lock.json is stale"),
      `wrong lockfile failure: ${stale.stderr}`,
    );
  } finally {
    ws.write("package.json", original);
  }
  console.log("PASS generated lockfile freshness");
}

/** @param {Workspace} ws */
function checkFixSequence(ws) {
  for (const script of ["lint:fix", "format"]) {
    const result = ws.run("npm", ["run", script]);
    assert.equal(result.status, 0, `${script} failed: ${result.stdout} ${result.stderr}`);
  }
  const diff = ws.run("git", ["diff", "--exit-code"]);
  assert.equal(
    diff.status,
    0,
    `lint-fix/format changed a clean tree: ${diff.stdout} ${diff.stderr}`,
  );
  console.log("PASS lint-fix and format leave the clean tree unchanged");
}

/** @param {Workspace} ws */
export function qualifyIntegrity(ws) {
  checkPolicy(ws, true, "baseline");
  policyMutation(
    ws,
    ".oxlintrc.json",
    ['"no-debugger": "error"', '"no-debugger": "off"'],
    "Oxlint effective configuration",
  );
  policyMutation(
    ws,
    ".oxlintrc.json",
    ['"rules": {', '"rules": { "no-duplicate-case": "off",'],
    "Oxlint effective configuration",
  );
  policyMutation(
    ws,
    "tsconfig.json",
    ['"tools/**/*.mjs",', ""],
    "Compiler root missing maintained source",
  );
  policyMutation(
    ws,
    ".github/workflows/ci.yml",
    ["  pull_request:\n    branches: [main]\n", ""],
    "CI triggers",
  );
  checkDirectiveFaults(ws);
  checkFormatting(ws);
  checkLockFreshness(ws);
  checkFixSequence(ws);
}
