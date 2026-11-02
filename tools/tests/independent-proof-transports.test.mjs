import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { findPackageJSON } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const exec = promisify(execFile);
const mac = { skip: process.platform !== "darwin", timeout: 60000 };
const tool = "macuse_independent_proof";
const reset = "macuse_independent_proof_reset";
const env = {
  ...process.env,
  PI_OFFLINE: "1",
  MACUSE_INDEPENDENT_PROOF_TARGET: "",
  MACUSE_CHATGPT_RESOURCES: "/no-vendor-installation-in-proof",
};
/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
/** @param {unknown} chunk @returns {string} */
const chunkText = (chunk) => {
  if (typeof chunk === "string") return chunk;
  if (Buffer.isBuffer(chunk)) return chunk.toString();
  return "";
};
/**
 * @param {string} line
 * @returns {{ isError: boolean | undefined, details: unknown }}
 */
const parseLine = (line) => {
  /** @type {unknown} */
  const parsed = JSON.parse(line);
  assert.ok(isRecord(parsed), "Transport returned a non-object JSONL line");
  return {
    isError: typeof parsed.isError === "boolean" ? parsed.isError : undefined,
    details: parsed.details,
  };
};
/** @param {unknown} result @returns {Record<string, unknown>} */
const metaOf = (result) => {
  const record = isRecord(result) ? result : {};
  if (isRecord(record.details)) return record.details;
  if (isRecord(record._meta)) return record._meta;
  return {};
};
/** @param {unknown} result @returns {Record<string, unknown>} */
const independentDetails = (result) => {
  const container = metaOf(result);
  return isRecord(container.independent) ? container.independent : {};
};
/** @param {Record<string, unknown>} independent @returns {unknown} */
const executionValue = (independent) => {
  const execution = isRecord(independent.execution) ? independent.execution : {};
  return execution.value;
};
/** @param {unknown} result @returns {unknown} */
const value = (result) => executionValue(independentDetails(result));
/**
 * @template T
 * @param {T[]} results
 * @param {number} index
 * @returns {T}
 */
const at = (results, index) => {
  const found = results[index];
  if (found === undefined) assert.fail(`Missing transport result ${index}`);
  return found;
};
/** @param {unknown} value @returns {value is { code: unknown, stderr: string, stdout: string }} */
const isExecFailure = (value) =>
  value instanceof Error &&
  "code" in value &&
  "stderr" in value &&
  "stdout" in value &&
  typeof value.stderr === "string" &&
  typeof value.stdout === "string";
const targetless = {
  code: "macuse.call('observe',{app:'com.macuse.actuator-fixture.11111111-1111-4111-8111-111111111111'})",
};
const invalidAdmission = { code: "1", allowMutating: true };
const requests = [
  { tool, input: { code: "var retained=41; retained" } },
  { tool: reset, input: { unexpected: true } },
  { tool, input: { code: "({counter:++retained,text:'独立\u2028é'})" } },
  { tool: reset, input: {} },
  { tool, input: { code: "typeof retained" } },
  { tool, input: targetless },
  { tool, input: invalidAdmission },
];

/**
 * @param {string} script
 * @param {string[]} [args]
 * @param {number} [expectedExit]
 * @param {boolean} [hostValidatesSchema]
 */
