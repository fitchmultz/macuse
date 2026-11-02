import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import nodeTest from "node:test";

const exec = promisify(execFile);
const cli = new URL("../macuse.mjs", import.meta.url);
/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
/** @param {string} text @returns {Record<string, unknown>} */
const parseReport = (text) => {
  /** @type {unknown} */
  const parsed = JSON.parse(text);
  assert.ok(isRecord(parsed), "Corrupt runtime inventory report");
  return parsed;
};
/** @param {Record<string, unknown>} report @returns {Array<Record<string, unknown>>} */
const artifactsOf = (report) => {
  const artifacts = report.artifacts;
  return Array.isArray(artifacts) ? artifacts.filter((artifact) => isRecord(artifact)) : [];
};
/** @param {Record<string, unknown>} report @returns {Record<string, unknown>} */
const versionsOf = (report) => {
  const versions = report.versions;
  return isRecord(versions) ? versions : {};
};
/** @param {unknown} value @returns {value is { code: unknown, stdout: string }} */
const isExecFailure = (value) =>
  value instanceof Error &&
  "code" in value &&
  "stdout" in value &&
  typeof value.stdout === "string";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "macuse-inventory-"));
  const files = {
    "cua_node/manifest.json": JSON.stringify({
      node_path: "bin/node",
      node_repl_path: "bin/node_repl",
      node_modules: "lib/node_modules",
      node_version: "24.fixture",
      runtime_archive_version: "fixture-runtime",
    }),
    "cua_node/bin/node": "abc",
    "cua_node/bin/node_repl": "abc",
    "cua_node/lib/node_modules/@oai/cua-repl/package.json": JSON.stringify({
      version: "1.fixture",
      bin: { "cua-repl": "entry.mjs" },
    }),
    "cua_node/lib/node_modules/@oai/cua-repl/entry.mjs":
      "throw new Error('must not execute vendor code')",
    "cua_node/lib/node_modules/@oai/sky/package.json": JSON.stringify({
      version: "2.fixture",
      exports: { "./service": "./service.mjs" },
    }),
    "cua_node/lib/node_modules/@oai/sky/service.mjs":
      "throw new Error('must not import vendor code')",
    "codex-cli/codex-package.json": JSON.stringify({
      layoutVersion: 1,
      version: "3.fixture",
      entrypoint: "bin/codex",
    }),
    "codex-cli/bin/actual": "abc",
  };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  await chmod(join(root, "codex-cli/bin/actual"), 0o700);
  await symlink("actual", join(root, "codex-cli/bin/codex"));
  return root;
}

nodeTest(
  "runtime CLI fingerprints actual selected files without executing vendor code and detects binary drift",
  async () => {
    const root = await fixture();
    const options = { env: { ...process.env, MACUSE_CHATGPT_RESOURCES: root } };
    try {
      const first = parseReport(
        (await exec(process.execPath, [cli.pathname, "runtime"], options)).stdout,
      );
      assert.equal(first.ok, true);
      assert.equal(first.scope, "primary-launch-files");
      assert.deepEqual(first.versions, {
        node: "24.fixture",
        runtime: "fixture-runtime",
        cuaRepl: "1.fixture",
        sky: "2.fixture",
        codex: "3.fixture",
      });
      const binary = artifactsOf(first).find((artifact) => artifact.name === "codex");
      if (binary === undefined) {
        assert.fail("Expected a codex artifact");
      }
      assert.equal(
        binary.sha256,
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      );
      assert.equal(binary.bytes, 3);
      assert.equal(binary.realpath, await realpath(join(root, "codex-cli/bin/actual")));
      await writeFile(join(root, "codex-cli/bin/actual"), "changed");
      const out = join(root, "inventory.json");
      await exec(process.execPath, [cli.pathname, "runtime", "--out", out], options);
      const changed = parseReport(await readFile(out, "utf8"));
      const changedCodex = artifactsOf(changed).find((artifact) => artifact.name === "codex");
      if (changedCodex === undefined) {
        assert.fail("Expected a changed codex artifact");
      }
      assert.notEqual(changedCodex.sha256, binary.sha256);
      assert.equal(
        versionsOf(changed).codex,
        versionsOf(first).codex,
        "same declared version must not hide changed bytes",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

nodeTest(
  "runtime CLI returns nonzero structured missing-artifact evidence without falling back",
  async () => {
    const root = await fixture();
    try {
      await rm(join(root, "cua_node/bin/node_repl"));
      await assert.rejects(
        exec(process.execPath, [cli.pathname, "runtime"], {
          env: { ...process.env, MACUSE_CHATGPT_RESOURCES: root },
        }),
        (/** @type {unknown} */ error) => {
          if (!isExecFailure(error)) {
            return false;
          }
          assert.equal(error.code, 1);
          const report = parseReport(error.stdout);
          assert.equal(report.ok, false);
          const nodeArtifact = artifactsOf(report).find(
            (artifact) => artifact.name === "node-repl",
          );
          if (nodeArtifact === undefined) {
            assert.fail("Expected a node-repl artifact");
          }
          assert.match(String(nodeArtifact.error), /ENOENT/);
          const codexArtifact = artifactsOf(report).find((artifact) => artifact.name === "codex");
          if (codexArtifact === undefined) {
            assert.fail("Expected a codex artifact");
          }
          assert.ok(codexArtifact.sha256 !== undefined && codexArtifact.sha256 !== null);
          return true;
        },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
