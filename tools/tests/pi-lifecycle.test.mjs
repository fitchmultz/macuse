import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { findPackageJSON } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const originalFetch = globalThis.fetch;
test.before(() => {
  globalThis.fetch = async () => {
    throw new Error("Unexpected network in offline lifecycle test");
  };
});
test.after(() => {
  globalThis.fetch = originalFetch;
});

// Exercise either installed host's real SDK without credentials, providers or desktop calls.
/** @typedef {typeof import("@earendil-works/pi-coding-agent")} PiPublic */
/** @typedef {ReturnType<PiPublic["SessionManager"]["inMemory"]>} SessionManagerInstance */
/** @typedef {Parameters<SessionManagerInstance["appendMessage"]>[0]} AppendableMessage */
/**
 * The pi-ai test helpers are runtime-only exports without declarations, so their
 * signatures are modeled locally and validated with predicates at load time.
 *
 * @typedef {(content: Array<Record<string, unknown>>, options: { stopReason?: string }) => AppendableMessage} FauxAssistantMessage
 */
/** @typedef {(messages: ReturnType<SessionManagerInstance["buildSessionContext"]>["messages"]) => unknown} GetCurrentTools */
/** @typedef {(previous: unknown, tools: Array<{ name: string, description: unknown, parameters: unknown }>) => Record<string, unknown>} GetToolStateChanges */
/** @typedef {NonNullable<NonNullable<ConstructorParameters<PiPublic["DefaultResourceLoader"]>[0]>["extensionFactories"]>[number]} ExtensionFactory */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
/** A context without an abort signal; createToolContext requires the argument. */
/** @type {AbortSignal | undefined} */
const noSignal = undefined;
/**
 * @param {{ type: string, text?: unknown } | undefined} part
 * @returns {string}
 */
const textOf = (part) =>
  part !== undefined && part.type === "text" && typeof part.text === "string" ? part.text : "";
/** @typedef {Fixture["session"]["extensionRunner"]["emitBeforeAgentStart"]} EmitBeforeAgentStart */
/** @typedef {Awaited<ReturnType<EmitBeforeAgentStart>>} EmitResult */
/**
 * @param {unknown} value
 * @returns {value is (trigger: { messageType: "user", prompt: string }, options: unknown) => Promise<EmitResult>}
 */
const isTwoArgEmitter = (value) => typeof value === "function" && value.length === 2;
/** @typedef {NonNullable<Extract<Parameters<SessionManagerInstance["appendMessage"]>[0], { role: "toolResult" }>["details"]>} ToolResultDetails */
/**
 * @param {unknown} value
 * @returns {value is ToolResultDetails}
 */
const isToolResultDetails = function isToolResultDetails(value) {
  if (value === null) return true;
  const kind = typeof value;
  if (kind === "string" || kind === "number" || kind === "boolean") return true;
  if (Array.isArray(value)) return value.every(isToolResultDetails);
  if (isRecord(value)) return Object.values(value).every(isToolResultDetails);
  return false;
};
/** @typedef {{ register: (group: { name: string, description: string, tools: string[], instructions: () => string }) => void }} InstructionGroupsCollector */
/**
 * @param {unknown} value
 * @returns {value is InstructionGroupsCollector}
 */
const isInstructionGroupsCollector = (value) =>
  isRecord(value) && typeof value.register === "function";
/**
 * @param {unknown} value
 * @returns {value is FauxAssistantMessage}
 */
const isFauxAssistantMessage = (value) => typeof value === "function";
/**
 * @param {unknown} value
 * @returns {value is GetCurrentTools}
 */
const isGetCurrentTools = (value) => typeof value === "function";
/**
 * @param {unknown} value
 * @returns {value is GetToolStateChanges}
 */
const isGetToolStateChanges = (value) => typeof value === "function";
/**
 * @param {unknown} value
 * @returns {value is ExtensionFactory}
 */
const isExtensionFactory = (value) => typeof value === "function";

const piPackage = findPackageJSON("@earendil-works/pi-coding-agent", import.meta.url);
if (piPackage === undefined) assert.fail("pi-coding-agent package not found");
const root = process.env.MACUSE_TEST_PI_ROOT ?? dirname(piPackage);
process.env.PI_PACKAGE_DIR = root;
/**
 * @param {string} file
 * @returns {Promise<PiPublic>}
 */