async function sessionProcess(script, args = [], expectedExit = 0, hostValidatesSchema = false) {
  const input = requests.map((request) => JSON.stringify(request)).join("\r\n");
  const child = execFile(
    process.execPath,
    [fileURLToPath(new URL(script, import.meta.url)), ...args],
    { env, timeout: 50000, maxBuffer: 2 * 1024 * 1024 },
  );
  const stdin = child.stdin;
  const stdoutStream = child.stdout;
  const stderrStream = child.stderr;
  if (stdin === null || stdoutStream === null || stderrStream === null)
    assert.fail("Child stdio unavailable");
  stdin.end(input);
  /** @type {Promise<ReturnType<typeof parseLine>[]>} */
  const settled = new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    stdoutStream.on("data", (chunk) => {
      stdout += chunkText(chunk);
    });
    stderrStream.on("data", (chunk) => {
      stderr += chunkText(chunk);
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      try {
        assert.equal(signal, null, stderr);
        assert.equal(code, expectedExit, stderr);
        resolve(
          stdout
            .trim()
            .split("\n")
            .map((line) => parseLine(line)),
        );
      } catch (error) {
        reject(error);
      }
    });
  });
  const result = await settled;
  assert.equal(result.length, requests.length);
  assert.equal(value(at(result, 0)), 41);
  assert.equal(at(result, 1).isError, true);
  if (!hostValidatesSchema) {
    assert.equal(independentDetails(at(result, 1)).outcome, "not-dispatched");
    assert.equal(independentDetails(at(result, 1)).dispatched, false);
  }
  assert.deepEqual(value(result[2]), { counter: 42, text: "独立\u2028é" });
  assert.equal(at(result, 3).isError, false);
  assert.equal(value(at(result, 4)), "undefined");
  assert.equal(
    at(result, 5).isError,
    true,
    "Targetless native read must remain an error across the transport",
  );
  assert.equal(independentDetails(at(result, 5)).isError, true);
  assert.equal(at(result, 6).isError, true);
  assert.equal(independentDetails(at(result, 6)).outcome, "not-dispatched");
  assert.equal(independentDetails(at(result, 6)).dispatched, false);
}

await test(
  "actual CLI preserves JSONL Unicode, bindings, predispatch reset refusal, reset and targetless native failure",
  mac,
  async () => {
    await sessionProcess("../independent-proof-cli.mjs", ["session"], 1);
    const oversized = exec(
      process.execPath,
      [fileURLToPath(new URL("../independent-proof-cli.mjs", import.meta.url)), "session"],
      { env, timeout: 10000 },
    );
    const oversizedStdin = oversized.child.stdin;
    if (oversizedStdin === null) assert.fail("Child stdin unavailable");
    oversizedStdin.end("x".repeat(131073));
    await assert.rejects(oversized, (/** @type {unknown} */ error) => {
      if (!isExecFailure(error)) return false;
      return error.code === 1 && /128 KiB/.test(error.stderr) && error.stdout === "";
    });
  },
);

await test(
  "actual MCP preserves proof results, failure metadata and reset through the public stdio client",
  mac,
  async () => {
    const client = new Client({ name: "independent-proof-transport-test", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL("../independent-proof-mcp.mjs", import.meta.url))],
      env,
      stderr: "pipe",
    });
    let pid = null;
    try {
      await client.connect(transport);
      pid = transport.pid;
      assert.deepEqual(
        (await client.listTools()).tools.map((tool) => tool.name).sort(),
        [tool, reset].sort(),
      );
      const first = await client.callTool({
        name: tool,
        arguments: { code: "var retained=41; retained" },
      });
      assert.equal(executionValue(independentDetails(first)), 41);
      const refused = await client.callTool({ name: "not_a_proof_tool", arguments: {} });
      assert.equal(refused.isError, true);
      assert.equal(independentDetails(refused).outcome, "not-dispatched");
      assert.equal(independentDetails(refused).dispatched, false);
      const denied = await client.callTool({ name: tool, arguments: targetless });
      assert.equal(denied.isError, true);
      assert.equal(independentDetails(denied).isError, true);
      const invalid = await client.callTool({ name: tool, arguments: invalidAdmission });
      assert.equal(invalid.isError, true);
      assert.equal(independentDetails(invalid).outcome, "not-dispatched");
      assert.equal(independentDetails(invalid).dispatched, false);
      const cleared = await client.callTool({ name: reset, arguments: {} });
      assert.equal(cleared.isError, false);
      const fresh = await client.callTool({ name: tool, arguments: { code: "typeof retained" } });
      assert.equal(executionValue(independentDetails(fresh)), "undefined");
    } finally {
      await client.close();
    }
    assert.ok(pid !== null);
    assert.throws(
      () => process.kill(pid, 0),
      { code: "ESRCH" },
      "Owned MCP server must exit after transport close",
    );
  },
);

await test(
  "actual Pi SDK tool boundary preserves proof errors and reset in a fresh isolated host process",
  mac,
  async () => {
    const found = findPackageJSON("@earendil-works/pi-coding-agent", import.meta.url);
    if (found === undefined) assert.fail("pi-coding-agent package not found");
    const host = dirname(found);
    await sessionProcess("../independent-proof-pi-worker.mjs", [host], 0, true);
  },
);
