import assert from "node:assert/strict";
import { afterEach, mock, test as nodeTest } from "node:test";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { nativeRequirementChecks } from "../macuse-doctor.mjs";

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
if (platformDescriptor === undefined) {
  assert.fail("process.platform descriptor missing");
}
/**
 * @template T
 * @param {T[]} values
 * @param {number} index
 * @returns {T}
 */
const at = (values, index) => {
  const found = values[index];
  if (found === undefined) {
    assert.fail(`Missing value at ${index}`);
  }
  return found;
};
afterEach(() => {
  mock.restoreAll();
  syncBuiltinESMExports();
  Object.defineProperty(process, "platform", platformDescriptor);
});

/**
 * @param {Array<{ ok: boolean, stdout?: string, stderr?: string }>} responses
 * @param {string} [platform]
 */
function doctorRunner(responses, platform = "darwin") {
  /** @type {Array<{ command: string, args: string[], opts: { timeout: number } }>} */
  const calls = [];
  Object.defineProperty(process, "platform", { ...platformDescriptor, value: platform });
  mock.method(
    childProcess,
    "spawnSync",
    (
      /** @type {string} */ command,
      /** @type {string[]} */ args,
      /** @type {{ timeout: number }} */ opts,
    ) => {
      calls.push({ command, args, opts });
      const response = responses.shift();
      if (response === undefined) {
        assert.fail(`Unexpected doctor command ${command}`);
      }
      return {
        status: response.ok ? 0 : 1,
        stdout: response.stdout ?? "",
        stderr: response.stderr ?? "",
      };
    },
  );
  syncBuiltinESMExports();
  return { calls };
}

nodeTest("doctor distinguishes missing compiler from unknown trust without attempting AX", () => {
  const f = doctorRunner([{ ok: false, stderr: "xcrun: unable to find swiftc" }]);
  const checks = nativeRequirementChecks();
  assert.equal(at(checks, 0).status, "fail");
  assert.match(at(checks, 0).summary, /unable to find swiftc/);
  assert.match(at(checks, 1).summary, /Unknown.*not checked/);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(at(f.calls, 0).args, ["--find", "swiftc"]);
});

for (const trusted of [true, false, undefined]) {
  nodeTest(
    `doctor reports native Accessibility trust ${String(trusted)} without permission prompts`,
    () => {
      const f = doctorRunner([
        { ok: true, stdout: "/usr/bin/swiftc" },
        { ok: true, stdout: JSON.stringify({ accessibilityTrusted: trusted }) },
      ]);
      const checks = nativeRequirementChecks();
      assert.equal(at(checks, 1).status, trusted === true ? "pass" : "fail");
      assert.match(
        at(checks, 1).summary,
        trusted === undefined
          ? /trust is unknown/
          : new RegExp(`accessibilityTrusted=${String(trusted)}`),
      );
      assert.equal(f.calls.length, 2);
      assert.ok(f.calls.every((call) => call.opts.timeout > 0));
    },
  );
}

nodeTest(
  "doctor preserves native compile/runtime failure instead of diagnosing permission denial",
  () => {
    doctorRunner([
      { ok: true, stdout: "/usr/bin/swiftc" },
      { ok: false, stderr: "Native helper compilation failed: missing SDK" },
    ]);
    const checks = nativeRequirementChecks();
    assert.equal(at(checks, 1).status, "fail");
    assert.match(at(checks, 1).summary, /trust unknown.*compilation failed: missing SDK/);
    doctorRunner([], "linux");
    const linuxChecks = nativeRequirementChecks();
    assert.equal(at(linuxChecks, 0).status, "fail");
  },
);