const load = (file) => import(pathToFileURL(join(root, "dist/core", file)).href);
const { createAgentSession } = await load("sdk.js");
const { DefaultResourceLoader } = await load("resource-loader.js");
const { SettingsManager } = await load("settings-manager.js");
const { SessionManager } = await load("session-manager.js");
const { ModelRuntime } = await load("model-runtime.js");
/** @type {unknown} */
const piIndexModule = await import(pathToFileURL(join(root, "dist/index.js")).href);
if (!isRecord(piIndexModule)) assert.fail("pi host index module missing");
const instructionGroupsExtension = isExtensionFactory(piIndexModule.instructionGroupsExtension)
  ? piIndexModule.instructionGroupsExtension
  : undefined;
const aiPackage = findPackageJSON(
  "@earendil-works/pi-ai",
  pathToFileURL(join(root, "package.json")).href,
);
if (aiPackage === undefined) assert.fail("pi-ai package not found");
const ai = dirname(aiPackage);
/** @type {unknown} */
const aiModule = await import(pathToFileURL(join(ai, "dist/index.js")).href);
if (!isRecord(aiModule)) assert.fail("pi-ai index module missing");
if (
  !isFauxAssistantMessage(aiModule.fauxAssistantMessage) ||
  !isGetCurrentTools(aiModule.getCurrentTools) ||
  !isGetToolStateChanges(aiModule.getToolStateChanges)
)
  assert.fail("pi-ai test helpers missing");
const fauxAssistantMessage = aiModule.fauxAssistantMessage;
const getCurrentTools = aiModule.getCurrentTools;
const getToolStateChanges = aiModule.getToolStateChanges;
/** @type {unknown} */
const hostPackage = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const hostVersion = isRecord(hostPackage) ? hostPackage.version : undefined;
const entries = ["macuse", "macuse_insert_text", "macuse_reset", "macuse_tools"];

/**
 * @typedef {Awaited<ReturnType<typeof fixture>>} Fixture
 */
/**
 * @param {import("node:test").TestContext} t
 * @param {{ settings?: Record<string, unknown>, installed?: boolean, discovery?: boolean, extensionFactories?: ExtensionFactory[] } & Record<string, unknown>} [options]
 * @param {SessionManagerInstance} [manager]
 */
