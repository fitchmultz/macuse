import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Maintained files include untracked additions, not just the last commit. @returns {string[]} */
export function projectFiles() {
  return execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    encoding: "utf8",
  })
    .split("\0")
    .filter((path) => path !== "");
}

/** @param {string[]} files */
function checkNestedConfig(files) {
  const approved = new Set([
    ".gitignore",
    ".oxlintrc.json",
    ".oxfmtrc.json",
    "tsconfig.json",
    "tsconfig.declarations.json",
  ]);
  const config =
    /(?:^|\/)(?:\.gitignore|\.prettierignore|\.eslintignore|\.oxlint(?:rc(?:\..*)?|ignore)|\.oxfmt(?:rc(?:\..*)?|ignore)|tsconfig(?:\.[^/]*)?\.json)$/;
  const extra = files.filter((path) => config.test(path) && !approved.has(path));
  if (extra.length > 0) {
    throw new Error(`Unreviewed nested configuration: ${extra.join(", ")}`);
  }
}

/** @param {string} path */
function isMaintainedCode(path) {
  return /\.(?:[cm]?js|jsx|[cm]?ts|tsx)$/.test(path);
}
/** @param {string} path */
function isDeclaration(path) {
  return /\.d\.(?:ts|mts|cts)$/.test(path);
}
/** @param {string} path */
function recognizedSource(path) {
  return /^(?:extensions|lib|tools|\.github\/scripts)\//.test(path);
}

/** @param {string} [project] @returns {{ options: Record<string, unknown>, roots: Set<string> }} */
function compilerProject(project) {
  const args = ["--showConfig", ...(project === undefined ? [] : ["-p", project])];
  const text = execFileSync("./node_modules/.bin/tsc", args, { encoding: "utf8" });
  const config = /** @type {unknown} */ (JSON.parse(text));
  if (!isRecord(config) || !isRecord(config.compilerOptions) || !Array.isArray(config.files)) {
    throw new Error("Compiler did not report effective configuration and roots");
  }
  /** @type {Set<string>} */
  const roots = new Set();
  for (const file of config.files) {
    if (typeof file !== "string") {
      throw new Error("Invalid compiler root");
    }
    roots.add(file.replace(/^\.\//, ""));
  }
  return { options: config.compilerOptions, roots };
}

/** @param {Record<string, unknown>} options @param {boolean} declarations */
function checkCompilerOptions(options, declarations) {
  const mandatory = [
    "strict",
    "noImplicitReturns",
    "noFallthroughCasesInSwitch",
    "noImplicitOverride",
    "noUncheckedIndexedAccess",
    "exactOptionalPropertyTypes",
    "noUncheckedSideEffectImports",
    "forceConsistentCasingInFileNames",
    "noEmit",
  ];
  for (const name of mandatory) {
    if (options[name] !== true) {
      throw new Error(`Compiler option ${name} must be enabled`);
    }
  }
  const strictOptions = [
    "noImplicitAny",
    "strictNullChecks",
    "strictFunctionTypes",
    "strictBindCallApply",
    "strictPropertyInitialization",
    "noImplicitThis",
    "alwaysStrict",
    "useUnknownInCatchVariables",
  ];
  for (const name of strictOptions) {
    if (options[name] === false) {
      throw new Error(`Compiler option ${name} weakens strict mode`);
    }
  }
  if (
    options.noCheck !== false ||
    options.allowJs !== !declarations ||
    options.checkJs !== !declarations ||
    (declarations && options.skipLibCheck !== false)
  ) {
    throw new Error("Compiler JavaScript, declaration, or semantic checking is reduced");
  }
}

/** @param {string[]} files */
export function checkCoverage(files) {
  checkNestedConfig(files);
  const source = compilerProject();
  const declarations = compilerProject("tsconfig.declarations.json");
  checkCompilerOptions(source.options, false);
  checkCompilerOptions(declarations.options, true);
  for (const path of files.filter(isMaintainedCode)) {
    if (!existsSync(path) || !recognizedSource(path)) {
      throw new Error(`Unclassified or missing maintained source: ${path}`);
    }
    const roots = isDeclaration(path) ? declarations.roots : source.roots;
    if (!roots.has(path)) {
      throw new Error(`Compiler root missing maintained source: ${path}`);
    }
  }
}

/** @param {string} path @returns {string} */
export function readProjectFile(path) {
  return readFileSync(path, "utf8");
}
