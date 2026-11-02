#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temporary = mkdtempSync(join(tmpdir(), "macuse-lock-check-"));
try {
  const project = join(temporary, "macuse");
  mkdirSync(project);
  for (const file of ["package.json", "package-lock.json"]) {
    copyFileSync(file, join(project, file));
  }
  const result = spawnSync(
    "npm",
    ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd: project, encoding: "utf8" },
  );
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`Lockfile generation failed: ${result.error?.message ?? result.stderr}`);
  }
  if (!readFileSync("package-lock.json").equals(readFileSync(join(project, "package-lock.json")))) {
    throw new Error("package-lock.json is stale; regenerate it with npm install.");
  }
  console.log("package-lock.json matches npm's generated output.");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
