/** @typedef {{ name: string, command: string, args: string[] }} Gate */

/** Independent acceptance checks. The runner reports every result before failing. @type {Gate[]} */
export const compatGates = [
  { name: "lint", command: "npm", args: ["run", "lint"] },
  { name: "lint:agent", command: "npm", args: ["run", "lint:agent"] },
  { name: "compiler:source", command: "npm", args: ["exec", "--", "tsc", "--noEmit"] },
  {
    name: "compiler:declarations",
    command: "npm",
    args: ["exec", "--", "tsc", "--noEmit", "-p", "tsconfig.declarations.json"],
  },
  { name: "test", command: "npm", args: ["test"] },
  { name: "format", command: "npm", args: ["run", "format:check"] },
  { name: "lock-freshness", command: "node", args: ["tools/check-lock-freshness.mjs"] },
  { name: "policy", command: "node", args: ["tools/check-engineering-policy.mjs"] },
  { name: "extension", command: "node", args: ["tools/validate-macuse.mjs", "extension"] },
  // The host probe drives the macuse Pi tool, which registers only on macOS. Elsewhere
  // tools/tests/pi-lifecycle.test.mjs asserts the empty Pi surface through the same SDK.
  ...(process.platform === "darwin"
    ? [{ name: "pi-host", command: "node", args: ["tools/validate-pi-host.mjs"] }]
    : []),
  { name: "package", command: "npm", args: ["run", "pack:check"] },
  { name: "proof-help", command: "node", args: ["tools/qualify-independent-proof.mjs", "--help"] },
];
