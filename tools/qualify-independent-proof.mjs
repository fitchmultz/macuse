#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { release } from "node:os";
import { Readable } from "node:stream";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs, promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const exec = promisify(execFile);
const proofTool = "macuse_independent_proof";
const resetTool = "macuse_independent_proof_reset";
const ordinaryField = "macuse-fixture-field";
const contextField = "macuse-fixture-context-field";
const unicode = "prefix 独立 👩🏽‍💻 e\u0301 suffix";
const contextValue = "postwrite CHANGED";
const safetyNote =
  "Owned disposable macuse fixture only: exercise observed radio controls and complete test fields, then restore their captured originals. No user apps, documents, selected-range, keyboard, or pointer actions.";
const artifacts = [
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
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

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
const isActuatorClass = (value) => typeof value === "function";

/**
 * @param {unknown} value
 * @returns {value is () => Promise<FixtureHandle>}
 */
const isFixtureLauncher = (value) => typeof value === "function";

/**
 * @param {unknown} value
 * @returns {value is IndependentEvidence}
 */
const isIndependentEvidence = (value) => isRecord(value) && typeof value.isError === "boolean";

/**
 * @param {unknown} value
 * @returns {value is TransportResult}
 */
const isTransportResult = (value) =>
  isRecord(value) && Array.isArray(value.content) && typeof value.isError === "boolean";

/**
 * @param {unknown} value
 * @returns {TransportBlock[]}
 */
const transportBlocks = (value) => {
  if (!Array.isArray(value)) return [];
  /** @type {TransportBlock[]} */
  const blocks = [];
  for (const block of value) if (isRecord(block)) blocks.push(block);
  return blocks;
};

/**
 * @param {unknown} value
 * @returns {value is ProofObservation}
 */
const isProofObservation = (value) =>
  isRecord(value) &&
  isRecord(value.app) &&
  Array.isArray(value.windows) &&
  Array.isArray(value.elements);

/**
 * @param {unknown} meta
 * @returns {{ independent?: IndependentEvidence }}
 */
const toTransportDetails = (meta) => {
  if (!isRecord(meta) || !isIndependentEvidence(meta.independent)) return {};
  return { independent: meta.independent };
};

/**
 * @param {string} path
 * @returns {Promise<string>}
 */
async function hash(path) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path))
    if (Buffer.isBuffer(chunk)) digest.update(chunk);
  return digest.digest("hex");
}
/**
 * @param {string} root
 * @returns {Promise<Record<string, string>>}
 */
async function sourceHashes(root) {
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
function exited(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH")
      return true;
    throw error;
  }
}
/**
 * @param {Iterable<OwnedWorker>} workers
 * @param {string} boundary
 * @returns {void}
 */
function requireExited(workers, boundary) {
  for (const worker of workers)
    assert.equal(
      exited(worker.pid),
      true,
      `${boundary}: owned worker remains: ${worker.executable}`,
    );
}
/**
 * @param {number} pid
 * @returns {Promise<OwnedWorker[]>}
 */
async function descendants(pid) {
  const { stdout } = await exec("/bin/ps", ["-axo", "pid=,ppid=,comm="], {
    maxBuffer: 4 * 1024 * 1024,
  });
  const rows = stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (match === null) return [];
    const executable = match[3];
    if (executable === undefined) return [];
    return [{ pid: Number(match[1]), parent: Number(match[2]), executable: executable.trim() }];
  });
  const owned = new Set([pid]);
  let previous = 0;
  do {
    previous = owned.size;
    for (const row of rows) if (owned.has(row.parent)) owned.add(row.pid);
  } while (previous !== owned.size);
  const selected = rows.filter((row) => row.pid !== pid && owned.has(row.pid));
  for (const row of selected)
    assert.doesNotMatch(
      row.executable,
      /ChatGPT|SkyComputerUseService|node_repl|codex-cli|Codex Computer Use/i,
      "Unexpected vendor executable in the owned proof tree",
    );
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

// One outstanding JSONL call per owned process. No replay after timeout or lost acknowledgement.
/**
 * @param {string} script
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 * @param {string} kind
 * @returns {TransportClient}
 */
