import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/** Launch a task-owned real app. This is never a user's existing editor or Activity Monitor. */
/**
 * Compile the fixture app binary with the system Swift compiler.
 * @param {string} binary
 * @returns {Promise<void>}
 */
function compileFixture(binary) {
  return new Promise((resolve, reject) => {
    const compiler = spawn(
      "/usr/bin/xcrun",
      [
        "swiftc",
        fileURLToPath(new URL("./fixtures/actuator-app.swift", import.meta.url)),
        "-o",
        binary,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    const timer = setTimeout(() => compiler.kill("SIGKILL"), 60_000);
    compiler.stderr.on("data", (chunk) => {
      if (!Buffer.isBuffer(chunk)) {
        return;
      }
      stderr = (stderr + chunk.toString()).slice(-8000);
    });
    compiler.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    compiler.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Fixture compilation failed: ${stderr}`));
      }
    });
  });
}

/**
 * Wait for the fixture process to print its owned identity receipt.
 * @param {import("node:child_process").ChildProcessByStdio<null, import("node:stream").Readable, import("node:stream").Readable>} proc
 * @param {() => string} readStderr
 * @returns {Promise<void>}
 */
function fixtureReady(proc, readStderr) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("Fixture startup timed out.")), 10_000);
    /**
     * @param {Error} [error]
     */
    const finish = (error) => {
      clearTimeout(timer);
      proc.stdout.removeAllListeners("data");
      if (error !== undefined) {
        reject(error);
      } else {
        resolve();
      }
    };
    proc.once("error", finish);
    proc.once("close", () => finish(new Error(`Fixture exited before ready: ${readStderr()}`)));
    proc.stdout.on("data", (chunk) => {
      if (!Buffer.isBuffer(chunk)) {
        return;
      }
      output += chunk.toString();
      if (output.length > 4000) {
        finish(new Error("Fixture startup output exceeds budget."));
        return;
      }
      if (output.includes("\n")) {
        try {
          /** @type {unknown} */
          const parsed = JSON.parse(output.split("\n")[0] ?? "");
          const receipt = isRecord(parsed) ? parsed : {};
          finish(
            receipt.ready === true && receipt.pid === proc.pid
              ? undefined
              : new Error("Fixture identity receipt did not match owned process."),
          );
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      }
    });
  });
}

export async function startActuatorFixture() {
  if (process.platform !== "darwin") {
    throw new Error("The actuator fixture requires macOS.");
  }
  const directory = await mkdtemp(join(tmpdir(), "macuse-actuator-fixture-"));
  const app = `com.macuse.actuator-fixture.${randomUUID()}`;
  const contents = join(directory, "ActuatorFixture.app", "Contents");
  const binary = join(contents, "MacOS", "ActuatorFixture");
  /** @type {import("node:child_process").ChildProcessByStdio<null, import("node:stream").Readable, import("node:stream").Readable> | undefined} */
  let child;
  /** @type {Promise<void> | undefined} */
  let closing;
  const runStop = async () => {
    const proc = child;
    if (proc !== undefined && proc.exitCode === null && proc.signalCode === null) {
      /** @type {Promise<void>} */
      const exited = new Promise((resolve) => {
        const timer = setTimeout(() => proc.kill("SIGKILL"), 1000);
        proc.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
        proc.kill("SIGTERM");
      });
      await exited;
    }
    await rm(directory, { recursive: true, force: true });
  };
  /** @returns {Promise<void>} */
  const stop = () => {
    if (closing === undefined) {
      closing = runStop();
    }
    return closing;
  };
  try {
    await mkdir(join(contents, "MacOS"), { recursive: true });
    await writeFile(
      join(contents, "Info.plist"),
      `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${app}</string><key>CFBundleName</key><string>macuse actuator fixture</string><key>CFBundleExecutable</key><string>ActuatorFixture</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`,
    );
    await compileFixture(binary);
    child = spawn(await realpath(binary), [], { stdio: ["ignore", "pipe", "pipe"] });
    const proc = child;
    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      if (!Buffer.isBuffer(chunk)) {
        return;
      }
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    await fixtureReady(proc, () => stderr);
    return {
      app,
      pid: proc.pid,
      path: await realpath(join(directory, "ActuatorFixture.app")),
      title: "macuse disposable actuator fixture",
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
