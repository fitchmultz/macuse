import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
export const proofTool = "macuse_independent_proof";
export const resetTool = "macuse_independent_proof_reset";
export const ordinaryField = "macuse-fixture-field";
export const contextField = "macuse-fixture-context-field";
export const unicode = "prefix 独立 👩🏽‍💻 e\u0301 suffix";
export const contextValue = "postwrite CHANGED";
export const safetyNote =
  "Owned disposable macuse fixture only: exercise observed radio controls and complete test fields, then restore their captured originals. No user apps, documents, selected-range, keyboard, or pointer actions.";
export const artifacts = [
  "package.json",
  "package-lock.json",
  "lib/cua-guard-service.mjs",
  "lib/app-state.mjs",
  "lib/isolated-executor.mjs",
  "tools/isolated-executor.swift",
  "lib/independent-proof-session.mjs",
  "lib/independent-proof-session.d.mts",
  "lib/independent-proof-tools.mjs",
  "lib/independent-proof-jsonl.mjs",
  "extensions/independent-proof.ts",
  "tools/independent-proof-cli.mjs",
  "tools/independent-proof-mcp.mjs",
  "tools/independent-proof-pi-worker.mjs",
  "tools/native-actuator.mjs",
  "tools/native-actuator.swift",
  "tools/actuator-fixture.mjs",
  "tools/fixtures/actuator-app.swift",
];

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export const isRecord = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * @typedef {{ pid: number, parent: number, executable: string, sha256?: string }} ProcessRow
 * @typedef {{ pid: number, parent: number, executable: string, sha256: string }} OwnedWorker
 * @typedef {{ kind: "cli" | "mcp" | "pi", name: string, host?: string }} TransportSpec
 * @typedef {{ method: string, mutationAttempted?: boolean, nativeAccepted?: boolean, verified?: boolean, outcome?: string, error?: string, dispatched?: boolean }} NativeActionRecord
 * @typedef {{ value?: unknown, error?: string, interruption?: string, actions?: Array<{ method: string, dispatched: boolean }> }} ExecutionRecord
 * @typedef {{ contentIndex: number, mimeType: string, sha256: string, bytes: number, width: number, height: number, pointPixelScale: number, captureRect: { width: number, height: number } }} ImageReceipt
 * @typedef {{ settled: boolean, workerStopped: boolean, nativeStopped: boolean, hostCallsPending: number }} SettlementRecord
 * @typedef {{ isError?: boolean, priorUnknown?: boolean, images?: ImageReceipt[], nativeActions?: NativeActionRecord[], execution?: ExecutionRecord, settlement?: SettlementRecord }} IndependentEvidence
 * @typedef {{ [key: string]: unknown, type?: string, text?: string, data?: string, mimeType?: string }} TransportBlock
 * @typedef {{ content: TransportBlock[], isError: boolean, details?: { independent?: IndependentEvidence } }} TransportResult
 * @typedef {{ pid: number, stderr: string, call: (tool: string, input: Record<string, unknown>) => Promise<TransportResult>, close: () => Promise<unknown> }} TransportClient
 * @typedef {{ action?: string, outcome?: string, error?: string, mutationAttempted?: boolean, verified?: boolean }} NativeEvidenceEntry
 * @typedef {{ nativeEvidence: NativeEvidenceEntry[] }} VisibleReport
 * @typedef {{ app: string, pid: number, path: string, title: string, stop: () => Promise<void> }} FixtureHandle
 * @typedef {{ bundleId: string, pid: number, path: string, processStartToken: string }} ObservedApp
 * @typedef {{ token: string, title?: string, document?: unknown }} ObservedWindow
 * @typedef {{ token: string, role?: string, value?: unknown, description?: string, title?: string, identifier?: string, windowToken?: string }} ObservedElement
 * @typedef {{ observationId: string, fullSnapshot?: boolean, app: ObservedApp, windows: ObservedWindow[], elements: ObservedElement[] }} ProofObservation
 * @typedef {{ name: string | undefined, fields: Record<string, ObservedElement>, window: ObservedWindow, birth: string }} ObservedState
 * @typedef {{ observe: (input: Record<string, unknown>) => Promise<ProofObservation>, act: (input: Record<string, unknown>) => Promise<Record<string, unknown>>, stop: () => Promise<void> }} NativeActuatorLike
 * @typedef {{ resolve: (result: TransportResult) => void, reject: (error: unknown) => void }} PendingCall
 */