async function fixture(t, options = {}, manager) {
  const dir = await mkdtemp(join(tmpdir(), "macuse-lifecycle-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const {
    settings = {},
    installed = true,
    discovery = false,
    extensionFactories = [],
    ...sessionOptions
  } = options;
  await writeFile(join(dir, "settings.json"), JSON.stringify(settings));
  const settingsManager = SettingsManager.create(dir, dir);
  const resourceLoader = new DefaultResourceLoader({
    cwd: dir,
    agentDir: dir,
    settingsManager,
    noExtensions: installed,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    additionalExtensionPaths: installed ? [fileURLToPath(new URL("../../", import.meta.url))] : [],
    extensionFactories: [
      ...(discovery && instructionGroupsExtension ? [instructionGroupsExtension] : []),
      ...extensionFactories,
    ],
  });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  const modelRuntime = await ModelRuntime.create({
    authPath: join(dir, "auth.json"),
    modelsPath: null,
    modelsStorePath: join(dir, "models"),
    refreshOnCreate: false,
  });
  const sessionManager = manager ?? SessionManager.inMemory(dir);
  const model = modelRuntime.getModels()[0];
  if (model === undefined) assert.fail("no models available for the offline session");
  const { session } = await createAgentSession({
    cwd: dir,
    agentDir: dir,
    settingsManager,
    resourceLoader,
    modelRuntime,
    sessionManager,
    model,
    ...sessionOptions,
  });
  t.after(() => session.dispose());
  /** @type {unknown[]} */
  const errors = [];
  await session.bindExtensions({ onError: (/** @type {unknown} */ error) => errors.push(error) });
  assert.deepEqual(errors, []);
  return { session, sessionManager, resourceLoader, discovery, errors, dir };
}

/**
 * @param {Fixture} f
 */
function declare(f) {
  const tools = f.session.getActiveToolNames().map((name) => {
    const tool = f.session.getToolDefinition(name);
    if (tool === undefined) assert.fail(`missing tool definition: ${name}`);
    return { name, description: tool.description, parameters: tool.parameters };
  });
  const previous = getCurrentTools(f.sessionManager.buildSessionContext().messages);
  f.sessionManager.appendMessage({
    role: "system",
    content: "",
    timestamp: 0,
    ...getToolStateChanges(previous, tools),
  });
}

/**
 * @param {Fixture} f
 * @param {string} name
 * @param {Record<string, unknown>} [args]
 */
async function callTool(f, name, args = {}) {
  const id = `fixture-${f.sessionManager.getEntries().length}`;
  f.sessionManager.appendMessage(
    fauxAssistantMessage([{ type: "toolCall", id, name, arguments: args }], {
      stopReason: "toolUse",
    }),
  );
  f.session.refreshContext();
  return f.session.extensionRunner.createToolContext(id, noSignal).executeTool(name, args);
}

/**
 * @param {Fixture} f
 * @param {string} prompt
 */
function beforeAgentStart(f, prompt) {
  const runner = f.session.extensionRunner;
  // Managed runs may defer group tools; inspect reload selection before this boundary.
  if (f.discovery && instructionGroupsExtension)
    f.session.setActiveToolsByName([...f.session.getActiveToolNames(), "discover_tools"]);
  const options = { cwd: f.dir, selectedTools: f.session.getActiveToolNames() };
  const emit = runner.emitBeforeAgentStart.bind(runner);
  if (isTwoArgEmitter(emit)) return emit({ messageType: "user", prompt }, options);
  assert.fail("unsupported emitBeforeAgentStart host signature");
}

await test("macuse-only loading delivers standalone guidance and lazy loaders without browser resources", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(
    f.resourceLoader.getExtensions().extensions.map((extension) => extension.path),
    [fileURLToPath(new URL("../../extensions/macuse.ts", import.meta.url))],
  );
  assert.deepEqual(
    f.resourceLoader.getSkills().skills.map((skill) => skill.name),
    ["macuse"],
  );
  for (const name of [...entries, "macuse_enable"])
    assert.ok(f.session.getActiveToolNames().includes(name), name);
  const start = await beforeAgentStart(f, "Offline standalone guidance");
  assert.match(
    start.systemPromptOptions.sections.macos ?? "",
    /If no suitable browser capability is available, state that limitation/,
  );
  assert.equal((await callTool(f, "macuse_enable")).isError, false);
  const loaded = await callTool(f, "macuse_tools", { tools: ["computer_history_status"] });
  assert.equal(loaded.isError, false);
  assert.deepEqual(isRecord(loaded.result.details) ? loaded.result.details.added : undefined, [
    "computer_history_status",
  ]);
  assert.ok(!f.session.getActiveToolNames().includes("event_stream_start"));
  let status = "";
  const statusCommand = f.session.extensionRunner.getCommand("macuse-status");
  if (statusCommand === undefined) assert.fail("macuse-status command missing");
  // The handler only reads hasUI and ui.notify (extensions/macuse.ts), so the
  // simulated host context supplies exactly those.
  await statusCommand.handler(
    "",
    // The handler only reads hasUI and ui.notify (verified in extensions/macuse.ts);
    // the full host context type cannot be constructed offline.
    // oxlint-disable-next-line no-unsafe-type-assertion
    /** @type {import("@earendil-works/pi-coding-agent").ExtensionCommandContext} */ ({
      hasUI: true,
      ui: {
        notify: (text) => {
          status = text;
        },
      },
    }),
  );
  assert.match(
    status,
    /macuse is stopped/,
    "Loading tools must not start native or auxiliary services",
  );
  assert.deepEqual(f.errors, []);
});

await test("native defaults can select auxiliary tools at startup without activating their siblings", async (t) => {
  const f = await fixture(t, { settings: { defaultTools: ["+computer_history_status"] } });
  assert.ok(f.session.getActiveToolNames().includes("computer_history_status"));
  assert.ok(!f.session.getActiveToolNames().includes("computer_history_resume"));
  assert.deepEqual(f.errors, []);
});

await test("first installation on reload activates defaults without resurrecting later live deselections", async (t) => {
  const settings = {
    extensions: ["-builtin:mcp", "-builtin:llama.cpp", "-builtin:codemode", "-builtin:tool-search"],
  };
  const f = await fixture(t, { installed: false, settings });
  declare(f);
  settings.extensions.push(fileURLToPath(new URL("../../extensions/macuse.ts", import.meta.url)));
  await writeFile(join(f.dir, "settings.json"), JSON.stringify(settings));
  await f.session.reload();
  assert.deepEqual(
    f.session
      .getActiveToolNames()
      .filter((name) => entries.includes(name))
      .sort(),
    ["macuse", "macuse_insert_text", "macuse_reset", "macuse_tools"],
  );
  assert.ok(!f.session.getActiveToolNames().includes("computer_history_status"));
  f.session.setActiveToolsByName([]);
  await f.session.reload();
  assert.deepEqual(
    f.session.getActiveToolNames().filter((name) => name !== "macuse_enable"),
    [],
  );
  assert.deepEqual(f.errors, []);
});

