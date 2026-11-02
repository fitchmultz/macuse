import assert from "node:assert/strict";
import nodeTest from "node:test";
import { directiveSites, nestedRegistrations } from "../engineering-directives.mjs";
import { checkDirectiveInventory } from "../engineering-policy-directives.mjs";

nodeTest("directive inventory binds the actual comment to its operation and owner", () => {
  const source = `
function guarded() {
  // oxlint-disable-next-line no-param-reassign -- QX-900: Fixture operation.
  value.field = 1;
}
`;
  const sites = directiveSites("tools/example.mjs", source);
  assert.equal(sites.length, 1);
  assert.doesNotThrow(() => checkDirectiveInventory(sites, sites));
  const moved = directiveSites(
    "tools/example.mjs",
    source.replace("value.field = 1", "value.other = 1"),
  );
  assert.throws(() => checkDirectiveInventory(sites, moved), /inventory mismatch/);
  const copied = directiveSites("tools/other.mjs", source);
  assert.throws(() => checkDirectiveInventory(sites, copied), /inventory mismatch/);
  assert.throws(() => checkDirectiveInventory(sites, [...sites, ...sites]), /Duplicate/);
  assert.throws(
    () =>
      directiveSites(
        "tools/example.mjs",
        source.replace("oxlint-disable-next-line", "oxlint-disable"),
      ),
    /unsupported directive/,
  );
  assert.deepEqual(
    directiveSites("tools/example.mjs", `const example = "oxlint-disable-next-line no-eval";`),
    [],
  );
});

nodeTest("imported registration inside a running test is not accepted as a subtest", () => {
  const top = `nodeTest("outer", () => { return 1; });`;
  const nested = `nodeTest("outer", () => { nodeTest("child", () => 1); });`;
  assert.deepEqual(nestedRegistrations("tools/tests/example.test.mjs", top), []);
  assert.equal(nestedRegistrations("tools/tests/example.test.mjs", nested).length, 1);
});
