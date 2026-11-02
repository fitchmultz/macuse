#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { MacuseSession } from "../lib/macuse-session.mjs";
import { tools } from "../lib/tools.mjs";
import { runtimeInventory } from "../lib/runtime-inventory.mjs";
import { VERSION } from "./macuse-utils.mjs";

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isJsonObject = (value) => typeof value === "object" && value !== null;

function printUsage() {
  console.log(
    `macuse ${VERSION}\n\nUsage:\n  macuse tools [--pretty]\n  macuse status\n  macuse runtime [--pretty] [--out inventory.json]\n  macuse call <tool> '<JSON arguments>' [--file code.js] [--out result.json]\n  macuse session\n\nSession input: one {"tool":"macuse","input":{"code":"await cua.getState()"}} per line.\nBindings and observations persist only within that process. --file supplies macuse's code.\nTool schemas describe mutation gates; no automatic replay after cancellation.\n`,
  );
}

/**
 * @param {{ pretty?: boolean | undefined, out?: string | undefined }} values
 * @returns {(value: unknown) => Promise<void>}
 */
function makePrinter(values) {
  return async (value) => {
    const text = `${JSON.stringify(value, null, values.pretty === true ? 2 : 0)}\n`;
    if (values.out !== undefined && values.out !== "") {
      await writeFile(values.out, text, { flag: "wx" });
    } else {
      process.stdout.write(text);
    }
  };
}

/**
 * @param {{ file?: string | undefined }} values
 * @param {(value: unknown) => Promise<void>} print
 * @returns {Promise<void>}
 */
async function runRuntimeCommand(values, print) {
  if (values.file !== undefined && values.file !== "") {
    throw new Error("runtime does not accept --file");
  }
  const inventory = await runtimeInventory();
  await print(inventory);
  if (inventory.ok !== true) {
    process.exitCode = 1;
  }
}

/**
 * @param {string} tool
 * @param {string} json
 * @param {string | undefined} file
 * @returns {Promise<Record<string, unknown>>}
 */
async function callToolArguments(tool, json, file) {
  const parsed = /** @type {unknown} */ (JSON.parse(json));
  if (!isJsonObject(parsed)) {
    throw new Error("tool arguments must be a JSON object");
  }
  const input = parsed;
  if (file !== undefined && file !== "") {
    if (tool !== "macuse") {
      throw new Error("--file is only valid for macuse JavaScript");
    }
    input.code = await readFile(file, "utf8");
  }
  return input;
}

/**
 * Pump JSONL tool requests from stdin until aborted.
 * @param {(name: string, input: Record<string, unknown>) => Promise<void>} call
 * @param {AbortSignal} signal
 * @returns {Promise<void>}
 */
async function runSessionLines(call, signal) {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  signal.addEventListener("abort", () => lines.close(), { once: true });
  for await (const line of lines) {
    if (line.trim().length === 0) {
      continue;
    }
    const request = /** @type {unknown} */ (JSON.parse(line));
    if (!isJsonObject(request)) {
      throw new Error("session lines must be JSON objects");
    }
    if (typeof request.tool !== "string") {
      throw new Error("session lines need a tool name");
    }
    if (!isJsonObject(request.input)) {
      throw new Error("session lines need an input object");
    }
    await call(request.tool, request.input);
    if (signal.aborted) {
      break;
    }
  }
}

/**
 * @typedef {{ values: { file?: string | undefined, out?: string | undefined }, command: string, tool: string, json: string, print: (value: unknown) => Promise<void> }} SessionRun
 */

/**
 * Run status, call, or an interactive session against one MacuseSession.
 * @param {SessionRun} run
 * @returns {Promise<void>}
 */
async function runSessionCommand(run) {
  const { values, command, tool, json, print } = run;
  if (
    command === "session" &&
    ((values.out !== undefined && values.out !== "") ||
      (values.file !== undefined && values.file !== ""))
  ) {
    throw new Error("session does not accept --out or --file");
  }
  const session = new MacuseSession();
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    if (command === "status") {
      await print(session.status());
      return;
    }
    /**
     * @param {string} name
     * @param {Record<string, unknown>} input
     * @returns {Promise<void>}
     */
    const call = async (name, input) => {
      const result = await session.callTool(name, input, { signal: controller.signal });
      await print(result);
      if (result.isError) {
        process.exitCode = 1;
      }
    };
    if (command === "call") {
      await call(tool, await callToolArguments(tool, json, values.file));
    } else {
      await runSessionLines(call, controller.signal);
    }
  } finally {
    await session.stop();
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      pretty: { type: "boolean" },
      file: { type: "string" },
      out: { type: "string" },
    },
  });
  const [command = "help", tool = "macuse", json = "{}"] = positionals;
  if (values.help === true || command === "help") {
    printUsage();
    return;
  }
  const print = makePrinter(values);
  if (command === "tools") {
    await print(tools);
    return;
  }
  if (command === "runtime") {
    await runRuntimeCommand(values, print);
    return;
  }
  if (!["call", "session", "status"].includes(command)) {
    throw new Error(`Unknown command: ${command}`);
  }
  await runSessionCommand({ values, command, tool, json, print });
}
main().catch((/** @type {unknown} */ error) => {
  console.error(`macuse: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