for (const boundary of ["resume", "fork"])
  await test(`first installation on ${boundary} ignores unrelated saved tool declarations`, async (t) => {
    const f = await fixture(t, { installed: false });
    declare(f);
    const next = await fixture(
      t,
      { discovery: true, sessionStartEvent: { type: "session_start", reason: boundary } },
      f.sessionManager,
    );
    assert.deepEqual(
      next.session
        .getActiveToolNames()
        .filter((name) => entries.includes(name))
        .sort(),
      ["macuse", "macuse_insert_text", "macuse_reset", "macuse_tools"],
    );
    assert.ok(!next.session.getActiveToolNames().includes("computer_history_status"));
    if (instructionGroupsExtension) {
      const discover = () => {
        const tool = next.session.getToolDefinition("discover_tools");
        if (tool === undefined) assert.fail("discover_tools missing");
        return tool;
      };
      const context = () =>
        next.session.extensionRunner.createToolContext("discover-fixture", noSignal);
      await beforeAgentStart(next, "Offline discovery");
      assert.match(
        textOf((await discover().execute("list", {}, undefined, undefined, context())).content[0]),
        /macos:/,
      );
      assert.ok(!next.session.getActiveToolNames().includes("macuse"));
      await next.session.reload();
      const result = await discover().execute(
        "enable",
        { enable: ["macos"] },
        undefined,
        undefined,
        context(),
      );
      assert.match(textOf(result.content[0]), /allowMutating:true/);
      assert.ok(next.session.getActiveToolNames().includes("macuse"));
      assert.ok(!next.session.getActiveToolNames().includes("computer_history_status"));
    } else {
      const start = await beforeAgentStart(next, "Offline discovery");
      assert.match(start.systemPromptOptions.sections.macos ?? "", /allowMutating:true/);
      assert.match(start.systemPromptOptions.sections.macos ?? "", /allowPrivacyChange:true/);
    }
    next.session.setActiveToolsByName([]);
    declare(next);
    await next.session.reload();
    assert.deepEqual(
      next.session.getActiveToolNames().filter((name) => entries.includes(name)),
      [],
    );
    const resumed = await fixture(
      t,
      { discovery: true, sessionStartEvent: { type: "session_start", reason: "resume" } },
      f.sessionManager,
    );
    assert.deepEqual(
      resumed.session.getActiveToolNames().filter((name) => entries.includes(name)),
      [],
    );
    assert.deepEqual(resumed.errors, []);
    assert.deepEqual(next.errors, []);
  });

