import { createHash } from "node:crypto";
import { open, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveLaunch } from "./cua-runtime.mjs";
import { resolveVendorCodex, vendorResources } from "./vendor-installation.mjs";

/**
 * @typedef {object} InventoryArtifact
 * @property {string} name
 * @property {string} path
 * @property {string} [realpath]
 * @property {number} [bytes]
 * @property {string} [sha256]
 * @property {string} [error]
 */

/**
 * @typedef {object} RuntimeInventoryReport
 * @property {1} schemaVersion
 * @property {string} resources
 * @property {string} scope
 * @property {InventoryArtifact[]} artifacts
 * @property {{ node: string, runtime: string, cuaRepl: string, sky: string, codex: string | null }} [versions]
 * @property {string} [codexLayout]
 * @property {boolean} [ok]
 * @property {string} [error]
 */

/**
 * Hash an open file through its vendor byte stream.
 * @param {import("node:fs/promises").FileHandle} file
 * @returns {Promise<string>}
 */
async function hashStream(file) {
  const hash = createHash("sha256");
  for await (const chunk of file.createReadStream({ autoClose: false })) {
    // The vendor stream yields Buffer chunks for binary files; the
    // isBuffer guard keeps the hash input BinaryLike-typed.
    if (Buffer.isBuffer(chunk)) {
      hash.update(chunk);
    }
  }
  return hash.digest("hex");
}

/**
 * @param {string} name
 * @param {string} path
 * @returns {Promise<InventoryArtifact>}
 */
async function fingerprint(name, path) {
  try {
    const resolvedPath = await realpath(path);
    const file = await open(resolvedPath, "r");
    try {
      const before = await file.stat();
      if (!before.isFile()) {
        throw new Error("Not a regular file.");
      }
      const digest = await hashStream(file);
      const after = await file.stat();
      if (
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs ||
        (await realpath(path)) !== resolvedPath
      ) {
        throw new Error(
          "Artifact changed while being inventoried; retry after the update finishes.",
        );
      }
      return { name, path, realpath: resolvedPath, bytes: after.size, sha256: digest };
    } finally {
      await file.close();
    }
  } catch (error) {
    return { name, path, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isJsonObject = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Read a vendor JSON descriptor and validate the requested string fields.
 * @template {string} K
 * @param {string} path
 * @param {string} label
 * @param {K[]} fields
 * @returns {Promise<Record<K, string>>}
 */
async function readDescriptor(path, label, fields) {
  const parsed = /** @type {unknown} */ (JSON.parse(await readFile(path, "utf8")));
  if (!isJsonObject(parsed)) {
    throw new Error(`${label} is not a JSON object: ${path}`);
  }
  const descriptor = parsed;
  /** @type {Record<string, string>} */
  const result = {};
  for (const field of fields) {
    const value = descriptor[field];
    if (typeof value !== "string" || value === "") {
      throw new Error(`${label} is missing its ${field} string field: ${path}`);
    }
    result[field] = value;
  }
  return result;
}

// Inspect launch inputs without importing vendor code, executing binaries, or connecting to services.
/**
 * @param {{ resourcesPath?: string }} [options]
 * @returns {Promise<RuntimeInventoryReport>}
 */
export async function runtimeInventory({ resourcesPath = vendorResources() } = {}) {
  const resources = resolve(resourcesPath);
  /** @type {RuntimeInventoryReport} */
  const report = { schemaVersion: 1, resources, scope: "primary-launch-files", artifacts: [] };
  try {
    const launch = await resolveLaunch({ resourcesPath: resources });
    const codex = resolveVendorCodex(resources);
    const modules = launch.env.NODE_REPL_NODE_MODULE_DIRS;
    const cuaPackage = join(modules, "@oai", "cua-repl", "package.json");
    const skyPackage = join(modules, "@oai", "sky", "package.json");
    const manifestPath = join(resources, "cua_node", "manifest.json");
    const [manifest, cua, sky] = await Promise.all([
      readDescriptor(manifestPath, "Runtime manifest", ["node_version", "runtime_archive_version"]),
      readDescriptor(cuaPackage, "cua-repl package", ["version"]),
      readDescriptor(skyPackage, "sky package", ["version"]),
    ]);
    report.versions = {
      node: manifest.node_version,
      runtime: manifest.runtime_archive_version,
      cuaRepl: cua.version,
      sky: sky.version,
      codex: codex.version ?? null,
    };
    report.codexLayout = codex.layout;
    /** @type {[string, string][]} */
    const paths = [
      ["runtime-manifest", manifestPath],
      ["node", launch.command],
      ["node-repl", launch.env.CUA_REPL_NODE_REPL_PATH],
      ["cua-repl-package", cuaPackage],
      ["cua-repl-entry", launch.args[0]],
      ["sky-package", skyPackage],
      ["sky-service", fileURLToPath(launch.env.MACUSE_SKY_SERVICE_URL)],
      ["codex", codex.path],
      ...(codex.manifestPath !== undefined
        ? [/** @type {[string, string]} */ (["codex-descriptor", codex.manifestPath])]
        : []),
    ];
    // Serial hashing avoids reading several large native binaries simultaneously.
    for (const [name, path] of paths) {
      report.artifacts.push(await fingerprint(name, path));
    }
    report.ok = report.artifacts.every((artifact) => artifact.error === undefined);
  } catch (error) {
    report.ok = false;
    report.error = error instanceof Error ? error.message : String(error);
  }
  return report;
}