function jsonlClient(script, args, env, kind) {
  const child = spawn(process.execPath, [script, ...args], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  /** @type {PendingCall | undefined} */
  let pending;
  let buffered = "";
  let stderr = "";
  /** @type {Promise<{ code: number | null, signal: string | null, stderr: string }>} */
  const exit = new Promise((resolve) => {
    child.once("close", (code, signal) => {
      pending?.reject(
        new Error(
          `Proof ${kind} exited before acknowledgement (${signal ?? code ?? "unknown"}): ${stderr}`,
        ),
      );
      resolve({ code, signal, stderr });
    });
  });
  child.once("error", (error) => pending?.reject(error));
  child.stdin.on("error", (error) => pending?.reject(error));
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (/** @type {string} */ chunk) => {
    stderr = (stderr + chunk).slice(-4000);
  });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (/** @type {string} */ chunk) => {
    buffered += chunk;
    if (Buffer.byteLength(buffered) > 40_000_000) {
      pending?.reject(
        new Error("Proof response exceeds the parent image/frame budget; outcome may be unknown."),
      );
      buffered = "";
      child.stdout.pause();
      child.kill("SIGTERM");
      return;
    }
    let end;
    while ((end = buffered.indexOf("\n")) !== -1) {
      const line = buffered.slice(0, end);
      buffered = buffered.slice(end + 1);
      if (!pending) {
        child.kill("SIGTERM");
        return;
      }
      try {
        /** @type {unknown} */
        const parsed = JSON.parse(line);
        if (isTransportResult(parsed)) pending.resolve(parsed);
        else pending.reject(new Error("malformed proof response"));
      } catch (error) {
        pending.reject(error);
      }
      pending = undefined;
    }
  });
  const childPid = child.pid;
  if (childPid === undefined) assert.fail(`Proof ${kind} child did not start`);
  return {
    pid: childPid,
    get stderr() {
      return stderr;
    },
    call(tool, input) {
      assert.equal(pending, undefined, "Only one proof call may be outstanding");
      /** @type {Promise<TransportResult>} */
      const response = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error("Proof response timed out; do not replay."));
          child.kill("SIGTERM");
        }, 60000);
        pending = {
          resolve: (result) => {
            clearTimeout(timer);
            resolve(result);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        };
        child.stdin.write(`${JSON.stringify({ tool, input })}\n`, (error) => {
          if (error) pending?.reject(error);
        });
      });
      return response;
    },
    async close() {
      child.stdin.end();
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      try {
        const status = await exit;
        assert.equal(status.signal, null, `Proof ${kind} required forced shutdown`);
        assert.ok(
          status.code === 0 || (kind === "cli" && status.code === 1),
          `Unexpected ${kind} exit: ${JSON.stringify(status)}`,
        );
        assert.equal(stderr.trim(), "", `Unexpected ${kind} stderr: ${stderr}`);
        return status;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {Record<string, string>}
 */
const sdkEnv = (env) => {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [key, value] of Object.entries(env)) if (typeof value === "string") out[key] = value;
  return out;
};

/**
 * @param {TransportSpec} spec
 * @param {string} root
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<TransportClient>}
 */
async function openClient(spec, root, env) {
  if (spec.kind !== "mcp")
    return jsonlClient(
      join(
        root,
        "tools",
        spec.kind === "cli" ? "independent-proof-cli.mjs" : "independent-proof-pi-worker.mjs",
      ),
      spec.kind === "cli" ? ["session"] : [spec.host ?? ""],
      env,
      spec.kind,
    );
  const client = new Client({ name: "independent-fixture-qualification", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(root, "tools/independent-proof-mcp.mjs")],
    env: sdkEnv(env),
    stderr: "pipe",
  });
  let stderr = "";
  const stderrStream = transport.stderr;
  if (!(stderrStream instanceof Readable))
    assert.fail("MCP transport did not expose a stderr stream");
  stderrStream.setEncoding("utf8");
  stderrStream.on("data", (/** @type {string} */ chunk) => {
    stderr = (stderr + chunk).slice(-4000);
  });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [proofTool, resetTool].sort());
  } catch (error) {
    await client.close();
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`MCP startup failed: ${message}; stderr: ${stderr}`, { cause: error });
  }
  const pid = transport.pid;
  assert.ok(pid !== null, "MCP transport did not start");
  return {
    pid,
    get stderr() {
      return stderr;
    },
    async call(name, input) {
      const result = await client.callTool({ name, arguments: input }, undefined, {
        timeout: 60000,
      });
      const record = isRecord(result) ? result : undefined;
      return {
        content: transportBlocks(record?.content),
        isError: Boolean(record?.isError),
        details: toTransportDetails(record?._meta),
      };
    },
    async close() {
      await client.close();
      assert.equal(exited(pid), true, "Owned MCP server did not exit");
      assert.equal(stderr.trim(), "", `Unexpected MCP stderr: ${stderr}`);
      return { exited: true, stderr };
    },
  };
}
/**
 * @param {TransportResult} result
 * @returns {IndependentEvidence}
 */
