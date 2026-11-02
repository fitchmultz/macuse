import assert from "node:assert/strict";

/** @typedef {import("./engineering-qualification-workspace.mjs").QualificationWorkspace} Workspace */
/** @typedef {{ name: string, path: string, valid: string, invalid: string, args: string[], diagnostic: string }} CompilerControl */

/** @param {Workspace} ws @param {CompilerControl} control */
function checkCompiler(ws, control) {
  ws.write(control.path, control.valid);
  const good = ws.run("./node_modules/.bin/tsc", control.args);
  assert.equal(
    good.status,
    0,
    `${control.name}: valid project failed: ${good.stdout} ${good.stderr}`,
  );
  ws.write(control.path, control.invalid);
  const bad = ws.run("./node_modules/.bin/tsc", control.args);
  assert.notEqual(bad.status, 0, `${control.name}: invalid project passed`);
  assert.ok(
    bad.stdout.includes(`${control.path}(1,`) && bad.stdout.includes(control.diagnostic),
    `${control.name}: unexpected diagnostic ${bad.stdout} ${bad.stderr}`,
  );
  ws.remove(control.path);
  console.log(`PASS ${control.name}: valid pass, ${control.diagnostic} at ${control.path}:1`);
}

/** @returns {CompilerControl[]} */
function controls() {
  return [
    {
      name: "checked JavaScript compiler",
      path: "tools/qualification-compiler.mjs",
      valid: "/** @type {number} */ export const value = 1;\n",
      invalid: "/** @type {number} */ export const value = 'wrong';\n",
      args: ["--noEmit"],
      diagnostic: "TS2322",
    },
    {
      name: "TypeScript compiler",
      path: "extensions/qualification-compiler.ts",
      valid: "export const value: number = 1;\n",
      invalid: "export const value: number = 'wrong';\n",
      args: ["--noEmit"],
      diagnostic: "TS2322",
    },
    {
      name: "declaration compiler",
      path: "tools/qualification-compiler.d.mts",
      valid: "export declare const value: number;\n",
      invalid: "export declare const value: MissingQualificationType;\n",
      args: ["--noEmit", "-p", "tsconfig.declarations.json"],
      diagnostic: "TS2304",
    },
    {
      name: "public native consumer",
      path: "tools/qualification-consumer.mjs",
      valid:
        "import { MacOSNative } from './macos-native.mjs'; await new MacOSNative().inspectApp(1);\n",
      invalid:
        "import { MacOSNative } from './macos-native.mjs'; await new MacOSNative().inspectApp('bad');\n",
      args: ["--noEmit"],
      diagnostic: "TS2345",
    },
  ];
}

/** @param {Workspace} ws */
export function qualifyCompiler(ws) {
  for (const control of controls()) {
    checkCompiler(ws, control);
  }
}
