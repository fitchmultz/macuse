#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { compatGates } from "./compat-gates.mjs";

/** @type {string[]} */
const failures = [];
for (const gate of compatGates) {
  console.log(`\n=== ${gate.name} ===`);
  const result = spawnSync(gate.command, gate.args, { stdio: "inherit" });
  if (result.error !== undefined || result.status !== 0) {
    failures.push(gate.name);
    console.error(
      `${gate.name}: failed (${result.error?.message ?? result.signal ?? result.status ?? "unknown"})`,
    );
  }
}
if (failures.length > 0) {
  console.error(`Acceptance failed: ${failures.join(", ")}`);
  process.exitCode = 1;
} else {
  console.log("All compatibility gates passed.");
}