function evidence(result) {
  const independent = result.details?.independent;
  if (independent === undefined) assert.fail("Missing authoritative proof metadata");
  assert.equal(result.isError, independent.isError);
  return independent;
}
/**
 * @param {TransportResult} result
 * @returns {unknown}
 */
function value(result) {
  return evidence(result).execution?.value;
}
/**
 * @param {TransportResult} result
 * @returns {VisibleReport}
 */
function visible(result) {
  const block = result.content.find((item) => item.type === "text");
  if (block?.text === undefined) assert.fail("Missing text block in proof result");
  /** @type {unknown} */
  const parsed = JSON.parse(block.text);
  if (!isRecord(parsed)) assert.fail("Malformed visible report");
  const nativeEvidence = parsed.nativeEvidence;
  if (!Array.isArray(nativeEvidence)) assert.fail("Missing native evidence");
  /** @type {NativeEvidenceEntry[]} */
  const entries = [];
  for (const entry of nativeEvidence) if (isRecord(entry)) entries.push(entry);
  return { nativeEvidence: entries };
}
/**
 * @param {TransportResult} result
 * @returns {void}
 */
function noMutation(result) {
  assert.equal(result.isError, true);
  const meta = evidence(result);
  const actions = meta.nativeActions;
  if (actions === undefined) assert.fail("Missing native action records");
  assert.ok(
    actions.every((action) => action.mutationAttempted !== true),
    "Refused operation attempted native mutation",
  );
}
/**
 * @param {TransportResult} result
 * @returns {ImageReceipt[]}
 */
function imageReceipts(result) {
  const meta = evidence(result);
  const receipts = meta.images;
  if (receipts === undefined) assert.fail("Missing image receipts");
  assert.equal(receipts.length, 2);
  assert.equal(result.content.filter((block) => block.type === "image").length, 2);
  for (const receipt of receipts) {
    const block = result.content[receipt.contentIndex];
    if (block === undefined) assert.fail("Missing image block for receipt");
    assert.equal(block.type, "image");
    assert.equal(block.mimeType, receipt.mimeType);
    if (block.data === undefined) assert.fail("Missing image data for receipt");
    const bytes = Buffer.from(block.data, "base64");
    assert.equal(createHash("sha256").update(bytes).digest("hex"), receipt.sha256);
    assert.equal(bytes.length, receipt.bytes);
    assert.equal(bytes.readUInt32BE(16), receipt.width);
    assert.equal(bytes.readUInt32BE(20), receipt.height);
    assert.equal(Math.round(receipt.captureRect.width * receipt.pointPixelScale), receipt.width);
    assert.equal(Math.round(receipt.captureRect.height * receipt.pointPixelScale), receipt.height);
  }
  return receipts;
}
/**
 * @param {ProofObservation} observation
 * @param {FixtureHandle} fixture
 * @param {ObservedState} [original]
 * @returns {ObservedState}
 */