/**
 * @param {unknown} value
 * @returns {value is new () => NativeActuatorLike}
 */
export const isActuatorClass = (value) => typeof value === "function";

/**
 * @param {unknown} value
 * @returns {value is () => Promise<FixtureHandle>}
 */
export const isFixtureLauncher = (value) => typeof value === "function";

/**
 * @param {unknown} value
 * @returns {value is IndependentEvidence}
 */
export const isIndependentEvidence = (value) =>
  isRecord(value) && typeof value.isError === "boolean";

/**
 * @param {unknown} value
 * @returns {value is TransportResult}
 */
export const isTransportResult = (value) =>
  isRecord(value) && Array.isArray(value.content) && typeof value.isError === "boolean";

/**
 * @param {unknown} value
 * @returns {TransportBlock[]}
 */
export const transportBlocks = (value) => {
  if (!Array.isArray(value)) {
    return [];
  }
  /** @type {TransportBlock[]} */
  const blocks = [];
  for (const block of value) {
    if (isRecord(block)) {
      blocks.push(block);
    }
  }
  return blocks;
};

/**
 * @param {unknown} value
 * @returns {value is ProofObservation}
 */
export const isProofObservation = (value) =>
  isRecord(value) &&
  isRecord(value.app) &&
  Array.isArray(value.windows) &&
  Array.isArray(value.elements);

/**
 * @param {unknown} meta
 * @returns {{ independent?: IndependentEvidence }}
 */
export const toTransportDetails = (meta) => {
  if (!isRecord(meta) || !isIndependentEvidence(meta.independent)) {
    return {};
  }
  return { independent: meta.independent };
};

/**
 * @param {string} path
 * @returns {Promise<string>}
 */
export async function hash(path) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    if (Buffer.isBuffer(chunk)) {
      digest.update(chunk);
    }
  }
  return digest.digest("hex");
}
/**
 * @param {string} root
 * @returns {Promise<Record<string, string>>}
 */
export async function sourceHashes(root) {
  /** @type {Record<string, string>} */
  const hashes = {};
  await Promise.all(
    artifacts.map(async (path) => {
      hashes[path] = await hash(join(root, path));
    }),
  );
  return hashes;
}
/**
 * @param {number} pid
 * @returns {boolean}
 */
export function exited(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH") {
      return true;
    }
    throw error;
  }
}
/**
 * @param {Iterable<OwnedWorker>} workers
 * @param {string} boundary
 * @returns {void}
 */
export function requireExited(workers, boundary) {
  for (const worker of workers) {
    assert.equal(
      exited(worker.pid),
      true,
      `${boundary}: owned worker remains: ${worker.executable}`,
    );
  }
}
/**
 * @param {number} pid
 * @returns {Promise<OwnedWorker[]>}
 */
export async function descendants(pid) {
  const { stdout } = await exec("/bin/ps", ["-axo", "pid=,ppid=,comm="], {
    maxBuffer: 4 * 1024 * 1024,
  });
  const rows = stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (match === null) {
      return [];
    }
    const executable = match[3];
    if (executable === undefined) {
      return [];
    }
    return [{ pid: Number(match[1]), parent: Number(match[2]), executable: executable.trim() }];
  });
  const owned = new Set([pid]);
  let previous = 0;
  do {
    previous = owned.size;
    for (const row of rows) {
      if (owned.has(row.parent)) {
        owned.add(row.pid);
      }
    }
  } while (previous !== owned.size);
  const selected = rows.filter((row) => row.pid !== pid && owned.has(row.pid));
  for (const row of selected) {
    assert.doesNotMatch(
      row.executable,
      /ChatGPT|SkyComputerUseService|node_repl|codex-cli|Codex Computer Use/i,
      "Unexpected vendor executable in the owned proof tree",
    );
  }
  const workers = selected.filter((row) =>
    /\/macuse\/(isolated-executor\/worker-|actuator-proof\/native-actuator-)/.test(row.executable),
  );
  assert.ok(
    workers.some((row) => row.executable.includes("/isolated-executor/worker-")),
    "Actual independent JSC child not observed",
  );
  assert.ok(
    workers.some((row) => row.executable.includes("/actuator-proof/native-actuator-")),
    "Actual independent native actuator child not observed",
  );
  return Promise.all(
    workers.map(async (row) => {
      const sha256 = await hash(row.executable);
      return { pid: row.pid, parent: row.parent, executable: row.executable, sha256 };
    }),
  );
}
