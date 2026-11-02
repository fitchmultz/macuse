#!/usr/bin/env node
// Real selected-host tool execution; only model-generated calls are scripted.
import assert from "node:assert/strict";
import { findPackageJSON } from "node:module";
import { cp, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readProofLines } from "../lib/independent-proof-jsonl.mjs";

const packageDir = process.argv[2];
if (process.argv.includes("--help") || packageDir === undefined) {
  console.log(
    "Usage: node tools/independent-proof-pi-worker.mjs PI_PACKAGE_DIR\nLF JSONL {tool,input} -> actual selected Pi ToolResult. Loads only the opt-in proof extension; scripts provider tool calls, never native results. Set MACUSE_INDEPENDENT_PROOF_TARGET outside guest code for GUI calls.",
  );
  process.exit(process.argv.includes("--help") ? 0 : 1);
}
globalThis.fetch = async () => {
  throw new Error("Unexpected network in independent Pi proof");
};
/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const host = resolve(packageDir);
process.env.PI_PACKAGE_DIR = host;
const hostURL = pathToFileURL(join(host, "package.json")).href;
const aiPackage = findPackageJSON("@earendil-works/pi-ai", hostURL);
if (aiPackage === undefined) assert.fail("pi-ai package not found under the selected host");
const ai = dirname(aiPackage);
const typeboxPackage = findPackageJSON("typebox", hostURL);
if (typeboxPackage === undefined) assert.fail("typebox package not found under the selected host");
const sdkPackage = findPackageJSON("@modelcontextprotocol/sdk", import.meta.url);
if (sdkPackage === undefined) assert.fail("@modelcontextprotocol/sdk package not found");
/** @typedef {typeof import("@earendil-works/pi-coding-agent")} PiPublic */
/** @typedef {typeof import("@earendil-works/pi-ai")} PiAi */
/** @typedef {Awaited<ReturnType<typeof createAgentSession>>["session"]} ProofSession */
/** @typedef {ProofSession["messages"][number]} ProofMessage */
/** @typedef {NonNullable<Extract<ProofMessage, { role: "toolResult" }>>} ProofToolResult */
/**
 * @param {unknown} value
 * @returns {value is import("@earendil-works/pi-ai").JsonObject}
 */
const isJsonObject = (value) => {
  if (!isRecord(value)) return false;
  for (const item of Object.values(value)) {
    if (
      item === null ||
      typeof item === "string" ||
      typeof item === "number" ||
      typeof item === "boolean"
    )
      continue;
    if (Array.isArray(item)) {
      if (!item.every((entry) => isJsonValue(entry))) return false;
    } else if (!isJsonValue(item)) return false;
  }
  return true;
};
/** @param {unknown} value @returns {boolean} */
const isJsonValue = (value) =>
  value === null ||
  typeof value === "string" ||
  typeof value === "number" ||
  typeof value === "boolean" ||
  (typeof value === "object" &&
    (Array.isArray(value) ? value.every((entry) => isJsonValue(entry)) : isJsonObject(value)));
/**
 * @param {string} root
 * @param {string} file
 * @returns {Promise<PiPublic & PiAi>}
 */
const load = (root, file) => import(pathToFileURL(join(root, file)).href);
const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } =
  await load(host, "dist/index.js");
const { fauxProvider, fauxAssistantMessage, InMemoryCredentialStore, InMemoryModelsStore } =
  await load(ai, "dist/index.js");
const scratch = await mkdtemp(join(tmpdir(), "macuse-independent-pi-"));
/** @type {Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined} */
let session;
let interrupted = false;
const cancel = () => {
  interrupted = true;
  process.stdin.destroy();
  const active = session;
  if (active !== undefined) active.abort().catch(() => null);
};
process.once("SIGINT", cancel);
process.once("SIGTERM", cancel);
try {
  const source = fileURLToPath(new URL("..", import.meta.url));
  for (const path of ["extensions", "lib", "tools", "package.json"])
    await cp(join(source, path), join(scratch, path), { recursive: true });
  for (const [name, target] of /** @type {[string, string][]} */ ([
    ["@earendil-works/pi-coding-agent", host],
    ["@earendil-works/pi-ai", ai],
    ["typebox", dirname(typeboxPackage)],
    ["@modelcontextprotocol/sdk", dirname(sdkPackage)],
  ])) {
    const link = join(scratch, "node_modules", name);
    await mkdir(dirname(link), { recursive: true });
    await symlink(target, link, "dir");
  }
  const faux = fauxProvider({
    provider: "independent-native-proof",
    tokensPerSecond: 1000000,
    models: [{ id: "fixture", input: ["text", "image"] }],
  });
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  await modelRuntime.refresh({ providers: [faux.provider.id], allowNetwork: false });
  const resourceLoader = new DefaultResourceLoader({
    cwd: scratch,
    agentDir: scratch,
    noExtensions: true,
    noSkills: true,
    noThemes: true,
    noPromptTemplates: true,
    noContextFiles: true,
    additionalExtensionPaths: [join(scratch, "extensions/independent-proof.ts")],
  });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  ({ session } = await createAgentSession({
    cwd: scratch,
    agentDir: scratch,
    modelRuntime,
    model: faux.getModel(),
    resourceLoader,
    sessionManager: SessionManager.inMemory(scratch),
    tools: ["macuse_independent_proof", "macuse_independent_proof_reset"],
    settingsManager: SettingsManager.inMemory({
      images: { autoResize: false },
      compaction: { enabled: false },
      retry: { enabled: false },
    }),
  }));
  await session.bindExtensions({
    onError: (error) => {
      throw new Error(error.error);
    },
  });
  let sequence = 0;
  for await (const line of readProofLines(process.stdin)) {
    // `interrupted` flips in signal callbacks tsgolint's flow analysis cannot see.
    // oxlint-disable-next-line no-unnecessary-condition
    if (interrupted) break;
    /** @type {unknown} */
    const parsed = JSON.parse(line);
    const request = isRecord(parsed) ? parsed : {};
    const tool = typeof request.tool === "string" ? request.tool : "";
    const input = isJsonObject(request.input) ? request.input : {};
    const id = `independent-proof-${++sequence}`;
    faux.setResponses([
      fauxAssistantMessage([{ type: "toolCall", id, name: tool, arguments: input }], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("Proof tool returned."),
    ]);
    const active = session;
    // tsc requires the undefined guard; tsgolint resolves the assignment as definite.
    // oxlint-disable-next-line no-unnecessary-condition
    if (active === undefined) assert.fail("session missing before prompt");
    await active.prompt("Execute the supplied bounded qualification call.");
    /** @param {ProofMessage} message @returns {message is ProofToolResult} */
    const isCorrelatedToolResult = (message) =>
      message.role === "toolResult" && message.toolCallId === id;
    const result = active.messages.find(isCorrelatedToolResult);
    if (result === undefined)
      assert.fail("Actual Pi tool execution did not return a correlated result");
    process.stdout.write(
      `${JSON.stringify({ content: result.content, isError: result.isError, details: result.details })}\n`,
    );
  }
} finally {
  try {
    if (session) {
      try {
        await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      } finally {
        session.dispose();
      }
    }
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
    await rm(scratch, { recursive: true, force: true });
  }
}