function state(observation, fixture, original) {
  assert.equal(observation.fullSnapshot, true);
  assert.equal(observation.app.bundleId, fixture.app);
  assert.equal(observation.app.pid, fixture.pid);
  assert.equal(observation.app.path, fixture.path);
  assert.match(observation.app.processStartToken, /^[1-9]\d*:\d+$/);
  assert.equal(observation.windows.length, 1);
  const window = observation.windows[0];
  if (window === undefined) assert.fail("Missing observed window");
  assert.equal(window.title, fixture.title);
  const selected = observation.elements.filter(
    (element) =>
      element.role === "AXRadioButton" &&
      (element.value === true || element.value === 1 || element.value === "1"),
  );
  assert.equal(selected.length, 1);
  const radio = selected[0];
  if (radio === undefined) assert.fail("Missing selected radio");
  const description = radio.description;
  const name = description !== undefined && description !== "" ? description : radio.title;
  assert.ok(["CPU", "Memory", "Energy"].includes(name ?? ""));
  /** @type {Record<string, ObservedElement>} */
  const fields = {};
  for (const identifier of [ordinaryField, contextField]) {
    /** @type {ObservedElement[]} */
    const matches = observation.elements.filter(
      (element) => element.identifier === identifier && element.windowToken === window.token,
    );
    assert.equal(matches.length, 1);
    const field = matches[0];
    if (field === undefined) assert.fail(`Missing fixture field ${identifier}`);
    assert.equal(field.role, "AXTextField");
    assert.equal(typeof field.value, "string");
    fields[identifier] = field;
  }
  if (original !== undefined) {
    assert.equal(observation.app.processStartToken, original.birth);
    assert.equal(window.token, original.window.token);
    assert.equal(window.document, original.window.document);
  }
  return { name, fields, window, birth: observation.app.processStartToken };
}
/**
 * @param {ProofObservation} observation
 * @param {string} name
 * @returns {ObservedElement}
 */
function tab(observation, name) {
  const matches = observation.elements.filter(
    (element) =>
      element.role === "AXRadioButton" &&
      (element.description !== undefined && element.description !== ""
        ? element.description
        : element.title) === name,
  );
  assert.equal(matches.length, 1);
  const match = matches[0];
  if (match === undefined) assert.fail(`Missing tab ${name}`);
  return match;
}
/**
 * @param {string} method
 * @param {Record<string, unknown>} params
 * @returns {string}
 */
const callCode = (method, params) =>
  `macuse.call(${JSON.stringify(method)},${JSON.stringify(params)})`;

/**
 * @param {TransportSpec} spec
 * @param {string} root
 * @param {new () => NativeActuatorLike} NativeActuator
 * @param {() => Promise<FixtureHandle>} startFixture
 */
