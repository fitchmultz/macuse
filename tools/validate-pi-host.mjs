#!/usr/bin/env node
// Credential-free probes of the installed host's real hooks, image normalizer and Responses adapters.
import assert from "node:assert/strict";
import { findPackageJSON } from "node:module";
import { cp, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { zstdDecompressSync } from "node:zlib";
import { call, content, details, originalImage, redacted } from "./validate-pi-host-fixtures.mjs";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(
    "Usage: node tools/validate-pi-host.mjs [PI_PACKAGE_DIR] [MACUSE_PACKAGE_DIR]\nOffline SDK, image-normalization and Responses-adapter checks.\nExample: node tools/validate-pi-host.mjs /tmp/pi/node_modules/@earendil-works/pi-coding-agent /tmp/packed/package\nExit: 0 checks passed; 1 validation failure.",
  );
  process.exit(0);
}
/** @typedef {typeof import("@earendil-works/pi-coding-agent")} PiPublic */
/** @typedef {typeof import("@earendil-works/pi-ai")} PiAiPublic */
/** @typedef {import("@earendil-works/pi-coding-agent").ToolDefinition} ToolDefinition */
/** @typedef {PiSession["messages"][number]} AgentMessage */
/** @typedef {Extract<AgentMessage, { role: "toolResult" }>["content"][number]} ContentBlock */
/** @typedef {Awaited<ReturnType<PiPublic["createAgentSession"]>>["session"]} PiSession */
/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
/** @param {unknown} value @returns {value is unknown[]} */
const isUnknownArray = (value) => Array.isArray(value);
/** @param {ContentBlock} block @returns {block is Extract<ContentBlock, {type: "image"}>} */
const isImageBlock = (block) => block.type === "image";
/**
 * Tool definitions exposed by every loaded extension.
 * @param {ReturnType<import("@earendil-works/pi-coding-agent").DefaultResourceLoader["getExtensions"]>["extensions"]} extensions
 * @returns {ToolDefinition[]}
 */
const collectHostTools = (extensions) => {
  const collected = [];
  for (const extension of extensions) {
    for (const { definition: tool } of extension.tools.values()) {
      collected.push(tool);
    }
  }
  return collected;
};

/**
 * @param {unknown} value
 * @returns {value is string | ArrayBuffer | ArrayBufferView}
 */
const isRequestBody = (value) =>
  typeof value === "string" || value instanceof ArrayBuffer || ArrayBuffer.isView(value);
globalThis.fetch = async () => {
  throw new Error("Unexpected network in offline Pi probe");
};
/**
 * Shut down the host session, if one was created.
 * @param {PiSession | undefined} session
 * @returns {Promise<void>}
 */
const shutdownSession = async (session) => {
  if (session) {
    try {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    } finally {
      session.dispose();
    }
  }
};

const root =
  process.argv[2] !== undefined && process.argv[2] !== ""
    ? resolve(process.argv[2])
    : dirname(findPackageJSON("@earendil-works/pi-coding-agent", import.meta.url) ?? "");
process.env.PI_PACKAGE_DIR = root;
const ai = dirname(
  findPackageJSON("@earendil-works/pi-ai", pathToFileURL(join(root, "package.json")).href) ?? "",
);
/**
 * @param {string} file
 * @returns {Promise<PiPublic>}
 */
const loadPi = (file) => import(pathToFileURL(join(root, file)).href);
/**
 * @param {string} file
 * @returns {Promise<PiAiPublic>}
 */
const loadAi = (file) => import(pathToFileURL(join(ai, file)).href);
const {
  createAgentSession,
  convertToLlm,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} = await loadPi("dist/index.js");
const {
  fauxProvider,
  fauxAssistantMessage,
  InMemoryCredentialStore,
  InMemoryModelsStore,
  normalizeContext,
} = await loadAi("dist/index.js");
/**
 * @returns {Promise<typeof import("@earendil-works/pi-ai/providers/openai")>}
 */
const loadOpenAiProvider = () => import(pathToFileURL(join(ai, "dist/providers/openai.js")).href);
/**
 * @returns {Promise<typeof import("@earendil-works/pi-ai/providers/openai-codex")>}
 */
const loadOpenAiCodexProvider = () =>
  import(pathToFileURL(join(ai, "dist/providers/openai-codex.js")).href);
