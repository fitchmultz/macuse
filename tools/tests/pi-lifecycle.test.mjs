import assert from "node:assert/strict";
import nodeTest from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { findPackageJSON } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const originalFetch = globalThis.fetch;
nodeTest.before(() => {
  globalThis.fetch = async () => {
    throw new Error("Unexpected network in offline lifecycle test");
  };
});
nodeTest.after(() => {
  globalThis.fetch = originalFetch;
});

// Exercise either installed host's real SDK without credentials, providers or desktop calls.
/** @typedef {typeof import("@earendil-works/pi-coding-agent")} PiPublic */
/** @typedef {ReturnType<PiPublic["SessionManager"]["inMemory"]>} SessionManagerInstance */
/** @typedef {Parameters<SessionManagerInstance["appendMessage"]>[0]} AppendableMessage */
/**
 * The pi-ai test helpers are runtime-only exports without declarations, so their
 * signatures are modeled locally and validated with predicates at load time.
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
/** @typedef {Fixture["session"]["extensionRunner"]["emitBeforeAgentStart"]} EmitBeforeAgentStart */
/** @typedef {Awaited<ReturnType<EmitBeforeAgentStart>>} EmitResult */
/**
 * @param {unknown} value
 * @returns {value is (trigger: { messageType: "user", prompt: string }, options: unknown) => Promise<EmitResult>}
 */
const isTwoArgEmitter = (value) => typeof value === "function" && value.length === 2;
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

const piPackage = findPackageJSON("@earendil-works/pi-coding-agent", import.meta.url);
if (piPackage === undefined) {
  assert.fail("pi-coding-agent package not found");
}
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
const aiPackage = findPackageJSON(
  "@earendil-works/pi-ai",
  pathToFileURL(join(root, "package.json")).href,
);
if (aiPackage === undefined) {
  assert.fail("pi-ai package not found");
}
const ai = dirname(aiPackage);
/** @type {unknown} */
const aiModule = await import(pathToFileURL(join(ai, "dist/index.js")).href);
if (!isRecord(aiModule)) {
  assert.fail("pi-ai index module missing");
}
if (
  !isGetCurrentTools(aiModule.getCurrentTools) ||
  !isGetToolStateChanges(aiModule.getToolStateChanges)
) {
  assert.fail("pi-ai test helpers missing");
}
const getCurrentTools = aiModule.getCurrentTools;
const getToolStateChanges = aiModule.getToolStateChanges;
const entries = ["macuse", "macuse_insert_text", "macuse_reset"];
const auxiliary = [
  "event_stream_start",
  "event_stream_status",
  "event_stream_stop",
  "computer_history_pause",
  "computer_history_resume",
  "computer_history_status",
  "computer_history_get_settings",
  "computer_history_update_settings",
];

/**
 * @typedef {Awaited<ReturnType<typeof fixture>>} Fixture
 */
/**
 * @param {import("node:test").TestContext} t
 * @param {{ settings?: Record<string, unknown>, installed?: boolean, extensionFactories?: ExtensionFactory[] } & Record<string, unknown>} [options]
 * @param {SessionManagerInstance} [manager]
 */
