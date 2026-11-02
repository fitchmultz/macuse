import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../tools/isolated-executor.swift", import.meta.url));

/** The subprocess environment used for the worker, its compiler, and monitors. */
export const minimalEnvironment = { PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" };

/** @type {Promise<{ target: string, directory: string }> | undefined} */
let compilation;

/**
 * Lazily compile the sandbox worker once per source hash and architecture.
 * Failures clear the cached promise so the next call retries compilation.
 * @returns {Promise<{ target: string, directory: string }>}
 */
export async function binary() {
  if (process.platform !== "darwin") {
    throw new Error("The experimental isolated executor requires macOS.");
  }
  compilation ??= (async () => {
    const hash = createHash("sha256")
      .update(await readFile(source))
      .update(process.arch)
      .digest("hex")
      .slice(0, 20);
    const directory = join(homedir(), "Library", "Caches", "macuse", "isolated-executor");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const target = join(directory, `worker-${hash}`);
    try {
      await access(target);
    } catch {
      const temporary = `${target}.${randomUUID()}`;
      try {
        /** @type {Promise<void>} */
        const compiled = new Promise((resolve, reject) => {
          const compiler = spawn("/usr/bin/xcrun", ["swiftc", source, "-o", temporary], {
            env: minimalEnvironment,
            stdio: ["ignore", "ignore", "pipe"],
          });
          let diagnostic = "";
          compiler.stderr.on("data", (/** @type {Buffer} */ chunk) => {
            diagnostic = (diagnostic + chunk.toString()).slice(-8000);
          });
          compiler.once("error", reject);
          compiler.once("close", (code) =>
            code === 0
              ? resolve()
              : reject(new Error(`Executor compilation failed: ${diagnostic}`)),
          );
        });
        await compiled;
        await rename(temporary, target);
      } finally {
        await rm(temporary, { force: true });
      }
    }
    return { target, directory };
  })().catch((/** @type {unknown} */ error) => {
    compilation = undefined;
    throw error;
  });
  return compilation;
}