for (const frontDoor of ["command", "tool"])
  for (const [policy, permitted] of /** @type {[Record<string, unknown>, string[]][]} */ ([
    [{}, entries],
    [{ excludeTools: ["macuse_reset"] }, ["macuse", "macuse_insert_text", "macuse_tools"]],
    [{ tools: ["read", "macuse_tools", "macuse_enable"] }, ["macuse_tools"]],
    [{ excludeTools: ["macuse_enable"] }, entries],
    [{ noTools: "all" }, []],
  ]))
    await test(`explicit ${frontDoor} recovery repairs marker-only selection within policy ${JSON.stringify(policy)}`, async (t) => {
      const old = await fixture(t, { installed: false });
      declare(old);
      old.sessionManager.appendCustomEntry("macuse-initialized", {});
      // A saved loadout owns resume selection. To exercise default activation of a
      // newly installed recovery tool, install it on reload rather than registering
      // it before resume and expecting reload to undo the restored deselection.
      const settings = {
        extensions: [
          "-builtin:mcp",
          "-builtin:llama.cpp",
          "-builtin:codemode",
          "-builtin:tool-search",
        ],
      };
      const f = await fixture(
        t,
        {
          ...policy,
          discovery: true,
          installed: frontDoor !== "tool",
          settings,
          sessionStartEvent: { type: "session_start", reason: "resume" },
        },
        old.sessionManager,
      );
      assert.deepEqual(
        f.session.getActiveToolNames().filter((name) => entries.includes(name)),
        [],
      );
      if (frontDoor === "tool") {
        assert.equal(f.session.getToolDefinition("macuse_enable"), undefined);
        settings.extensions.push(
          fileURLToPath(new URL("../../extensions/macuse.ts", import.meta.url)),
        );
        await writeFile(join(f.dir, "settings.json"), JSON.stringify(settings));
      }
      await f.session.reload();
      assert.deepEqual(
        f.session.getActiveToolNames().filter((name) => entries.includes(name)),
        policy.tools !== undefined && policy.tools !== null ? permitted : [],
        "Reload must not reinitialize a marker-only selection",
      );
      await beforeAgentStart(f, "Offline explicit recovery");
      const before = f.session.getActiveToolNames();
      assert.deepEqual(
        before.filter((name) => entries.includes(name)),
        policy.tools !== undefined && policy.tools !== null ? permitted : [],
        "Only explicit policy may select entries before recovery",
      );
      if (frontDoor === "tool" && !f.session.getToolDefinition("macuse_enable")) {
        assert.equal((await callTool(f, "macuse_enable")).isError, true);
        assert.deepEqual(f.session.getActiveToolNames(), before);
        assert.deepEqual(f.errors, []);
        return;
      }
      if (frontDoor === "tool" && Object.keys(policy).length === 0) {
        assert.ok(
          before.includes("macuse_enable"),
          "The ungrouped recovery default must be available on old-marker reload",
        );
        assert.equal((await callTool(f, "macuse_enable", { unexpected: true })).isError, true);
        assert.deepEqual(f.session.getActiveToolNames(), before);
      }
      const enable = async () => {
        if (frontDoor === "command") {
          await f.session.prompt("/macuse-enable");
          return f.session.messages.findLast(
            (message) => message.role === "custom" && message.customType === "macuse-enable",
          );
        }
        const outcome = await callTool(f, "macuse_enable");
        assert.equal(outcome.isError, false, JSON.stringify(outcome.result));
        return outcome.result;
      };
      const result = await enable();
      if (result === undefined || !("details" in result)) assert.fail("no macuse-enable result");
      const resultDetails = isRecord(result.details) ? result.details : undefined;
      if (resultDetails === undefined) assert.fail("missing macuse-enable details");
      assert.deepEqual(
        f.session.getActiveToolNames().filter((name) => entries.includes(name)),
        permitted,
      );
      assert.deepEqual(
        f.session.getActiveToolNames().filter((name) => !entries.includes(name)),
        before.filter((name) => !entries.includes(name)),
      );
      assert.deepEqual(
        f.session
          .getActiveToolNames()
          .filter((name) => /^(event_stream|computer_history)_/.test(name)),
        [],
      );
      assert.deepEqual(
        resultDetails.added,
        permitted.filter((name) => !before.includes(name)),
      );
      assert.deepEqual(
        resultDetails.alreadyActive,
        permitted.filter((name) => before.includes(name)),
      );
      assert.deepEqual(
        resultDetails.unavailable,
        entries.filter((name) => !permitted.includes(name)),
      );
      const repeat = await enable();
      if (repeat === undefined || !("details" in repeat)) assert.fail("no repeat enable result");
      const repeatDetails = isRecord(repeat.details) ? repeat.details : undefined;
      if (repeatDetails === undefined) assert.fail("missing repeat enable details");
      assert.deepEqual(repeatDetails.added, []);
      assert.deepEqual(repeatDetails.alreadyActive, permitted);
      let status = "";
      const statusCommand = f.session.extensionRunner.getCommand("macuse-status");
      if (statusCommand === undefined) assert.fail("macuse-status command missing");
      // The handler only reads hasUI and ui.notify (extensions/macuse.ts).
      await statusCommand.handler(
        "",
        // The handler only reads hasUI and ui.notify (verified in extensions/macuse.ts);
        // the full host context type cannot be constructed offline.
        // oxlint-disable-next-line no-unsafe-type-assertion
        /** @type {import("@earendil-works/pi-coding-agent").ExtensionCommandContext} */ ({
          hasUI: true,
          ui: {
            notify: (text) => {
              status = text;
            },
          },
        }),
      );
      assert.match(status, /macuse is stopped/);
      assert.deepEqual(f.errors, []);
    });