async function qualify(spec, root, NativeActuator, startFixture) {
  /** @type {Array<{ name: string, status: string, detail?: unknown }>} */
  const checks = [];
  /** @type {string[]} */
  const failures = [];
  /** @type {Map<number, OwnedWorker>} */
  const workers = new Map();
  const observer = new NativeActuator();
  /** @type {FixtureHandle | undefined} */
  let fixture;
  /** @type {TransportClient | undefined} */
  let client;
  /** @type {ObservedState | undefined} */
  let original;
  let clientClosed = false;
  const activeFixture = () => {
    if (fixture === undefined) throw new Error("fixture not started");
    return fixture;
  };
  const activeClient = () => {
    if (client === undefined) throw new Error("transport not started");
    return client;
  };
  /**
   * @param {string} name
   * @param {unknown} [detail]
   */
  const pass = (name, detail) =>
    checks.push({ name, status: "pass", ...(detail !== undefined ? { detail } : {}) });
  const rememberWorkers = async () => {
    const current = await descendants(activeClient().pid);
    for (const worker of current) workers.set(worker.pid, worker);
    return current;
  };
  const observeActual = async () => {
    const target = activeFixture();
    const observation = await observer.observe({
      app: target.app,
      expectedPid: target.pid,
      expectedPath: target.path,
      ...(original ? { expectedProcessStartToken: original.birth } : {}),
    });
    return { observation, current: state(observation, target, original) };
  };
  try {
    fixture = await startFixture();
    original = (await observeActual()).current;
    pass("operator-owned original state captured", {
      selectedTab: original.name,
      birth: original.birth,
    });
    const alternate = original.name === "Memory" ? "Energy" : "Memory";
    /** @type {NodeJS.ProcessEnv} */
    const env = {
      ...process.env,
      PI_OFFLINE: "1",
      MACUSE_CHATGPT_RESOURCES: "/no-vendor-installation-in-independent-proof",
      MACUSE_INDEPENDENT_PROOF_TARGET: JSON.stringify({
        bundleId: fixture.app,
        pid: fixture.pid,
        path: fixture.path,
        windowTitle: fixture.title,
      }),
    };
    client = await openClient(spec, root, env);
    /**
     * @param {string} code
     * @param {boolean} [mutate]
     * @param {number} [timeoutMs]
     */
    const run = (code, mutate = false, timeoutMs = 10000) =>
      activeClient().call(proofTool, {
        code,
        apps: [activeFixture().app],
        timeoutMs,
        ...(mutate ? { allowMutating: true, safetyNote } : {}),
      });
    const observe = async () => {
      const result = await run(
        `var retainedProof=41; var proofState=${callCode("observe", { app: activeFixture().app })}; proofState`,
      );
      assert.equal(result.isError, false);
      const observed = value(result);
      if (!isProofObservation(observed)) assert.fail("observe result is not an observation");
      state(observed, activeFixture());
      return observed;
    };
    /**
     * @param {ProofObservation} observation
     * @param {ObservedElement} element
     * @param {string} action
     * @param {unknown} [fieldValue]
     */
    const act = async (observation, element, action, fieldValue) => {
      const result = await run(
        callCode("act", {
          app: activeFixture().app,
          observationId: observation.observationId,
          elementToken: element.token,
          action,
          ...(action === "setValue" ? { value: fieldValue } : {}),
        }),
        true,
      );
      assert.equal(result.isError, false, result.content[0]?.text);
      const nativeActions = evidence(result).nativeActions;
      if (nativeActions === undefined) assert.fail("missing native action records");
      const accepted = nativeActions.find((item) => item.method === "act");
      if (accepted === undefined) assert.fail("missing accepted act record");
      assert.equal(accepted.mutationAttempted, true);
      assert.equal(accepted.nativeAccepted, true);
      assert.ok(
        visible(result).nativeEvidence.some(
          (item) => item.action === action && item.outcome === accepted.outcome,
        ),
      );
      return accepted;
    };
    const deniedScope = await run(`${callCode("observe", { app: "not.the.owned.fixture" })};42`);
    noMutation(deniedScope);
    assert.match(visible(deniedScope).nativeEvidence[0]?.error ?? "", /trusted target/);
    let observation = await observe();
    const old = {
      observationId: observation.observationId,
      elementToken: tab(observation, alternate).token,
    };
    const deniedFlags = await run(
      callCode("act", { app: activeFixture().app, ...old, action: "press" }),
    );
    noMutation(deniedFlags);
    const deniedExecution = evidence(deniedFlags).execution;
    const deniedActions = deniedExecution?.actions;
    if (deniedActions === undefined) assert.fail("missing denied execution actions");
    assert.ok(deniedActions.some((action) => action.method === "act" && !action.dispatched));
    assert.equal((await observeActual()).current.name, original.name);
    pass("wrong app and missing parent mutation flags refused without native effect");

    observation = await observe();
    const imageWindow = observation.windows[0];
    if (imageWindow === undefined) assert.fail("missing window for screenshot");
    const imageCall = callCode("screenshot", {
      app: activeFixture().app,
      observationId: observation.observationId,
      windowToken: imageWindow.token,
    });
    const captures = await run(
      `var firstImage=${imageCall};var secondImage=${imageCall};var refusedImage=${imageCall};({firstImage,secondImage,refusedImage})`,
    );
    noMutation(captures);
    const captureResult = value(captures);
    if (!isRecord(captureResult)) assert.fail("missing capture result");
    const refusedImage = captureResult.refusedImage;
    if (!isRecord(refusedImage)) assert.fail("missing refused image result");
    assert.equal(refusedImage.status, "refused");
    const images = imageReceipts(captures);
    pass("two parent PNG images survive third-capture refusal through public transport", images);

    observation = await observe();
    const pressed = await act(observation, tab(observation, alternate), "press");
    assert.equal(pressed.verified, false);
    assert.equal(pressed.outcome, "requires-fresh-observation");
    assert.equal((await observeActual()).current.name, alternate);
    pass("AXPress remains explicitly unverified until independently observed");
    observation = await observe();
    const ordinary =
      state(observation, activeFixture()).fields[ordinaryField] ??
      assert.fail("missing ordinary field");
    assert.equal((await act(observation, ordinary, "setValue", unicode)).verified, true);
    assert.equal((await observeActual()).current.fields[ordinaryField]?.value, unicode);
    pass("Unicode whole-field value independently observed");
    const deadlineWorkers = await rememberWorkers();
    pass("actual owned native and independent JSC process artifacts observed", deadlineWorkers);

    const deadline = await run("while(true){}", false, 100);
    assert.equal(deadline.isError, true);
    const deadlineExecution = evidence(deadline).execution;
    if (deadlineExecution === undefined) assert.fail("missing deadline execution");
    assert.equal(deadlineExecution.interruption, "deadline");
    requireExited(deadlineWorkers, "Immediately after deadline, before recovery");
    const unchanged = (await observeActual()).current;
    assert.equal(unchanged.name, alternate);
    assert.equal(unchanged.fields[ordinaryField]?.value, unicode);
    observation = await observe();
    assert.equal(
      value(await run("retainedProof+1")),
      42,
      "Native observation must retain bindings before reset",
    );
    const beforeReset = {
      observationId: observation.observationId,
      elementToken: tab(observation, alternate).token,
    };
    assert.equal((await activeClient().call(resetTool, {})).isError, false);
    assert.equal(value(await run("typeof retainedProof")), "undefined");
    const staleAfterReset = await run(
      callCode("act", { app: activeFixture().app, ...beforeReset, action: "press" }),
      true,
    );
    noMutation(staleAfterReset);
    const staleActions = evidence(staleAfterReset).nativeActions;
    if (staleActions === undefined) assert.fail("missing stale native actions");
    assert.match(staleActions[0]?.error ?? "", /fresh same-session native observation/);
    pass("actual deadline and reset clear execution/observation state without replay");

    observation = await observe();
    const changing =
      state(observation, activeFixture()).fields[contextField] ??
      assert.fail("missing context field");
    const unknownWorkers = await rememberWorkers();
    const unknown = await run(
      `${callCode("act", {
        app: activeFixture().app,
        observationId: observation.observationId,
        elementToken: changing.token,
        action: "setValue",
        value: contextValue,
      })};42`,
      true,
    );
    assert.equal(unknown.isError, true);
    assert.equal(evidence(unknown).priorUnknown, true);
    requireExited(unknownWorkers, "Immediately after unknown response, before recovery");
    assert.ok(
      visible(unknown).nativeEvidence.some(
        (item) =>
          item.mutationAttempted === true && item.outcome === "unknown" && item.verified !== true,
      ),
    );
    const changed = (await observeActual()).current;
    assert.equal(changed.fields[contextField]?.value, contextValue);
    assert.equal(changed.name, "CPU");
    observation = await observe();
    noMutation(
      await run(
        callCode("act", {
          app: fixture.app,
          observationId: observation.observationId,
          elementToken:
            state(observation, activeFixture()).fields[ordinaryField]?.token ??
            assert.fail("missing ordinary field token"),
          action: "setValue",
          value: "DO NOT WRITE",
        }),
        true,
      ),
    );
    assert.equal((await observeActual()).current.fields[ordinaryField]?.value, unicode);
    const reset = await activeClient().call(resetTool, {});
    assert.equal(reset.isError, false);
    assert.equal(evidence(reset).priorUnknown, true);
    assert.match(reset.content[0]?.text ?? "", /prior.*unknown/i);
    pass(
      "real context-changing setter retains attempted/unknown, blocks further mutation and survives reset",
    );

    for (const identifier of [contextField, ordinaryField]) {
      observation = await observe();
      const current = state(observation, fixture).fields[identifier];
      if (current === undefined) assert.fail(`missing fixture field ${identifier}`);
      const allowed =
        identifier === contextField
          ? [original.fields[identifier]?.value, contextValue]
          : [original.fields[identifier]?.value, unicode];
      assert.ok(
        allowed.includes(current.value),
        "Unexpected fixture field value; refusing public restoration overwrite",
      );
      if (current.value !== original.fields[identifier]?.value)
        await act(observation, current, "setValue", original.fields[identifier]?.value);
    }
    observation = await observe();
    if (state(observation, fixture).name !== original.name)
      await act(observation, tab(observation, original.name ?? ""), "press");
    const final = (await observeActual()).current;
    assert.equal(final.name, original.name);
    for (const identifier of [ordinaryField, contextField])
      assert.equal(final.fields[identifier]?.value, original.fields[identifier]?.value);
    pass("original fields and actual radio selection restored through public transport");
    const finalWorkers = await rememberWorkers();
    const finalReset = await client.call(resetTool, {});
    assert.equal(finalReset.isError, false);
    const settlement = evidence(finalReset).settlement;
    if (settlement === undefined) assert.fail("missing settlement record");
    assert.equal(settlement.settled, true);
    assert.equal(settlement.workerStopped, true);
    assert.equal(settlement.nativeStopped, true);
    assert.equal(settlement.hostCallsPending, 0);
    requireExited(finalWorkers, "Immediately after final public reset");
    pass("final public reset reports settled owned work", settlement);
    const close = await client.close();
    clientClosed = true;
    requireExited(workers.values(), "After transport close");
    pass("owned transport/executor/native workers exited", {
      close,
      workers: [...workers.values()],
    });
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  } finally {
    if (client !== undefined && !clientClosed) {
      try {
        await client.close();
      } catch (error) {
        failures.push(
          `Transport cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (fixture !== undefined && original !== undefined) {
      try {
        // Failure cleanup is a fresh bounded original-value restoration, never an attempted-value replay.
        for (const identifier of [contextField, ordinaryField]) {
          let { observation, current } = await observeActual();
          const allowed =
            identifier === contextField
              ? [original.fields[identifier]?.value, contextValue]
              : [original.fields[identifier]?.value, unicode];
          assert.ok(
            allowed.includes(current.fields[identifier]?.value),
            "Unexpected fixture field value; refusing cleanup overwrite",
          );
          if (current.fields[identifier]?.value === original.fields[identifier]?.value) continue;
          if (identifier === contextField && current.name !== "CPU") {
            await observer.act({
              app: fixture.app,
              observationId: observation.observationId,
              elementToken: tab(observation, "CPU").token,
              action: "press",
              allowMutating: true,
              safetyNote,
            });
            ({ observation, current } = await observeActual());
          }
          const restored = await observer.act({
            app: fixture.app,
            observationId: observation.observationId,
            elementToken: current.fields[identifier]?.token,
            action: "setValue",
            value: original.fields[identifier]?.value,
            allowMutating: true,
            safetyNote,
          });
          assert.equal(restored.verified, true);
        }
        const initialRead = await observeActual();
        const observation = initialRead.observation;
        let current = initialRead.current;
        if (current.name !== original.name) {
          await observer.act({
            app: fixture.app,
            observationId: observation.observationId,
            elementToken: tab(observation, original.name ?? "").token,
            action: "press",
            allowMutating: true,
            safetyNote,
          });
          ({ current } = await observeActual());
        }
        assert.equal(current.name, original.name);
        for (const identifier of [ordinaryField, contextField])
          assert.equal(current.fields[identifier]?.value, original.fields[identifier]?.value);
        pass("independent final original-state verification");
      } catch (error) {
        failures.push(
          `Original-state cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    try {
      await observer.stop();
    } catch (error) {
      failures.push(
        `Observer stop failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (fixture) {
      try {
        await fixture.stop();
        assert.equal(exited(fixture.pid), true, "Owned fixture remains running");
        pass("owned fixture exited");
      } catch (error) {
        failures.push(
          `Fixture stop failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
  return {
    transport: spec.name,
    ...(spec.host !== undefined && spec.host !== "" ? { host: spec.host } : {}),
    ok: failures.length === 0,
    transportStderr: client?.stderr ?? "",
    checks,
    failures,
    fullIndependenceQualified: false,
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      live: { type: "boolean" },
      "package-root": { type: "string" },
      "official-pi": { type: "string" },
      "fork-pi": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help === true || values.live !== true) {
    console.log(
      "Usage: node tools/qualify-independent-proof.mjs --live --package-root ROOT --official-pi PI_PACKAGE_DIR --fork-pi PI_PACKAGE_DIR\nExplicit research-only owned AppKit fixture qualification through real CLI/MCP/official-Pi/fork-Pi tool paths. Without --live, no desktop access. Uses/restores only owned fixture fields and radio controls; no user apps, recording/history, selected-range, keyboard/pointer or full-independence claim.",
    );
    if (values.help !== true) process.exitCode = 1;
    return;
  }
  assert.equal(process.platform, "darwin", "Live independent qualification requires macOS");
  assert.ok(
    values["official-pi"] !== undefined &&
      values["official-pi"] !== "" &&
      values["fork-pi"] !== undefined &&
      values["fork-pi"] !== "",
    "Both exact official and fork Pi package directories are required",
  );
  const root = resolve(values["package-root"] ?? fileURLToPath(new URL("..", import.meta.url)));
  const before = await sourceHashes(root);
  const qualifierSourceSha256 = await hash(fileURLToPath(import.meta.url));
  /** @type {unknown} */
  const nativeActuatorModule = await import(
    pathToFileURL(join(root, "tools/native-actuator.mjs")).href
  );
  const actuatorCandidate = isRecord(nativeActuatorModule)
    ? nativeActuatorModule.NativeActuator
    : undefined;
  if (!isActuatorClass(actuatorCandidate)) assert.fail("NativeActuator export missing");
  const NativeActuator = actuatorCandidate;
  /** @type {unknown} */
  const actuatorFixtureModule = await import(
    pathToFileURL(join(root, "tools/actuator-fixture.mjs")).href
  );
  const launcherCandidate = isRecord(actuatorFixtureModule)
    ? actuatorFixtureModule.startActuatorFixture
    : undefined;
  if (!isFixtureLauncher(launcherCandidate)) assert.fail("startActuatorFixture export missing");
  const startActuatorFixture = launcherCandidate;
  /** @type {TransportSpec[]} */
  const specs = [
    { kind: "cli", name: "CLI JSONL" },
    { kind: "mcp", name: "MCP stdio" },
    { kind: "pi", name: "official Pi public SDK tools", host: resolve(values["official-pi"]) },
    { kind: "pi", name: "fork Pi public SDK tools", host: resolve(values["fork-pi"]) },
  ];
  const results = [];
  for (const spec of specs)
    results.push(await qualify(spec, root, NativeActuator, startActuatorFixture));
  const after = await sourceHashes(root);
  const unchanged =
    JSON.stringify(before) === JSON.stringify(after) &&
    qualifierSourceSha256 === (await hash(fileURLToPath(import.meta.url)));
  const hosts = await Promise.all(
    specs
      .filter((spec) => spec.host !== undefined && spec.host !== "")
      .map(async (spec) => {
        const host = spec.host ?? "";
        /** @type {unknown} */
        const pkg = JSON.parse(await readFile(join(host, "package.json"), "utf8"));
        return {
          name: spec.name,
          path: spec.host,
          version: isRecord(pkg) ? pkg.version : undefined,
          packageManifestSha256: await hash(join(host, "package.json")),
        };
      }),
  );
  const report = {
    ok: unchanged && results.every((result) => result.ok),
    scope: "owned-fixture-independent-core-through-public-transports",
    fullIndependenceQualified: false,
    sourceUnchanged: unchanged,
    qualifierSourceSha256,
    sourceHashes: before,
    node: { path: process.execPath, version: process.version },
    os: {
      platform: process.platform,
      arch: process.arch,
      release: release(),
      macOS: (await exec("/usr/bin/sw_vers")).stdout.trim(),
    },
    hosts,
    results,
    unattempted: [
      "General-app and Activity Monitor compatibility",
      "Selected-range insertion",
      "Visual screenshot content and pointer-coordinate action mapping",
      "Keyboard/pointer/focus and transition coverage",
      "Record & Replay and Computer History independence",
      "Independent pinning of Apple system JavaScriptCore",
      "Production signed helper deployment/default migration",
    ],
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}
main().catch((/** @type {unknown} */ error) => {
  console.error(
    `Independent qualification failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
