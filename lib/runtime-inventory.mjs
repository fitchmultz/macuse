import { createHash } from "node:crypto";
import { open, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveLaunch } from "./cua-runtime.mjs";
import { resolveVendorCodex, vendorResources } from "./vendor-installation.mjs";

async function fingerprint(name, path) {
  try {
    const resolvedPath = await realpath(path);
    const file = await open(resolvedPath, "r");
    try {
      const before = await file.stat();
      if (!before.isFile()) throw new Error("Not a regular file.");
      const hash = createHash("sha256");
      for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk);
      const after = await file.stat();
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
        || await realpath(path) !== resolvedPath) throw new Error("Artifact changed while being inventoried; retry after the update finishes.");
      return { name, path, realpath: resolvedPath, bytes: after.size, sha256: hash.digest("hex") };
    } finally { await file.close(); }
  } catch (error) {
    return { name, path, error: error.message };
  }
}

// Inspect launch inputs without importing vendor code, executing binaries, or connecting to services.
export async function runtimeInventory({ resourcesPath = vendorResources() } = {}) {
  const resources = resolve(resourcesPath);
  const report = { schemaVersion: 1, resources, scope: "primary-launch-files", artifacts: [] };
  try {
    const launch = await resolveLaunch({ resourcesPath: resources });
    const codex = resolveVendorCodex(resources);
    const modules = launch.env.NODE_REPL_NODE_MODULE_DIRS;
    const cuaPackage = join(modules, "@oai", "cua-repl", "package.json");
    const skyPackage = join(modules, "@oai", "sky", "package.json");
    const manifestPath = join(resources, "cua_node", "manifest.json");
    const [manifest, cua, sky] = await Promise.all([manifestPath, cuaPackage, skyPackage].map(async path => JSON.parse(await readFile(path, "utf8"))));
    report.versions = { node: manifest.node_version, runtime: manifest.runtime_archive_version, cuaRepl: cua.version, sky: sky.version, codex: codex.version ?? null };
    report.codexLayout = codex.layout;
    const paths = [
      ["runtime-manifest", manifestPath], ["node", launch.command], ["node-repl", launch.env.CUA_REPL_NODE_REPL_PATH],
      ["cua-repl-package", cuaPackage], ["cua-repl-entry", launch.args[0]],
      ["sky-package", skyPackage], ["sky-service", fileURLToPath(launch.env.MACUSE_SKY_SERVICE_URL)],
      ["codex", codex.path],
      ...(codex.manifestPath ? [["codex-descriptor", codex.manifestPath]] : []),
    ];
    // Serial hashing avoids reading several large native binaries simultaneously.
    for (const [name, path] of paths) report.artifacts.push(await fingerprint(name, path));
    report.ok = report.artifacts.every(artifact => !artifact.error);
  } catch (error) {
    report.ok = false;
    report.error = error.message;
  }
  return report;
}