async function fixture(t, options = {}, manager) {
  const dir = await mkdtemp(join(tmpdir(), "macuse-lifecycle-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { settings = {}, installed = true, extensionFactories = [], ...sessionOptions } = options;
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
    extensionFactories,
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
  if (model === undefined) {
    assert.fail("no models available for the offline session");
  }
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
  return { session, sessionManager, resourceLoader, errors, dir };
}

/**
 * @param {Fixture} f
 */
function declare(f) {
  const tools = f.session.getActiveToolNames().map((name) => {
    const tool = f.session.getToolDefinition(name);
    if (tool === undefined) {
      assert.fail(`missing tool definition: ${name}`);
    }
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
 * @param {string} prompt
 */
function beforeAgentStart(f, prompt) {
  const runner = f.session.extensionRunner;
  const options = { cwd: f.dir, selectedTools: f.session.getActiveToolNames() };
  const emit = runner.emitBeforeAgentStart.bind(runner);
  if (isTwoArgEmitter(emit)) {
    return emit({ messageType: "user", prompt }, options);
  }
  assert.fail("unsupported emitBeforeAgentStart host signature");
}

nodeTest(
  "macuse-only loading activates the entry tools, defers recording/history, and delivers short guidance",
  async (t) => {
    const f = await fixture(t);
    assert.deepEqual(
      f.resourceLoader.getExtensions().extensions.map((extension) => extension.path),
      [fileURLToPath(new URL("../../extensions/macuse.ts", import.meta.url))],
    );
    assert.deepEqual(
      f.resourceLoader.getSkills().skills.map((skill) => skill.name),
      ["macuse"],
    );
    for (const name of entries) {
      assert.ok(f.session.getActiveToolNames().includes(name), name);
    }
    for (const name of auxiliary) {
      assert.ok(!f.session.getActiveToolNames().includes(name), name);
      assert.equal(f.session.getToolDefinition(name)?.exposure, "deferred", name);
      assert.ok(
        f.session.getCallableToolNames().includes(name),
        `${name} is callable from scripts`,
      );
    }
    for (const retired of ["macuse_tools", "macuse_enable"]) {
      assert.equal(f.session.getToolDefinition(retired), undefined, retired);
    }
    const start = await beforeAgentStart(f, "Offline standalone guidance");
    const macos = start.systemPromptOptions.sections.macos ?? "";
    assert.ok(
      macos.length > 0 && macos.length < 2000,
      `macos section is ${macos.length} characters`,
    );
    assert.match(macos, /allowMutating:true/);
    assert.match(macos, /tool_search/);
    let status = "";
    const statusCommand = f.session.extensionRunner.getCommand("macuse-status");
    if (statusCommand === undefined) {
      assert.fail("macuse-status command missing");
    }
    // The handler only reads hasUI and ui.notify (extensions/macuse.ts), so the
    // simulated host context supplies exactly those.
    await statusCommand.handler(
      "",
      // The handler only reads hasUI and ui.notify (verified in extensions/macuse.ts);
      // the full host context type cannot be constructed offline.
      // oxlint-disable-next-line no-unsafe-type-assertion -- QX-007: Partial host context exercises the status handler.
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
      "Startup must not start native or auxiliary services",
    );
    assert.deepEqual(f.errors, []);
  },
);

nodeTest(
  "native defaults can select auxiliary tools at startup without activating their siblings",
  async (t) => {
    const f = await fixture(t, { settings: { defaultTools: ["+computer_history_status"] } });
    assert.ok(f.session.getActiveToolNames().includes("computer_history_status"));
    assert.ok(!f.session.getActiveToolNames().includes("computer_history_resume"));
    assert.deepEqual(f.errors, []);
  },
);

nodeTest("first installation on reload activates only the entry tools", async (t) => {
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
    [...entries].sort(),
  );
  for (const name of auxiliary) {
    assert.ok(!f.session.getActiveToolNames().includes(name), name);
  }
  assert.deepEqual(f.errors, []);
});

for (const boundary of ["resume", "fork"]) {
  nodeTest(
    `first installation on ${boundary} activates the entry tools next to unrelated saved declarations`,
    async (t) => {
      const f = await fixture(t, { installed: false });
      declare(f);
      const next = await fixture(
        t,
        { sessionStartEvent: { type: "session_start", reason: boundary } },
        f.sessionManager,
      );
      assert.deepEqual(
        next.session
          .getActiveToolNames()
          .filter((name) => entries.includes(name))
          .sort(),
        [...entries].sort(),
      );
      assert.ok(!next.session.getActiveToolNames().includes("computer_history_status"));
      const start = await beforeAgentStart(next, "Offline guidance");
      assert.match(start.systemPromptOptions.sections.macos ?? "", /allowMutating:true/);
      assert.match(start.systemPromptOptions.sections.macos ?? "", /allowPrivacyChange:true/);
      // Record the loadout first: Pi treats a never-mentioned extension tool as newly
      // registered on the next resume, while a recorded removal stays inactive.
      declare(next);
      next.session.setActiveToolsByName([]);
      declare(next);
      const resumed = await fixture(
        t,
        { sessionStartEvent: { type: "session_start", reason: "resume" } },
        f.sessionManager,
      );
      assert.deepEqual(
        resumed.session.getActiveToolNames().filter((name) => entries.includes(name)),
        [],
      );
      assert.deepEqual(resumed.errors, []);
      assert.deepEqual(next.errors, []);
    },
  );
}

for (const boundary of ["reload", "resume", "fork"]) {
  nodeTest(`native SDK preserves a loaded deferred tool through ${boundary}`, async (t) => {
    const f = await fixture(t);
    assert.ok(!f.session.getActiveToolNames().includes("computer_history_status"));
    // tool_search loads a deferred tool through the same native active-tool set.
    f.session.setActiveToolsByName([...f.session.getActiveToolNames(), "computer_history_status"]);
    assert.ok(f.session.getActiveToolNames().includes("computer_history_status"));
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
}

for (const options of [
  { tools: ["computer_history_status"] },
  { excludeTools: ["macuse_reset"] },
  { tools: [] },
  { noTools: "all" },
]) {
  nodeTest(`native SDK respects tool policy ${JSON.stringify(options)}`, async (t) => {
    const f = await fixture(t, options);
    const before = f.session.getActiveToolNames();
    if (options.excludeTools) {
      assert.ok(before.includes("macuse"));
      assert.ok(!before.includes("macuse_reset"), "exclusions remove entry tools");
      assert.equal(f.session.getToolDefinition("macuse_reset"), undefined);
    } else {
      assert.deepEqual(before, options.tools ?? []);
    }
    declare(f);
    await f.session.reload();
    assert.deepEqual(f.session.getActiveToolNames().sort(), before.sort());
    assert.deepEqual(f.errors, []);
  });
}

nodeTest(
  "native projection respects recorded removals, empty selection, branches and compaction",
  async (t) => {
    const f = await fixture(t);
    // Record the initial loadout before deselecting it. Pi treats an unmentioned
    // default-active tool as newly registered, not as an explicitly removed tool.
    declare(f);
    f.session.setActiveToolsByName(["macuse_reset", "computer_history_status"]);
    declare(f);
    const selected = f.sessionManager.getLeafId();
    f.session.setActiveToolsByName(["macuse_reset"]);
    f.sessionManager.appendMessage({
      role: "system",
      content: "",
      toolsRemoved: [{ name: "computer_history_status" }],
      timestamp: 1,
    });
    const resume = () =>
      fixture(
        t,
        { sessionStartEvent: { type: "session_start", reason: "resume" } },
        f.sessionManager,
      );
    const first = await resume();
    assert.deepEqual(first.session.getActiveToolNames(), ["macuse_reset"]);
    if (selected === null) {
      assert.fail("no leaf entry to navigate");
    }
    await first.session.navigateTree(selected);
    assert.deepEqual(first.session.getActiveToolNames().sort(), [
      "computer_history_status",
      "macuse_reset",
    ]);
    f.sessionManager.appendCompaction("Offline summary", null, 100);
    const compacted = await resume();
    assert.deepEqual(compacted.session.getActiveToolNames().sort(), [
      "computer_history_status",
      "macuse_reset",
    ]);
    compacted.session.setActiveToolsByName([]);
    f.sessionManager.appendMessage({
      role: "system",
      content: "",
      toolsRemoved: [{ name: "macuse_reset" }, { name: "computer_history_status" }],
      timestamp: 2,
    });
    const emptied = await resume();
    assert.deepEqual(
      emptied.session
        .getActiveToolNames()
        .filter((name) => entries.includes(name) || auxiliary.includes(name)),
      [],
    );
    for (const outcome of [f, first, compacted, emptied]) {
      assert.deepEqual(outcome.errors, []);
    }
  },
);

nodeTest("an explicit host selection wins over a saved declaration on resume", async (t) => {
  const f = await fixture(t);
  f.session.setActiveToolsByName(["macuse"]);
  declare(f);
  const next = await fixture(
    t,
    { tools: ["macuse_reset"], sessionStartEvent: { type: "session_start", reason: "resume" } },
    f.sessionManager,
  );
  assert.deepEqual(next.session.getActiveToolNames(), ["macuse_reset"]);
  assert.deepEqual(next.errors, []);
});

nodeTest("exclusion-only resume keeps recorded entry-tool deselections", async (t) => {
  const f = await fixture(t);
  declare(f);
  f.session.setActiveToolsByName(["macuse"]);
  declare(f);
  const owned = new Set(
    f.session
      .getAllTools()
      .filter((tool) => tool.sourceInfo.source !== "builtin")
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
  nodeTest(
    `SDK post-bind selection replaces saved declaration: ${JSON.stringify(selected)}`,
    async (t) => {
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
    },
  );
}

nodeTest("SDK post-bind selection cannot bypass exclusions", async (t) => {
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

nodeTest(
  "native tree and reload boundaries stop the owned session without starting native services",
  async (t) => {
    const f = await fixture(t);
    declare(f);
    const selected = f.sessionManager.getLeafId();
    f.sessionManager.appendMessage({ role: "user", content: "Offline branch", timestamp: 1 });
    const createOwnedSession = async () => {
      const macuseTool = f.session.getToolDefinition("macuse");
      if (macuseTool === undefined) {
        assert.fail("macuse tool missing");
      }
      const result = await macuseTool.execute(
        "invalid",
        {},
        undefined,
        undefined,
        f.session.extensionRunner.createToolContext("owned-fixture", noSignal),
      );
      const details = isRecord(result.details) ? result.details : undefined;
      if (details === undefined) {
        assert.fail("missing macuse result details");
      }
      const dispatchMeta = isRecord(details.macuse) ? details.macuse : undefined;
      if (dispatchMeta === undefined) {
        assert.fail("missing macuse dispatch meta");
      }
      assert.equal(dispatchMeta.dispatched, false);
      const statusCommand = f.session.extensionRunner.getCommand("macuse-status");
      if (statusCommand === undefined) {
        assert.fail("macuse-status command missing");
      }
      const read = async () => {
        let text = "";
        // The handler only reads hasUI and ui.notify (extensions/macuse.ts).
        await statusCommand.handler(
          "",
          // The handler only reads hasUI and ui.notify (verified in extensions/macuse.ts);
          // the full host context type cannot be constructed offline.
          // oxlint-disable-next-line no-unsafe-type-assertion -- QX-007: Partial host context exercises the status handler.
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
    if (selected === null) {
      assert.fail("no leaf entry to navigate");
    }
    const treeStatus = await createOwnedSession();
    await f.session.navigateTree(selected);
    assert.match(await treeStatus(), /macuse is stopped/);
    const reloadStatus = await createOwnedSession();
    await f.session.reload();
    assert.match(await reloadStatus(), /macuse is stopped/);
    assert.deepEqual(f.errors, []);
  },
);
