import { constants, accessSync, lstatSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

export const vendorResources = () => process.env.MACUSE_CHATGPT_RESOURCES ?? "/Applications/ChatGPT.app/Contents/Resources";

// Resolve only the selected installation. Never fall back to PATH or another app.
export function resolveVendorCodex(resourcesPath = vendorResources()) {
  const resources = resolve(resourcesPath);
  const root = join(resources, "codex-cli");
  const manifestPath = join(root, "codex-package.json");
  let manifest;
  try {
    if (lstatSync(manifestPath, { throwIfNoEntry: false })) manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  }
  catch (error) {
    throw new Error(`Invalid Codex package descriptor ${manifestPath}: ${error.message}`, { cause: error });
  }
  let path, layout, version;
  if (manifest !== undefined) {
    if (manifest?.layoutVersion !== 1 || typeof manifest.version !== "string" || !manifest.version.trim()
      || typeof manifest.entrypoint !== "string" || !manifest.entrypoint.trim() || isAbsolute(manifest.entrypoint)) {
      throw new Error(`Unsupported Codex package descriptor ${manifestPath}: expected layoutVersion 1, version, and a relative entrypoint.`);
    }
    path = resolve(root, manifest.entrypoint);
    const fromRoot = relative(root, path);
    if (!fromRoot || fromRoot === ".." || fromRoot.startsWith("../") || isAbsolute(fromRoot)) {
      throw new Error(`Codex package entrypoint escapes its package directory: ${manifestPath}`);
    }
    layout = "package";
    version = manifest.version;
  } else {
    path = join(resources, "codex");
    layout = "legacy";
  }
  try {
    if (!statSync(path).isFile()) throw new Error("not a regular file");
    accessSync(path, constants.X_OK);
  } catch (error) {
    throw new Error(`Selected Codex executable is unavailable: ${path} (${error.message}). Check MACUSE_CHATGPT_RESOURCES and the vendor installation.`, { cause: error });
  }
  return { path, layout, ...(version ? { version, manifestPath } : {}) };
}
