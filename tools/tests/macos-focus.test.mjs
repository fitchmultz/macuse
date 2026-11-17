import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nodeTest from "node:test";
import { launchHelperSession } from "../macos-helper-bundle.mjs";
import { MacOSNative } from "../macos-native.mjs";

// Read-only platform checks: no app activation, fixture creation, key/mouse events, or privacy prompts.
nodeTest(
  "native observer multiplexes requests and restarts cleanly",
  { skip: process.platform !== "darwin" },
  async () => {
    const native = new MacOSNative();
    try {
      const observations = await Promise.all([
        native.beginObservation(),
        native.beginObservation(),
      ]);
      assert.notEqual(observations[0].id, observations[1].id);
      const snapshots = await Promise.all(Array.from({ length: 4 }, () => native.snapshot()));
      for (const snapshot of snapshots) {
        assert.ok(snapshot.frontmost === null || Number.isInteger(snapshot.frontmost.pid));
        assert.ok(
          snapshot.focusedWindow === null || typeof snapshot.focusedWindow.token === "string",
        );
      }
      for (const { id, before } of observations) {
        const result = await native.endObservation(id);
        assert.deepEqual(result.before, before);
        assert.equal(result.coverage.applicationActivation, true);
        assert.equal(result.coverage.inputAttribution, false);
        assert.equal(result.coverage.windowDetails, "targetAppsOnly");
        for (const state of [result.before, result.after]) {
          if (state.focusedWindow) {
            assert.equal(state.focusedWindow.title, null);
            assert.equal(state.focusedWindow.document, null);
          }
        }
        assert.ok(Array.isArray(result.transitions));
        for (const event of result.transitions) {
          if (event.kind === "focused_window" && event.window !== null) {
            assert.equal(event.window.title, null);
            assert.equal(event.window.document, null);
          }
        }
      }
      await assert.rejects(native.endObservation(observations[0].id), /Unknown observation/);
      await native.stop();
      await native.stop();
      const restarted = await native.beginObservation();
      assert.notEqual(restarted.id, observations[0].id);
      await native.endObservation(restarted.id);
    } finally {
      await native.stop();
    }
  },
);

nodeTest(
  "invalid app identity never reports zero windows",
  { skip: process.platform !== "darwin" },
  async () => {
    const native = new MacOSNative();
    try {
      await assert.rejects(native.inspectApp(-1), /positive target PID/);
      // This test's Node process has no AX application/window service. A failed read is unknown, not zero.
      const app = await native.inspectApp(process.pid);
      assert.equal(app.windowsCount, null);
      assert.notEqual(app.windowsError, 0);
    } finally {
      await native.stop();
    }
  },
);

/**
 * @param {string} root
 * @param {string} name
 * @param {string} scriptBody
 * @returns {Promise<string>}
 */
async function createTestAppBundle(root, name, scriptBody) {
  const appPath = join(root, `${name}.app`);
  await mkdir(join(appPath, "Contents", "MacOS"), { recursive: true });
  await writeFile(
    join(appPath, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>${name}</string>
<key>CFBundleIdentifier</key><string>com.fitchmultz.macuse.test.${name.toLowerCase()}</string>
<key>LSUIElement</key><true/>
</dict></plist>
`,
  );
  await writeFile(join(appPath, "Contents", "MacOS", name), `#!/bin/sh\n${scriptBody}\n`, {
    mode: 0o755,
  });
  return appPath;
}

nodeTest(
  "launchHelperSession preserves timeout, caller abort, and helper exit stderr",
  { skip: process.platform !== "darwin" },
  async () => {
    /** @type {(error: Error) => void} */
    const ignoreDisconnect = (error) => {
      void error;
    };
    const dir = await mkdtemp(join(tmpdir(), "macuse-launch-test-"));
    try {
      const hangApp = await createTestAppBundle(
        dir,
        "HangHelper",
        'printf "%s" "$$" > "$(dirname "$2")/p"\nexec sleep 10',
      );
      await assert.rejects(
        launchHelperSession(hangApp, ignoreDisconnect, { startTimeoutMs: 150, stopGraceMs: 200 }),
        /Native helper did not connect within 150 ms\./,
      );

      const abortController = new AbortController();
      setTimeout(() => abortController.abort(new Error("user cancelled the call")), 80);
      await assert.rejects(
        launchHelperSession(hangApp, ignoreDisconnect, {
          startTimeoutMs: 5_000,
          stopGraceMs: 200,
          signal: abortController.signal,
        }),
        /user cancelled the call/,
      );

      const failApp = await createTestAppBundle(
        dir,
        "FailHelper",
        'echo "helper boom" >&2\nexit 2',
      );
      await assert.rejects(
        launchHelperSession(failApp, ignoreDisconnect, { startTimeoutMs: 5_000, stopGraceMs: 200 }),
        /LaunchServices failed to open MacuseHelper\.app.*helper boom/s,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