await test("model recovery preserves another suppressed group and retains the macos instruction gate", async (t) => {
  const f = await fixture(t, {
    discovery: true,
    extensionFactories: [
      (pi) => {
        pi.events.on("pi:instruction-groups", (/** @type {unknown} */ collector) => {
          if (!isInstructionGroupsCollector(collector))
            assert.fail("instruction-groups collector missing");
          collector.register({
            name: "filesystem",
            description: "Synthetic read instruction owner",
            tools: ["read"],
            instructions: () => "Synthetic read instructions: inspect only the approved fixture.",
          });
        });
      },
    ],
  });
  await beforeAgentStart(f, "Offline group recovery");
  const before = f.session.getActiveToolNames();
  assert.equal((await callTool(f, "macuse_enable")).isError, false);
  assert.deepEqual(
    f.session.getActiveToolNames().filter((name) => !entries.includes(name)),
    before.filter((name) => !entries.includes(name)),
  );
  if (instructionGroupsExtension) {
    const discover = f.session.getToolDefinition("discover_tools");
    if (discover === undefined) assert.fail("discover_tools missing");
    const ctx = f.session.extensionRunner.createToolContext("discovery", noSignal);
    assert.match(
      textOf((await discover.execute("list", {}, undefined, undefined, ctx)).content[0]),
      /filesystem:/,
    );
    const result = await discover.execute(
      "enable",
      { enable: ["macos"] },
      undefined,
      undefined,
      ctx,
    );
    f.sessionManager.appendMessage(
      fauxAssistantMessage(
        [
          {
            type: "toolCall",
            id: "discovery",
            name: "discover_tools",
            arguments: { enable: ["macos"] },
          },
        ],
        { stopReason: "toolUse" },
      ),
    );
    f.session.refreshContext();
    const toolContext = f.session.extensionRunner.createToolContext("discovery", noSignal);
    const blocked = await toolContext.executeTool("macuse_reset", {});
    assert.equal(blocked.isError, true);
    assert.match(textOf(blocked.result.content[0]), /Read discover_tools instructions/);
    f.sessionManager.appendMessage({
      role: "toolResult",
      toolCallId: "discovery",
      toolName: "discover_tools",
      content: result.content,
      ...(isToolResultDetails(result.details) ? { details: result.details } : {}),
      isError: false,
      timestamp: 1,
    });
    f.session.refreshContext();
    await f.session.extensionRunner.emit({ type: "turn_start", turnIndex: 1, timestamp: 2 });
    await f.session.extensionRunner.emitContext(f.sessionManager.buildSessionContext().messages);
    assert.equal(
      (await toolContext.executeTool("macuse_reset", {})).isError,
      false,
      "Next-turn native tool call must pass the instruction gate",
    );
    await discover.execute("enable-other", { enable: ["filesystem"] }, undefined, undefined, ctx);
    assert.ok(
      f.session.getActiveToolNames().includes("read"),
      "Other group selection must remain recoverable",
    );
  }
  assert.deepEqual(f.errors, []);
});

await test("reload preserves newly added host defaults, live deselections and exclusions", async (t) => {
  if (hostVersion === "0.99.1") {
    t.skip("This qualified fork predates native defaultTools additions on reload");
    return;
  }
  const f = await fixture(t, { excludeTools: ["computer_history_resume"] });
  f.session.setActiveToolsByName(["macuse_tools"]);
  declare(f);
  await writeFile(
    join(f.dir, "settings.json"),
    JSON.stringify({
      defaultTools: [
        "+computer_history_status",
        "+computer_history_resume",
        "+macuse_reset",
        "+grep",
      ],
    }),
  );
  await f.session.reload();
  assert.deepEqual(
    f.session
      .getActiveToolNames()
      .filter((name) => name !== "macuse_enable")
      .sort(),
    ["macuse_tools", "computer_history_status", "macuse_reset", "grep"].sort(),
  );
  // No request/declaration occurs between these live selection changes and reload.
  f.session.setActiveToolsByName(["macuse_tools", "grep"]);
  await f.session.reload();
  assert.deepEqual(
    f.session
      .getActiveToolNames()
      .filter((name) => name !== "macuse_enable")
      .sort(),
    ["grep", "macuse_tools"],
  );
  assert.deepEqual(f.errors, []);
});

for (const boundary of ["reload", "resume", "fork"])
  await test(`native SDK preserves loader-selected auxiliary through ${boundary}`, async (t) => {
    const f = await fixture(t);
    assert.ok(!f.session.getActiveToolNames().includes("computer_history_status"));
    const loader = f.session.getToolDefinition("macuse_tools");
    if (loader === undefined) assert.fail("macuse_tools missing");
    await loader.execute(
      "load",
      { tools: ["computer_history_status"] },
      undefined,
      undefined,
      f.session.extensionRunner.createToolContext("macuse_tools", noSignal),
    );
    const expected = f.session.getActiveToolNames();
    declare(f);
    if (boundary === "reload") {
      await f.session.reload();
      assert.deepEqual(f.session.getActiveToolNames().sort(), expected.sort());
      assert.deepEqual(f.errors, []);
    } else {
      const next = await fixture(
        t,
        { sessionStartEvent: { type: "session_start", reason: boundary } },
        f.sessionManager,
      );
      assert.deepEqual(next.session.getActiveToolNames().sort(), expected.sort());
      assert.deepEqual(next.errors, []);
    }
  });

