import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveVendorCodex } from "../../lib/vendor-installation.mjs";

test("a selected package never silently falls back to a stale legacy executable", t => {
  const root = mkdtempSync(join(tmpdir(), "macuse-codex-layout-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "codex-cli"), { recursive: true });
  writeFileSync(join(root, "codex"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const descriptor = join(root, "codex-cli/codex-package.json");
  for (const manifest of [
    "{",
    JSON.stringify(null),
    JSON.stringify({ layoutVersion: 2, version: "next", entrypoint: "bin/codex" }),
    JSON.stringify({ layoutVersion: 1, entrypoint: "bin/codex" }),
    JSON.stringify({ layoutVersion: 1, version: "next", entrypoint: "/other/codex" }),
    JSON.stringify({ layoutVersion: 1, version: "next", entrypoint: "../codex" }),
  ]) {
    writeFileSync(descriptor, manifest);
    assert.throws(() => resolveVendorCodex(root), /descriptor|escapes/);
  }
  rmSync(descriptor);
  symlinkSync("missing-descriptor.json", descriptor);
  assert.throws(() => resolveVendorCodex(root), /Invalid Codex package descriptor/);
  rmSync(descriptor);
  writeFileSync(descriptor, JSON.stringify({ layoutVersion: 1, version: "next", entrypoint: "missing" }));
  assert.throws(() => resolveVendorCodex(root), /Selected Codex executable is unavailable/);
});

test("missing, directory and non-executable legacy targets fail before launch", t => {
  const root = mkdtempSync(join(tmpdir(), "macuse-codex-unavailable-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "codex");
  assert.throws(() => resolveVendorCodex(root), /Selected Codex executable is unavailable/);
  mkdirSync(path);
  assert.throws(() => resolveVendorCodex(root), /not a regular file/);
  rmSync(path, { recursive: true });
  writeFileSync(path, "#!/bin/sh\nexit 0\n");
  chmodSync(path, 0o644);
  assert.throws(() => resolveVendorCodex(root), /Selected Codex executable is unavailable/);
});
