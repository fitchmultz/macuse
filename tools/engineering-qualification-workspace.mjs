import { spawnSync, execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { projectFiles } from "./engineering-policy-coverage.mjs";

/** An isolated copy of the current working tree for destructive qualification controls. */
export class QualificationWorkspace {
  /** @readonly @type {string} */
  root;

  constructor() {
    this.root = mkdtempSync(join(tmpdir(), "macuse-engineering-qualification-"));
    try {
      for (const path of projectFiles()) {
        const dest = join(this.root, path);
        mkdirSync(dirname(dest), { recursive: true });
        cpSync(path, dest);
      }
      symlinkSync(resolve("node_modules"), join(this.root, "node_modules"), "dir");
      execFileSync("git", ["init", "-q"], { cwd: this.root });
      execFileSync("git", ["add", "-A"], { cwd: this.root });
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  /** @param {string} path @param {string} source */
  write(path, source) {
    const dest = join(this.root, path);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, source);
  }

  /** @param {string} path */
  read(path) {
    return readFileSync(join(this.root, path), "utf8");
  }

  /** @param {string} path */
  remove(path) {
    rmSync(join(this.root, path), { force: true });
  }

  /** @param {string} command @param {string[]} args */
  run(command, args) {
    const result = spawnSync(command, args, {
      cwd: this.root,
      encoding: "utf8",
      maxBuffer: 50 * 1024 * 1024,
    });
    if (result.error !== undefined) {
      throw result.error;
    }
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  dispose() {
    rmSync(this.root, { recursive: true, force: true });
  }
}
