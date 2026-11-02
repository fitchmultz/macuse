#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { projectFiles } from "./engineering-policy-coverage.mjs";
import { QualificationWorkspace } from "./engineering-qualification-workspace.mjs";
import { qualifyLint } from "./engineering-qualification-lint.mjs";
import { qualifyNodeTest } from "./engineering-qualification-node-test.mjs";
import { qualifyCompiler } from "./engineering-qualification-compiler.mjs";
import { qualifyIntegrity } from "./engineering-qualification-integrity.mjs";
import { qualifyAcceptance } from "./engineering-qualification-acceptance.mjs";

/** Digest both tracked edits and untracked files used to make the qualification copy. */
function inputDigest() {
  const hash = createHash("sha256");
  for (const path of projectFiles().sort()) {
    const bytes = readFileSync(path);
    hash.update(`${path}\0${bytes.length}\0`);
    hash.update(bytes);
  }
  return hash.digest("hex");
}

if (process.argv.includes("--help")) {
  console.log(
    "Usage: node tools/qualify-engineering-standard.mjs\nRun the standard's disposable controls in a temporary copy. No current source files are modified.",
  );
} else {
  if (process.argv.length !== 2) {
    throw new Error("Unknown qualification arguments; use --help.");
  }
  const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const digest = inputDigest();
  console.log(`Qualification base revision: ${revision}\nWorking-tree input digest: ${digest}`);
  const workspace = new QualificationWorkspace();
  try {
    qualifyLint(workspace);
    qualifyNodeTest(workspace);
    qualifyCompiler(workspace);
    qualifyIntegrity(workspace);
    qualifyAcceptance(workspace);
    if (inputDigest() !== digest) {
      throw new Error("Working-tree inputs changed during qualification.");
    }
    console.log("All engineering-standard qualification controls passed.");
  } finally {
    workspace.dispose();
  }
}