for (const options of [
  { tools: ["computer_history_status"] },
  { excludeTools: ["macuse_tools"] },
  { tools: [] },
  { noTools: "all" },
])
  await test(`native SDK respects tool policy ${JSON.stringify(options)}`, async (t) => {
    const f = await fixture(t, options);
    const before = f.session.getActiveToolNames();
    if (options.excludeTools)
      assert.ok(
        before.includes("computer_history_status"),
        "loader exclusion must not strand auxiliary tools",
      );
    else assert.deepEqual(before, options.tools ?? []);
    declare(f);
    await f.session.reload();
    assert.deepEqual(f.session.getActiveToolNames().sort(), before.sort());
    assert.deepEqual(f.errors, []);
  });

await test("native projection respects removed tools, empty selection, branches and compaction", async (t) => {
  const f = await fixture(t);
  // Record the initial loadout before deselecting it. Pi 1.4 treats an unmentioned
  // default-active tool as newly registered, not as an explicitly removed tool.
  declare(f);
  f.session.setActiveToolsByName(["macuse_tools", "computer_history_status"]);
  declare(f);
  const selected = f.sessionManager.getLeafId();
  f.session.setActiveToolsByName(["macuse_tools"]);
  f.sessionManager.appendMessage({
    role: "system",
    content: "",
    toolsRemoved: [{ name: "computer_history_status" }],
    timestamp: 1,
  });
  await f.session.reload();
  assert.deepEqual(
    f.session.getActiveToolNames().filter((name) => name !== "macuse_enable"),
    ["macuse_tools"],
  );
  if (selected === null) assert.fail("no leaf entry to navigate");
  await f.session.navigateTree(selected);
  assert.deepEqual(f.session.getActiveToolNames().sort(), [
    "computer_history_status",
    "macuse_tools",
  ]);
  f.sessionManager.appendCompaction("Offline summary", null, 100);
  await f.session.reload();
  assert.deepEqual(
    f.session
      .getActiveToolNames()
      .filter((name) => name !== "macuse_enable")
      .sort(),
    ["computer_history_status", "macuse_tools"],
  );
  f.session.setActiveToolsByName([]);
  f.sessionManager.appendMessage({
    role: "system",
    content: "",
    toolsRemoved: [{ name: "macuse_tools" }, { name: "computer_history_status" }],
    timestamp: 2,
  });
  await f.session.reload();
  assert.deepEqual(
    f.session
      .getActiveToolNames()
      .filter((name) => entries.includes(name) || name === "computer_history_status"),
    [],
  );
  assert.deepEqual(f.errors, []);
});

await test("saved selection never bypasses a new host exclusion", async (t) => {
  const f = await fixture(t);
  f.session.setActiveToolsByName(["macuse_tools", "computer_history_status"]);
  declare(f);
  const next = await fixture(
    t,
    {
      excludeTools: ["computer_history_status"],
      sessionStartEvent: { type: "session_start", reason: "resume" },
    },
    f.sessionManager,
  );
  assert.ok(!next.session.getActiveToolNames().includes("computer_history_status"));
  const loaderTool = next.session.getToolDefinition("macuse_tools");
  if (loaderTool === undefined) assert.fail("macuse_tools missing");
  const result = await loaderTool.execute(
    "load",
    { tools: ["computer_history_status"] },
    undefined,
    undefined,
    next.session.extensionRunner.createToolContext("macuse_tools", noSignal),
  );
  assert.deepEqual(isRecord(result.details) ? result.details.unavailable : undefined, [
    "computer_history_status",
  ]);
  assert.deepEqual(next.errors, []);
});

await test("explicit CLI selection wins over a saved declaration on resume", async (t) => {
  const f = await fixture(t);
  f.session.setActiveToolsByName(["macuse"]);
  declare(f);
  const argv = process.argv;
  try {
    for (const args of [
      ["--tools", "macuse_reset"],
      ["-t", "macuse_reset"],
      ["--tools=macuse_reset"],
      ["--", "--tools", "macuse_reset"],
    ]) {
      process.argv = [...argv.slice(0, 2), ...args];
      const next = await fixture(
        t,
        { tools: ["macuse_reset"], sessionStartEvent: { type: "session_start", reason: "resume" } },
        f.sessionManager,
      );
      assert.deepEqual(next.session.getActiveToolNames(), args[0] === "--" ? [] : ["macuse_reset"]);
      assert.deepEqual(next.errors, []);
    }
  } finally {
    process.argv = argv;
  }
});

