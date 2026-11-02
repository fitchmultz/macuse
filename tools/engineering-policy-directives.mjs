import { readFileSync } from "node:fs";
import { directiveSites, nestedRegistrations } from "./engineering-directives.mjs";

/** @param {string} path */
function isSource(path) {
  return /\.(?:[cm]?js|jsx|[cm]?ts|tsx)$/.test(path);
}

/** @param {unknown[]} manifest @param {ReturnType<typeof directiveSites>} actual */
export function checkDirectiveInventory(manifest, actual) {
  const expectedKeys = manifest.map((item) => JSON.stringify(item));
  const actualKeys = actual.map((item) => JSON.stringify(item));
  if (
    new Set(expectedKeys).size !== expectedKeys.length ||
    new Set(actualKeys).size !== actualKeys.length
  ) {
    throw new Error("Duplicate exception selector");
  }
  const expected = new Set(expectedKeys);
  const seen = new Set(actualKeys);
  const unauthorized = actualKeys.filter((key) => !expected.has(key));
  const missing = expectedKeys.filter((key) => !seen.has(key));
  if (unauthorized.length > 0 || missing.length > 0) {
    throw new Error(
      `Directive inventory mismatch; unauthorized: ${unauthorized.join(", ")}; missing: ${missing.join(", ")}`,
    );
  }
}

/** @param {string[]} files */
export function checkDirectives(files) {
  const manifest = /** @type {unknown} */ (
    JSON.parse(readFileSync("configs/engineering-directive-sites.json", "utf8"))
  );
  if (!Array.isArray(manifest)) {
    throw new Error("Directive inventory must be an array");
  }
  const actual = files
    .filter(isSource)
    .flatMap((path) => directiveSites(path, readFileSync(path, "utf8")));
  checkDirectiveInventory(manifest, actual);
  const records = readFileSync("docs/reference/engineering-standard-records.md", "utf8");
  for (const site of actual) {
    if (!records.includes(`### ${site.id}:`)) {
      throw new Error(`Missing decision record for ${site.id}`);
    }
  }
  for (const path of files.filter((file) => /^tools\/tests\/.*\.test\.mjs$/.test(file))) {
    const nested = nestedRegistrations(path, readFileSync(path, "utf8"));
    if (nested.length > 0) {
      throw new Error(`${path}: use context subtests inside a running test`);
    }
  }
}
