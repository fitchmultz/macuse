import { constants, accessSync, lstatSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

/**
 * @returns {string}
 */
export const vendorResources = () =>
  process.env.MACUSE_CHATGPT_RESOURCES ?? "/Applications/ChatGPT.app/Contents/Resources";

/**
 * @typedef {{ path: string, layout: "package" | "legacy", version?: string, manifestPath?: string }} VendorCodex
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isRecord = (value) => typeof value === "object" && value !== null;

/**
 * @param {string} manifestPath
 * @param {unknown} parsed
 * @returns {{ version: string, entrypoint: string }}
 */
function validateManifest(manifestPath, parsed) {
  if (
    !isRecord(parsed) ||
    parsed.layoutVersion !== 1 ||
    typeof parsed.version !== "string" ||
    parsed.version.trim() === "" ||
    typeof parsed.entrypoint !== "string" ||
    parsed.entrypoint.trim() === "" ||
    isAbsolute(parsed.entrypoint)
  ) {
    throw new Error(
      `Unsupported Codex package descriptor ${manifestPath}: expected layoutVersion 1, version, and a relative entrypoint.`,
    );
  }
  return { version: parsed.version, entrypoint: parsed.entrypoint };
}

/**
 * @param {string} root
 * @param {string} entrypoint
 * @param {string} manifestPath
 * @returns {string}
 */
function resolveEntrypoint(root, entrypoint, manifestPath) {
  const path = resolve(root, entrypoint);
  const fromRoot = relative(root, path);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith("../") || isAbsolute(fromRoot)) {
    throw new Error(`Codex package entrypoint escapes its package directory: ${manifestPath}`);
  }
  return path;
}

/**
 * @param {string} path
 * @returns {void}
 */
function assertExecutable(path) {
  try {
    if (!statSync(path).isFile()) {
      throw new Error("not a regular file");
    }
    accessSync(path, constants.X_OK);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Selected Codex executable is unavailable: ${path} (${reason}). Check MACUSE_CHATGPT_RESOURCES and the vendor installation.`,
      { cause: error },
    );
  }
}

// Resolve only the selected installation. Never fall back to PATH or another app.
/**
 * @param {string} [resourcesPath]
 * @returns {VendorCodex}
 */
export function resolveVendorCodex(resourcesPath = vendorResources()) {
  const resources = resolve(resourcesPath);
  const root = join(resources, "codex-cli");
  const manifestPath = join(root, "codex-package.json");
  /** @type {unknown} */
  let manifest;
  try {
    if (lstatSync(manifestPath, { throwIfNoEntry: false })) {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid Codex package descriptor ${manifestPath}: ${reason}`, {
      cause: error,
    });
  }
  if (manifest === undefined) {
    const legacyPath = join(resources, "codex");
    assertExecutable(legacyPath);
    return { path: legacyPath, layout: "legacy" };
  }
  const validated = validateManifest(manifestPath, manifest);
  const packagePath = resolveEntrypoint(root, validated.entrypoint, manifestPath);
  assertExecutable(packagePath);
  return {
    path: packagePath,
    layout: "package",
    version: validated.version,
    manifestPath,
  };
}