await test("exclusion-only resume does not resurrect deselected auxiliary tools", async (t) => {
  const f = await fixture(t);
  f.session.setActiveToolsByName(["macuse"]);
  declare(f);
  const owned = new Set(
    f.session
      .getAllTools()
      .filter((tool) => tool.sourceInfo.source !== "builtin" && tool.name !== "macuse_enable")
      .map((tool) => tool.name),
  );
  const next = await fixture(
    t,
    {
      excludeTools: ["computer_history_status"],
      sessionStartEvent: { type: "session_start", reason: "resume" },
    },
    f.sessionManager,
  );
  assert.deepEqual(
    next.session.getActiveToolNames().filter((name) => owned.has(name)),
    ["macuse"],
  );
  assert.deepEqual(next.errors, []);
});

for (const selected of [["macuse_reset"], ["macuse", "computer_history_status"], []]) {
  await test(`SDK post-bind selection replaces saved declaration: ${JSON.stringify(selected)}`, async (t) => {
    const f = await fixture(t);
    f.session.setActiveToolsByName(["macuse"]);
    declare(f);
    const next = await fixture(
      t,
      { tools: selected, sessionStartEvent: { type: "session_start", reason: "resume" } },
      f.sessionManager,
    );
    next.session.setActiveToolsByName(selected);
    assert.deepEqual(next.session.getActiveToolNames(), selected);
    assert.deepEqual(next.errors, []);
  });
}

await test("SDK post-bind selection cannot bypass exclusions", async (t) => {
  const f = await fixture(t);
  f.session.setActiveToolsByName(["macuse"]);
  declare(f);
  const next = await fixture(
    t,
    {
      excludeTools: ["computer_history_status"],
      sessionStartEvent: { type: "session_start", reason: "resume" },
    },
    f.sessionManager,
  );
  next.session.setActiveToolsByName(["macuse", "computer_history_status"]);
  assert.deepEqual(next.session.getActiveToolNames(), ["macuse"]);
  assert.deepEqual(next.errors, []);
});

await test("native tree and reload boundaries stop the owned session without starting native services", async (t) => {
  const f = await fixture(t);
  declare(f);
  const selected = f.sessionManager.getLeafId();
  f.sessionManager.appendMessage({ role: "user", content: "Offline branch", timestamp: 1 });
  const createOwnedSession = async () => {
    const macuseTool = f.session.getToolDefinition("macuse");
    if (macuseTool === undefined) assert.fail("macuse tool missing");
    const result = await macuseTool.execute(
      "invalid",
      {},
      undefined,
      undefined,
      f.session.extensionRunner.createToolContext("owned-fixture", noSignal),
    );
    const details = isRecord(result.details) ? result.details : undefined;
    if (details === undefined) assert.fail("missing macuse result details");
    const dispatchMeta = isRecord(details.macuse) ? details.macuse : undefined;
    if (dispatchMeta === undefined) assert.fail("missing macuse dispatch meta");
    assert.equal(dispatchMeta.dispatched, false);
    const statusCommand = f.session.extensionRunner.getCommand("macuse-status");
    if (statusCommand === undefined) assert.fail("macuse-status command missing");
    const read = async () => {
      let text = "";
      // The handler only reads hasUI and ui.notify (extensions/macuse.ts).
      await statusCommand.handler(
        "",
        // The handler only reads hasUI and ui.notify (verified in extensions/macuse.ts);
        // the full host context type cannot be constructed offline.
        // oxlint-disable-next-line no-unsafe-type-assertion
        /** @type {import("@earendil-works/pi-coding-agent").ExtensionCommandContext} */ ({
          hasUI: true,
          ui: {
            notify: (value) => {
              text = value;
            },
          },
        }),
      );
      return text;
    };
    assert.ok(
      (await read()).startsWith("{"),
      "A refused call still creates an owned, unstarted session",
    );
    return read;
  };
  if (selected === null) assert.fail("no leaf entry to navigate");
  const treeStatus = await createOwnedSession();
  await f.session.navigateTree(selected);
  assert.match(await treeStatus(), /macuse is stopped/);
  const reloadStatus = await createOwnedSession();
  await f.session.reload();
  assert.match(await reloadStatus(), /macuse is stopped/);
  assert.deepEqual(f.errors, []);
});