const { openaiProvider } = await loadOpenAiProvider();
const { openaiCodexProvider } = await loadOpenAiCodexProvider();
const extensionPath =
  process.argv[3] !== undefined && process.argv[3] !== ""
    ? join(resolve(process.argv[3]), "extensions/macuse.ts")
    : fileURLToPath(new URL("../extensions/macuse.ts", import.meta.url));

// Astra is a user-configured route, not guaranteed to be in the host catalog.
const responsesModel = openaiProvider()
  .getModels()
  .find((model) => model.input.includes("image"));
assert.ok(responsesModel !== undefined, "Installed host has no Responses image model");
const model = { ...responsesModel, id: "gpt-6-astra" };
const scratch = await mkdtemp(join(tmpdir(), "macuse-host-"));
/** @type {PiSession | undefined} */
let session;
try {
  // Native ESM helpers resolve physical peers, not the host loader's TS aliases.
  // Copy unchanged sources into a disposable selected-host consumer; never
  // replace dependencies in the source checkout or selected host.
  const packageRoot = dirname(dirname(extensionPath));
  for (const path of ["extensions", "lib", "package.json"]) {
    await cp(join(packageRoot, path), join(scratch, path), { recursive: true });
  }
  /** @type {[string, string][]} */
  const links = [
    ["@earendil-works/pi-coding-agent", root],
    ["@earendil-works/pi-ai", ai],
    [
      "typebox",
      dirname(findPackageJSON("typebox", pathToFileURL(join(root, "package.json")).href) ?? ""),
    ],
  ];
  for (const [name, target] of links) {
    const link = join(scratch, "node_modules", name);
    await mkdir(dirname(link), { recursive: true });
    await symlink(target, link, "dir");
  }
  const faux = fauxProvider({
    provider: "macuse-image-probe",
    tokensPerSecond: 1000000,
    models: [{ id: "fixture", input: ["text", "image"] }],
  });
  faux.setResponses([
    fauxAssistantMessage(
      [
        call,
        { ...call, id: "call_redacted|fc_redacted" },
        { ...call, id: "call_text_redacted|fc_text_redacted" },
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Observed synthetic image"),
  ]);
  const credentials = new InMemoryCredentialStore();
  const modelRuntime = await ModelRuntime.create({
    credentials,
    modelsStore: new InMemoryModelsStore(),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  await modelRuntime.refresh({ providers: [faux.provider.id], allowNetwork: false });
  /** @type {ToolDefinition[]} */
  const tools = [];
  const resourceLoader = new DefaultResourceLoader({
    cwd: scratch,
    agentDir: scratch,
    noExtensions: true,
    noSkills: true,
    noThemes: true,
    noPromptTemplates: true,
    noContextFiles: true,
    additionalExtensionPaths: [join(scratch, "extensions/macuse.ts")],
    extensionFactories: [
      (pi) => {
        pi.on("tool_result", (event) => {
          if (event.toolCallId === "call_redacted|fc_redacted") {
            return { content: redacted };
          }
          if (event.toolCallId === "call_text_redacted|fc_text_redacted") {
            /** @type {ContentBlock[]} */
            const replaced = [{ type: "text", text: "Redacted text" }, originalImage];
            return { content: replaced };
          }
          return;
        });
      },
    ],
  });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  for (const tool of collectHostTools(resourceLoader.getExtensions().extensions)) {
    tools.push(tool);
    // Replace only desktop execution; the selected host loads real hooks and image helpers.
    if (tool.name === "macuse") {
      tool.execute = async () => structuredClone({ content, details });
    }
  }
  assert.ok(
    tools.some((tool) => tool.name === "macuse"),
    "Selected host must load the macuse extension",
  );
  const sm = SessionManager.inMemory(scratch);
  ({ session } = await createAgentSession({
    cwd: scratch,
    agentDir: scratch,
    modelRuntime,
    model: faux.getModel(),
    resourceLoader,
    sessionManager: sm,
    tools: ["macuse"],
    settingsManager: SettingsManager.inMemory({
      images: { autoResize: true },
      compaction: { enabled: false },
      retry: { enabled: false },
    }),
  }));
  await session.bindExtensions({
    onError: (error) => {
      throw new Error(error.error);
    },
  });
  await session.prompt("Return the controlled synthetic image.");
  const normalized = session.messages.find(
    (message) => message.role === "toolResult" && message.toolName === "macuse",
  );
  assert.ok(normalized !== undefined, "Native tool execution must produce a result");
  assert.ok(
    normalized.role === "toolResult",
    "Native tool execution must produce a toolResult message",
  );
  assert.equal(normalized.isError, true, "Actual host did not apply macuse partial-failure hook");
  const resizedImage = normalized.content.find(isImageBlock);
  if (resizedImage === undefined) {
    assert.fail("Resized image block expected");
  }
  const normalizedImageData = resizedImage.data;
  assert.notEqual(
    resizedImage.data,
    originalImage.data,
    "Fixture must exercise actual host resizing",
  );
  const normalizedDetails = normalized.details;
  assert.ok(isRecord(normalizedDetails), "Normalized tool result must carry macuse details");
  const normalizedMacuse = normalizedDetails.macuse;
  assert.ok(isRecord(normalizedMacuse), "Normalized macuse details missing");
  assert.equal(normalizedMacuse.originalContent, undefined);
  const originalImages = normalizedMacuse.originalImages;
  assert.ok(isUnknownArray(originalImages), "Normalized macuse originalImages missing");
  const firstOriginal = originalImages[0];
  assert.ok(isRecord(firstOriginal), "Normalized macuse originalImages[0] missing");
  assert.equal(firstOriginal.data, originalImage.data);
  assert.equal(
    JSON.stringify(normalized).split(originalImage.data).length - 1,
    1,
    "Original bytes must serialize once",
  );
  for (const result of session.messages.filter(
    (message) => message.role === "toolResult" && message.toolCallId.includes("redacted"),
  )) {
    assert.ok(result.role === "toolResult", "Redaction filter must keep toolResult messages");
    const redactedDetails = result.details;
    assert.ok(isRecord(redactedDetails), "Redacted result must carry details");
    const redactedMacuse = redactedDetails.macuse;
    assert.ok(isRecord(redactedMacuse), "Redacted result must carry macuse details");
    assert.equal(redactedMacuse.originalContent, undefined);
    assert.equal(
      redactedMacuse.originalImages,
      undefined,
      "A later tool_result redaction is not attributable to Pi resizing",
    );
  }
  const runner = session.extensionRunner;
  /** @type {Record<string, unknown>[]} */
  const requests = [];
  /** @type {typeof fetch} */
  const fakeFetch = async (_url, init) => {
    const raw = init?.body;
    assert.ok(isRequestBody(raw), "Fixture request body must be a string, ArrayBuffer, or view");
    let body;
    if (new Headers(init?.headers).get("content-encoding") === "zstd") {
      body = zstdDecompressSync(raw).toString();
    } else if (typeof raw === "string") {
      body = raw;
    } else {
      assert.fail("Fixture request body must be a string when not zstd-compressed");
    }
    const parsedBody = /** @type {unknown} */ (JSON.parse(body));
    assert.ok(isRecord(parsedBody), "Fixture request body must be a JSON object");
    requests.push(parsedBody);
    const event = {
      type: "response.completed",
      response: {
        id: "resp_fixture",
        status: "completed",
        output: [],
        usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      },
    };
    return new Response(
      `event: response.completed\ndata: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    );
  };
  const fakeJwt = `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "offline-fixture" } })).toString("base64url")}.fake`;
  /**
   * @param {Record<string, unknown> | undefined} request
   * @param {string} [callId]
   * @returns {Record<string, unknown>}
   */
  const callOutputItem = (request, callId) => {
    if (request === undefined) {
      assert.fail("Fixture request missing");
    }
    const input = isUnknownArray(request.input) ? request.input : [];
    const item = input.find(
      (candidate) =>
        isRecord(candidate) &&
        candidate.type === "function_call_output" &&
        (callId === undefined || candidate.call_id === callId),
    );
    if (item === undefined || !isRecord(item)) {
      assert.fail(`function_call_output ${callId ?? "(first)"} missing`);
    }
    return item;
  };
  /**
   * @param {Record<string, unknown>} item
   * @returns {Record<string, unknown>[]}
   */
  const itemBlocks = (item) => {
    if (!Array.isArray(item.output)) {
      assert.fail("function_call_output output missing");
    }
    return item.output.filter(isRecord);
  };
  const messages = sm.buildSessionContext().messages;
  /**
   * @template {string} TApi
   * @param {import("@earendil-works/pi-ai").Provider<TApi>} adapter
   * @param {import("@earendil-works/pi-ai").Model<TApi>} current
   * @param {string} auth
   * @param {AgentMessage[]} baseMessages
   * @returns {Promise<Record<string, unknown> | undefined>}
   */
  const send = async (adapter, current, auth, baseMessages) => {
    const contextMessages = await runner.emitContext(baseMessages);
    const response = await adapter
      .streamSimple(
        current,
        normalizeContext({
          systemPrompt: "Offline test",
          tools: tools.filter((t) => ["macuse", "macuse_reset"].includes(t.name)),
          messages: convertToLlm(contextMessages),
        }),
        {
          apiKey: auth,
          transport: "sse",
          maxRetries: 0,
          fetch: fakeFetch,
          reasoning: "low",
          onPayload: (payload) => runner.emitBeforeProviderRequest(payload),
        },
      )
      .result();
    assert.equal(response.stopReason, "stop", response.errorMessage);
    return requests.at(-1);
  };
  /** @typedef {ReturnType<(typeof import("@earendil-works/pi-ai/providers/openai"))["openaiProvider"]> | ReturnType<(typeof import("@earendil-works/pi-ai/providers/openai-codex"))["openaiCodexProvider"]>} ResponsesAdapter */
  /** @typedef {Parameters<ResponsesAdapter["streamSimple"]>[0]} ResponsesModel */
  /** @type {Record<string, unknown> | undefined} */
  let payload;
  /** @type {("openai-responses" | "openai-codex-responses")[]} */
  const apis = ["openai-responses", "openai-codex-responses"];
  for (const api of apis) {
    /** @type {ResponsesAdapter} */
    let adapter;
    /** @type {ResponsesModel} */
    let current;
    /** @type {string} */
    let auth;
    if (api === "openai-responses") {
      adapter = openaiProvider();
      current = { ...model, api, provider: "openai" };
      auth = "offline-only";
      await modelRuntime.setRuntimeApiKey(current.provider, "offline-only");
    } else {
      adapter = openaiCodexProvider();
      current = { ...model, api, provider: "openai-codex" };
      auth = fakeJwt;
      await credentials.modify(current.provider, async () => ({
        type: "oauth",
        access: fakeJwt,
        refresh: "offline-only",
        expires: Date.now() + 3600000,
      }));
    }
    await session.setModel(current);
    payload = await send(adapter, current, auth, messages);
    if (payload === undefined) {
      assert.fail("Fixture request missing");
    }
    const toolsPayload = payload.tools;
    assert.ok(
      Array.isArray(toolsPayload) &&
        toolsPayload.every((tool) => isRecord(tool) && tool.strict === true),
      "Responses tool schemas must be strict",
    );
    assert.equal(
      JSON.stringify(toolsPayload).includes("uniqueItems"),
      false,
      "OpenAI rejects uniqueItems in strict tool schemas",
    );
    const output = callOutputItem(payload);
    const outputImage = itemBlocks(output).find((p) => p.type === "input_image");
    if (outputImage === undefined) {
      assert.fail("input_image part missing");
    }
    assert.equal(outputImage.image_url, `data:image/png;base64,${originalImage.data}`);
    assert.equal(outputImage.detail, "auto");
    assert.equal(JSON.stringify(output).includes("displayed at"), false);
    const redactedItem = callOutputItem(payload, "call_redacted");
    const redactedImage = itemBlocks(redactedItem).find((part) => part.type === "input_image");
    if (redactedImage === undefined) {
      assert.fail("Redacted input_image part missing");
    }
    const redactedImageBlock = redacted[1];
    if (redactedImageBlock === undefined || redactedImageBlock.type !== "image") {
      assert.fail("Redacted fixture image missing");
    }
    assert.equal(redactedImage.image_url, `data:image/png;base64,${redactedImageBlock.data}`);
    const redactedText = itemBlocks(redactedItem).find((part) => part.type === "input_text");
    if (redactedText === undefined) {
      assert.fail("Redacted input_text part missing");
    }
    assert.equal(redactedText.text, "Redacted screenshot");
    const textRedactedItem = callOutputItem(payload, "call_text_redacted");
    const textRedactedText = itemBlocks(textRedactedItem).find(
      (part) => part.type === "input_text",
    );
    if (textRedactedText === undefined) {
      assert.fail("Redacted text input_text part missing");
    }
    assert.equal(
      typeof textRedactedText.text === "string" &&
        textRedactedText.text.startsWith("Redacted text"),
      true,
    );
    /**
     * A different wire identity for the same result must not restore originals.
     * @param {{ timestamp: number } | { toolCallId: string }} replacement
     * @returns {Promise<void>}
     */
    const verifyChangedIdentity = async (replacement) => {
      const changedIdentity = await send(
        adapter,
        current,
        auth,
        messages.map((message) =>
          message.role === "toolResult" && message.toolCallId === normalized.toolCallId
            ? { ...message, ...replacement }
            : message,
        ),
      );
      const changedItem = callOutputItem(changedIdentity, "call_image");
      const changedImage = itemBlocks(changedItem).find((part) => part.type === "input_image");
      if (changedImage === undefined) {
        assert.fail("Changed-identity input_image part missing");
      }
      assert.equal(
        changedImage.image_url,
        `data:image/png;base64,${normalizedImageData}`,
        "Different full result identity must not restore originals",
      );
    };
    for (const replacement of [
      { timestamp: normalized.timestamp + 1 },
      { toolCallId: "call_image|fc_other" },
    ]) {
      await verifyChangedIdentity(replacement);
    }
    const filtered = await send(
      adapter,
      current,
      auth,
      messages.map((message) =>
        message.role === "toolResult"
          ? Object.assign({}, message, {
              content: [{ type: "text", text: "Image removed by host policy" }],
            })
          : message,
      ),
    );
    assert.equal(JSON.stringify(filtered).includes("input_image"), false);
    const originalLeaf = sm.getLeafId();
    if (originalLeaf === null) {
      assert.fail("Session leaf missing before branch");
    }
    const resultEntry = sm
      .getEntries()
      .find((entry) => entry.type === "message" && entry.message.role === "toolResult");
    if (resultEntry === undefined) {
      assert.fail("toolResult session entry missing");
    }
    sm.appendContextEdit(resultEntry.id, {
      content: [{ type: "text", text: "Image removed by persisted context edit" }],
    });
    const edited = await send(adapter, current, auth, sm.buildSessionContext().messages);
    assert.equal(
      JSON.stringify(callOutputItem(edited, "call_image")).includes("input_image"),
      false,
    );
    const editedLeaf = sm.getLeafId();
    sm.branch(originalLeaf);
    await runner.emit({ type: "session_tree", oldLeafId: editedLeaf, newLeafId: originalLeaf });
    const branched = await send(adapter, current, auth, sm.buildSessionContext().messages);
    const branchedImage = itemBlocks(callOutputItem(branched)).find(
      (p) => p.type === "input_image",
    );
    if (branchedImage === undefined) {
      assert.fail("Branched input_image part missing");
    }
    assert.equal(branchedImage.image_url, `data:image/png;base64,${originalImage.data}`);
    await runner.emit({ type: "session_start", reason: "resume" });
    const resumed = await send(adapter, current, auth, sm.buildSessionContext().messages);
    const resumedImage = itemBlocks(callOutputItem(resumed)).find((p) => p.type === "input_image");
    if (resumedImage === undefined) {
      assert.fail("Resumed input_image part missing");
    }
    assert.equal(resumedImage.image_url, `data:image/png;base64,${originalImage.data}`);
  }
  sm.appendCompaction("Synthetic retained-none boundary", null, 100);
  await runner.emitContext(sm.buildSessionContext().messages);
  assert.equal(
    await runner.emitBeforeProviderRequest(requests.at(-1)),
    requests.at(-1),
    "A post-handler retain-none draft cannot restore old images",
  );
  const hostPackage = /** @type {unknown} */ (
    JSON.parse(await readFile(join(root, "package.json"), "utf8"))
  );
  assert.ok(isRecord(hostPackage), "Host package.json must be an object");
  console.log(
    JSON.stringify({
      host: root,
      version: hostPackage.version,
      ok: true,
      checks: [
        "actual tool execution and tool_result error flag",
        "actual oversized-image normalization and single-copy originals",
        "later tool_result image/text redactions preserved",
        "full call ID and timestamp correlation",
        "both Responses adapters restore matching original bytes",
        "strict code schema",
        "image-removal policy and persisted edit honored",
        "branch/resume exact-byte restoration",
        "post-handler retain-none compaction",
      ],
      mockRequests: requests.length,
    }),
  );
} finally {
  try {
    await shutdownSession(session);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
