import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Readable } from "node:stream";
import {
  exited,
  isRecord,
  isTransportResult,
  proofTool,
  resetTool,
  toTransportDetails,
  transportBlocks,
} from "./qualify-proof-transport.mjs";

/** @typedef {import("./qualify-proof-transport.mjs").PendingCall} PendingCall */
/** @typedef {import("./qualify-proof-transport.mjs").TransportResult} TransportResult */
/** @typedef {import("./qualify-proof-transport.mjs").TransportSpec} TransportSpec */
/** @typedef {import("./qualify-proof-transport.mjs").TransportClient} TransportClient */

// One outstanding JSONL call per owned process. No replay after timeout or lost acknowledgement.
/**
 * @param {string} script
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 * @param {string} kind
 * @returns {TransportClient}
 */
export function jsonlClient(script, args, env, kind) {
  const child = spawn(process.execPath, [script, ...args], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const wire = wireJsonlChild(child, kind);
  const childPid = child.pid;
  if (childPid === undefined) {
    assert.fail(`Proof ${kind} child did not start`);
  }
  return {
    pid: childPid,
    get stderr() {
      return wire.stderrText();
    },
    call(tool, input) {
      return callJsonlChild(wire, child, tool, input);
    },
    async close() {
      return closeJsonlChild(wire, child, kind);
    },
  };
}

/**
 * Wire a proof child's stdio streams and exit event to a pending-call slot.
 * @param {import("node:child_process").ChildProcessByStdio<import("node:stream").Writable, import("node:stream").Readable, import("node:stream").Readable>} child
 * @param {string} kind
 * @returns {{ exit: Promise<{ code: number | null, signal: string | null, stderr: string }>, stderrText: () => string, pendingIsClear: () => boolean, setPending: (call: PendingCall) => void, failPending: (error: unknown) => void }}
 */
function wireJsonlChild(child, kind) {
  /** @type {PendingCall | undefined} */
  let pending;
  let buffered = "";
  let stderr = "";
  /** @type {Promise<{ code: number | null, signal: string | null, stderr: string }>} */
  const exit = new Promise((settle) => {
    child.once("close", (code, signal) => {
      pending?.reject(
        new Error(
          `Proof ${kind} exited before acknowledgement (${signal ?? code ?? "unknown"}): ${stderr}`,
        ),
      );
      settle({ code, signal, stderr });
    });
  });
  const failPending = (/** @type {unknown} */ error) => {
    pending?.reject(error);
  };
  child.once("error", failPending);
  child.stdin.on("error", failPending);
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (/** @type {string} */ chunk) => {
    stderr = (stderr + chunk).slice(-4000);
  });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (/** @type {string} */ chunk) => {
    buffered += chunk;
    if (Buffer.byteLength(buffered) > 40_000_000) {
      failPending(
        new Error("Proof response exceeds the parent image/frame budget; outcome may be unknown."),
      );
      buffered = "";
      child.stdout.pause();
      child.kill("SIGTERM");
      return;
    }
    pumpJsonlLines();
  });
  /**
   * Resolve the pending call with each complete JSONL line, in order.
   */
  function pumpJsonlLines() {
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
        if (isTransportResult(parsed)) {
          pending.resolve(parsed);
        } else {
          pending.reject(new Error("malformed proof response"));
        }
      } catch (error) {
        pending.reject(error);
      }
      pending = undefined;
    }
  }
  return {
    exit,
    stderrText: () => stderr,
    pendingIsClear: () => pending === undefined,
    setPending: (call) => {
      pending = call;
    },
    failPending,
  };
}

/**
 * Issue one JSONL tool call on the wired child.
 * @param {ReturnType<typeof wireJsonlChild>} wire
 * @param {import("node:child_process").ChildProcessByStdio<import("node:stream").Writable, import("node:stream").Readable, import("node:stream").Readable>} child
 * @param {string} tool
 * @param {Record<string, unknown>} input
 * @returns {Promise<TransportResult>}
 */
function callJsonlChild(wire, child, tool, input) {
  assert.ok(wire.pendingIsClear(), "Only one proof call may be outstanding");
  /** @type {Promise<TransportResult>} */
  const response = new Promise((settle, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Proof response timed out; do not replay."));
      child.kill("SIGTERM");
    }, 60000);
    wire.setPending({
      resolve: (result) => {
        clearTimeout(timer);
        settle(result);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    child.stdin.write(`${JSON.stringify({ tool, input })}\n`, (error) => {
      if (error) {
        wire.failPending(error);
      }
    });
  });
  return response;
}

/**
 * Close the wired child and validate its shutdown evidence.
 * @param {ReturnType<typeof wireJsonlChild>} wire
 * @param {import("node:child_process").ChildProcessByStdio<import("node:stream").Writable, import("node:stream").Readable, import("node:stream").Readable>} child
 * @param {string} kind
 * @returns {Promise<{ code: number | null, signal: string | null, stderr: string }>}
 */
async function closeJsonlChild(wire, child, kind) {
  child.stdin.end();
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    const status = await wire.exit;
    assert.equal(status.signal, null, `Proof ${kind} required forced shutdown`);
    assert.ok(
      status.code === 0 || (kind === "cli" && status.code === 1),
      `Unexpected ${kind} exit: ${JSON.stringify(status)}`,
    );
    assert.equal(wire.stderrText().trim(), "", `Unexpected ${kind} stderr: ${wire.stderrText()}`);
    return status;
  } finally {
    clearTimeout(timer);
  }
}
/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {Record<string, string>}
 */
export const sdkEnv = (env) => {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") {
      out[key] = value;
    }
  }
  return out;
};

/**
 * @param {TransportSpec} spec
 * @param {string} root
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<TransportClient>}
 */
export async function openClient(spec, root, env) {
  if (spec.kind !== "mcp") {
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
  }
  const client = new Client({ name: "independent-fixture-qualification", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(root, "tools/independent-proof-mcp.mjs")],
    env: sdkEnv(env),
    stderr: "pipe",
  });
  let stderr = "";
  const stderrStream = transport.stderr;
  if (!(stderrStream instanceof Readable)) {
    assert.fail("MCP transport did not expose a stderr stream");
  }
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
