import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { findPackageJSON } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const originalFetch = globalThis.fetch;
test.before(() => { globalThis.fetch = async () => { throw new Error('Unexpected network in offline lifecycle test'); }; });
test.after(() => { globalThis.fetch = originalFetch; });

// Exercise either installed host's real SDK without credentials, providers or desktop calls.
const root = process.env.MACUSE_TEST_PI_ROOT ?? dirname(findPackageJSON('@earendil-works/pi-coding-agent', import.meta.url));
process.env.PI_PACKAGE_DIR = root;
const load = file => import(pathToFileURL(join(root, 'dist/core', file)).href);
const { createAgentSession } = await load('sdk.js');
const { DefaultResourceLoader } = await load('resource-loader.js');
const { SettingsManager } = await load('settings-manager.js');
const { SessionManager } = await load('session-manager.js');
const { ModelRuntime } = await load('model-runtime.js');
const { instructionGroupsExtension } = await import(pathToFileURL(join(root, 'dist/index.js')).href);
const ai = dirname(findPackageJSON('@earendil-works/pi-ai', pathToFileURL(join(root, 'package.json')).href));
const { fauxAssistantMessage } = await import(pathToFileURL(join(ai, 'dist/index.js')).href);
const hostVersion = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
const entries = ['macuse', 'macuse_insert_text', 'macuse_reset', 'macuse_tools'];

async function fixture(t, options = {}, manager) {
  const dir = await mkdtemp(join(tmpdir(), 'macuse-lifecycle-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { settings = {}, installed = true, discovery = false, extensionFactories = [], ...sessionOptions } = options;
  await writeFile(join(dir, 'settings.json'), JSON.stringify(settings));
  const settingsManager = SettingsManager.create(dir, dir);
  const resourceLoader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager,
    noExtensions: installed, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    additionalExtensionPaths: installed ? [fileURLToPath(new URL('../../extensions/macuse.ts', import.meta.url))] : [],
    extensionFactories: [...(discovery && instructionGroupsExtension ? [instructionGroupsExtension] : []), ...extensionFactories],
  });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  const modelRuntime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models'), refreshOnCreate: false });
  const sessionManager = manager ?? SessionManager.inMemory(dir);
  const { session } = await createAgentSession({ cwd: dir, agentDir: dir, settingsManager, resourceLoader, modelRuntime, sessionManager,
    model: modelRuntime.getModels()[0], ...sessionOptions });
  t.after(() => session.dispose());
  const errors = [];
  await session.bindExtensions({ onError: error => errors.push(error) });
  return { session, sessionManager, errors, dir };
}

function declare(f) {
  const names = f.session.getActiveToolNames();
  f.sessionManager.appendMessage({ role: 'system', content: '', timestamp: 0,
    toolsAdded: names.map(name => { const tool = f.session.getToolDefinition(name); return { name, description: tool.description, parameters: tool.parameters }; }) });
}

async function callTool(f, name, args = {}) {
  const id = `fixture-${f.sessionManager.getEntries().length}`;
  f.sessionManager.appendMessage(fauxAssistantMessage([{ type: 'toolCall', id, name, arguments: args }], { stopReason: 'toolUse' }));
  f.session.refreshContext();
  return f.session.extensionRunner.createToolContext(id, undefined).executeTool(name, args);
}

test('native defaults can select auxiliary tools at startup without activating their siblings', async t => {
  const f = await fixture(t, { settings: { defaultTools: ['+computer_history_status'] } });
  assert.ok(f.session.getActiveToolNames().includes('computer_history_status'));
  assert.ok(!f.session.getActiveToolNames().includes('computer_history_resume'));
  assert.deepEqual(f.errors, []);
});

test('first installation on reload activates defaults without resurrecting later live deselections', async t => {
  const settings = { extensions: ['-builtin:mcp', '-builtin:llama.cpp', '-builtin:codemode', '-builtin:tool-search'] };
  const f = await fixture(t, { installed: false, settings });
  declare(f);
  settings.extensions.push(fileURLToPath(new URL('../../extensions/macuse.ts', import.meta.url)));
  await writeFile(join(f.dir, 'settings.json'), JSON.stringify(settings));
  await f.session.reload();
  assert.deepEqual(f.session.getActiveToolNames().filter(name => entries.includes(name)).sort(),
    ['macuse', 'macuse_insert_text', 'macuse_reset', 'macuse_tools']);
  assert.ok(!f.session.getActiveToolNames().includes('computer_history_status'));
  f.session.setActiveToolsByName([]);
  await f.session.reload();
  assert.deepEqual(f.session.getActiveToolNames().filter(name => name !== 'macuse_enable'), []);
  assert.deepEqual(f.errors, []);
});

for (const boundary of ['resume', 'fork']) test(`first installation on ${boundary} ignores unrelated saved tool declarations`, async t => {
  const f = await fixture(t, { installed: false });
  declare(f);
  const next = await fixture(t, { discovery: true, sessionStartEvent: { type: 'session_start', reason: boundary } }, f.sessionManager);
  assert.deepEqual(next.session.getActiveToolNames().filter(name => entries.includes(name)).sort(),
    ['macuse', 'macuse_insert_text', 'macuse_reset', 'macuse_tools']);
  assert.ok(!next.session.getActiveToolNames().includes('computer_history_status'));
  if (instructionGroupsExtension) {
    const discover = () => next.session.getToolDefinition('discover_tools');
    const context = () => next.session.extensionRunner.createContext();
    assert.match((await discover().execute('list', {}, undefined, undefined, context())).content[0].text, /macos:/);
    await next.session.extensionRunner.emitBeforeAgentStart('Offline discovery', undefined, {
      cwd: next.dir, selectedTools: next.session.getActiveToolNames(),
    });
    assert.ok(!next.session.getActiveToolNames().includes('macuse'));
    await next.session.reload();
    const result = await discover().execute('enable', { enable: ['macos'] }, undefined, undefined, context());
    assert.match(result.content[0].text, /allowMutating:true/);
    assert.ok(next.session.getActiveToolNames().includes('macuse'));
    assert.ok(!next.session.getActiveToolNames().includes('computer_history_status'));
  } else {
    const start = await next.session.extensionRunner.emitBeforeAgentStart('Offline discovery', undefined, {
      cwd: next.dir, selectedTools: next.session.getActiveToolNames(),
    });
    assert.match(start.systemPromptOptions.sections.macos, /allowMutating:true/);
    assert.match(start.systemPromptOptions.sections.macos, /allowPrivacyChange:true/);
  }
  next.session.setActiveToolsByName([]);
  declare(next);
  await next.session.reload();
  assert.deepEqual(next.session.getActiveToolNames().filter(name => entries.includes(name)), []);
  const resumed = await fixture(t, { discovery: true, sessionStartEvent: { type: 'session_start', reason: 'resume' } }, f.sessionManager);
  assert.deepEqual(resumed.session.getActiveToolNames().filter(name => entries.includes(name)), []);
  assert.deepEqual(resumed.errors, []);
  assert.deepEqual(next.errors, []);
});

for (const frontDoor of ['command', 'tool']) for (const [policy, permitted] of [
  [{}, entries],
  [{ excludeTools: ['macuse_reset'] }, ['macuse', 'macuse_insert_text', 'macuse_tools']],
  [{ tools: ['read', 'macuse_tools', 'macuse_enable'] }, ['macuse_tools']],
  [{ excludeTools: ['macuse_enable'] }, entries],
  [{ noTools: 'all' }, []],
]) test(`explicit ${frontDoor} recovery repairs marker-only selection within policy ${JSON.stringify(policy)}`, async t => {
  const old = await fixture(t, { installed: false });
  declare(old);
  old.sessionManager.appendCustomEntry('macuse-initialized', {});
  const f = await fixture(t, { ...policy, discovery: true, sessionStartEvent: { type: 'session_start', reason: 'resume' } }, old.sessionManager);
  assert.deepEqual(f.session.getActiveToolNames().filter(name => entries.includes(name)), []);
  await f.session.reload();
  await f.session.extensionRunner.emitBeforeAgentStart('Offline explicit recovery', undefined, { cwd: f.dir, selectedTools: f.session.getActiveToolNames() });
  const before = f.session.getActiveToolNames();
  assert.deepEqual(before.filter(name => entries.includes(name)), policy.tools ? permitted : [], 'Only explicit policy may select entries before recovery');
  if (frontDoor === 'tool' && !f.session.getToolDefinition('macuse_enable')) {
    assert.equal((await callTool(f, 'macuse_enable')).isError, true);
    assert.deepEqual(f.session.getActiveToolNames(), before);
    assert.deepEqual(f.errors, []);
    return;
  }
  if (frontDoor === 'tool' && !Object.keys(policy).length) {
    assert.ok(before.includes('macuse_enable'), 'The ungrouped recovery default must be available on old-marker reload');
    assert.equal((await callTool(f, 'macuse_enable', { unexpected: true })).isError, true);
    assert.deepEqual(f.session.getActiveToolNames(), before);
  }
  const enable = async () => {
    if (frontDoor === 'command') {
      await f.session.prompt('/macuse-enable');
      return f.session.messages.findLast(message => message.role === 'custom' && message.customType === 'macuse-enable');
    }
    const outcome = await callTool(f, 'macuse_enable');
    assert.equal(outcome.isError, false, JSON.stringify(outcome.result));
    return outcome.result;
  };
  const result = await enable();
  assert.deepEqual(f.session.getActiveToolNames().filter(name => entries.includes(name)), permitted);
  assert.deepEqual(f.session.getActiveToolNames().filter(name => !entries.includes(name)), before.filter(name => !entries.includes(name)));
  assert.deepEqual(f.session.getActiveToolNames().filter(name => /^(event_stream|computer_history)_/.test(name)), []);
  assert.deepEqual(result.details.added, permitted.filter(name => !before.includes(name)));
  assert.deepEqual(result.details.alreadyActive, permitted.filter(name => before.includes(name)));
  assert.deepEqual(result.details.unavailable, entries.filter(name => !permitted.includes(name)));
  const repeat = await enable();
  assert.deepEqual(repeat.details.added, []);
  assert.deepEqual(repeat.details.alreadyActive, permitted);
  let status;
  await f.session.extensionRunner.getCommand('macuse-status').handler('', { hasUI: true, ui: { notify: text => { status = text; } } });
  assert.match(status, /macuse is stopped/);
  assert.deepEqual(f.errors, []);
});

test('model recovery preserves another suppressed group and retains the macos instruction gate', async t => {
  const f = await fixture(t, { discovery: true, extensionFactories: [pi => {
    pi.events.on('pi:instruction-groups', collector => collector.register({
      name: 'filesystem', description: 'Synthetic read instruction owner', tools: ['read'],
      instructions: () => 'Synthetic read instructions: inspect only the approved fixture.',
    }));
  }] });
  await f.session.extensionRunner.emitBeforeAgentStart('Offline group recovery', undefined, { cwd: f.dir, selectedTools: f.session.getActiveToolNames() });
  const before = f.session.getActiveToolNames();
  assert.equal((await callTool(f, 'macuse_enable')).isError, false);
  assert.deepEqual(f.session.getActiveToolNames().filter(name => !entries.includes(name)), before.filter(name => !entries.includes(name)));
  if (instructionGroupsExtension) {
    const discover = f.session.getToolDefinition('discover_tools');
    const ctx = f.session.extensionRunner.createContext();
    assert.match((await discover.execute('list', {}, undefined, undefined, ctx)).content[0].text, /filesystem:/);
    const result = await discover.execute('enable', { enable: ['macos'] }, undefined, undefined, ctx);
    f.sessionManager.appendMessage(fauxAssistantMessage([{ type: 'toolCall', id: 'discovery', name: 'discover_tools', arguments: { enable: ['macos'] } }], { stopReason: 'toolUse' }));
    f.session.refreshContext();
    const toolContext = f.session.extensionRunner.createToolContext('discovery', undefined);
    const blocked = await toolContext.executeTool('macuse_reset', {});
    assert.equal(blocked.isError, true);
    assert.match(blocked.result.content[0].text, /Read discover_tools instructions/);
    f.sessionManager.appendMessage({ role: 'toolResult', toolCallId: 'discovery', toolName: 'discover_tools', content: result.content, details: result.details, isError: false, timestamp: 1 });
    f.session.refreshContext();
    await f.session.extensionRunner.emit({ type: 'turn_start', turnIndex: 1, timestamp: 2 });
    await f.session.extensionRunner.emitContext(f.sessionManager.buildSessionContext().messages);
    assert.equal((await toolContext.executeTool('macuse_reset', {})).isError, false, 'Next-turn native tool call must pass the instruction gate');
    await discover.execute('enable-other', { enable: ['filesystem'] }, undefined, undefined, ctx);
    assert.ok(f.session.getActiveToolNames().includes('read'), 'Other group selection must remain recoverable');
  }
  assert.deepEqual(f.errors, []);
});

test('reload preserves newly added host defaults, live deselections and exclusions', async t => {
  if (hostVersion === '0.99.1') return t.skip('This qualified fork predates native defaultTools additions on reload');
  const f = await fixture(t, { excludeTools: ['computer_history_resume'] });
  f.session.setActiveToolsByName(['macuse_tools']);
  declare(f);
  await writeFile(join(f.dir, 'settings.json'), JSON.stringify({
    defaultTools: ['+computer_history_status', '+computer_history_resume', '+macuse_reset', '+grep'],
  }));
  await f.session.reload();
  assert.deepEqual(f.session.getActiveToolNames().filter(name => name !== 'macuse_enable').sort(), ['macuse_tools', 'computer_history_status', 'macuse_reset', 'grep'].sort());
  // No request/declaration occurs between these live selection changes and reload.
  f.session.setActiveToolsByName(['macuse_tools', 'grep']);
  await f.session.reload();
  assert.deepEqual(f.session.getActiveToolNames().filter(name => name !== 'macuse_enable').sort(), ['grep', 'macuse_tools']);
  assert.deepEqual(f.errors, []);
});

for (const boundary of ['reload', 'resume', 'fork']) test(`native SDK preserves loader-selected auxiliary through ${boundary}`, async t => {
  const f = await fixture(t);
  assert.ok(!f.session.getActiveToolNames().includes('computer_history_status'));
  const loader = f.session.getToolDefinition('macuse_tools');
  await loader.execute('load', { tools: ['computer_history_status'] });
  const expected = f.session.getActiveToolNames();
  declare(f);
  if (boundary === 'reload') {
    await f.session.reload();
    assert.deepEqual(f.session.getActiveToolNames().sort(), expected.sort());
    assert.deepEqual(f.errors, []);
  } else {
    const next = await fixture(t, { sessionStartEvent: { type: 'session_start', reason: boundary } }, f.sessionManager);
    assert.deepEqual(next.session.getActiveToolNames().sort(), expected.sort());
    assert.deepEqual(next.errors, []);
  }
});

for (const options of [
  { tools: ['computer_history_status'] },
  { excludeTools: ['macuse_tools'] },
  { tools: [] },
  { noTools: 'all' },
]) test(`native SDK respects tool policy ${JSON.stringify(options)}`, async t => {
  const f = await fixture(t, options);
  const before = f.session.getActiveToolNames();
  if (options.excludeTools) assert.ok(before.includes('computer_history_status'), 'loader exclusion must not strand auxiliary tools');
  else assert.deepEqual(before, options.tools ?? []);
  declare(f);
  await f.session.reload();
  assert.deepEqual(f.session.getActiveToolNames().sort(), before.sort());
  assert.deepEqual(f.errors, []);
});

test('native projection respects removed tools, empty selection, branches and compaction', async t => {
  const f = await fixture(t);
  f.session.setActiveToolsByName(['macuse_tools', 'computer_history_status']);
  declare(f);
  const selected = f.sessionManager.getLeafId();
  f.session.setActiveToolsByName(['macuse_tools']);
  f.sessionManager.appendMessage({ role: 'system', content: '', toolsRemoved: [{ name: 'computer_history_status' }], timestamp: 1 });
  await f.session.reload();
  assert.deepEqual(f.session.getActiveToolNames().filter(name => name !== 'macuse_enable'), ['macuse_tools']);
  await f.session.navigateTree(selected);
  assert.deepEqual(f.session.getActiveToolNames().sort(), ['computer_history_status', 'macuse_tools']);
  f.sessionManager.appendCompaction('Offline summary', null, 100);
  await f.session.reload();
  assert.deepEqual(f.session.getActiveToolNames().filter(name => name !== 'macuse_enable').sort(), ['computer_history_status', 'macuse_tools']);
  f.session.setActiveToolsByName([]);
  f.sessionManager.appendMessage({ role: 'system', content: '', toolsRemoved: [{ name: 'macuse_tools' }, { name: 'computer_history_status' }], timestamp: 2 });
  await f.session.reload();
  assert.deepEqual(f.session.getActiveToolNames().filter(name => entries.includes(name) || name === 'computer_history_status'), []);
  assert.deepEqual(f.errors, []);
});

test('saved selection never bypasses a new host exclusion', async t => {
  const f = await fixture(t);
  f.session.setActiveToolsByName(['macuse_tools', 'computer_history_status']);
  declare(f);
  const next = await fixture(t, { excludeTools: ['computer_history_status'], sessionStartEvent: { type: 'session_start', reason: 'resume' } }, f.sessionManager);
  assert.ok(!next.session.getActiveToolNames().includes('computer_history_status'));
  const result = await next.session.getToolDefinition('macuse_tools').execute('load', { tools: ['computer_history_status'] });
  assert.deepEqual(result.details.unavailable, ['computer_history_status']);
  assert.deepEqual(next.errors, []);
});

test('explicit CLI selection wins over a saved declaration on resume', async t => {
  const f = await fixture(t);
  f.session.setActiveToolsByName(['macuse']);
  declare(f);
  const argv = process.argv;
  try {
    for (const args of [
      ['--tools', 'macuse_reset'], ['-t', 'macuse_reset'], ['--tools=macuse_reset'],
      ['--', '--tools', 'macuse_reset'],
    ]) {
      process.argv = [...argv.slice(0, 2), ...args];
      const next = await fixture(t, { tools: ['macuse_reset'], sessionStartEvent: { type: 'session_start', reason: 'resume' } }, f.sessionManager);
      assert.deepEqual(next.session.getActiveToolNames(), args[0] === '--' ? [] : ['macuse_reset']);
      assert.deepEqual(next.errors, []);
    }
  } finally {
    process.argv = argv;
  }
});

test('exclusion-only resume does not resurrect deselected auxiliary tools', async t => {
  const f = await fixture(t);
  f.session.setActiveToolsByName(['macuse']);
  declare(f);
  const owned = new Set(f.session.getAllTools().filter(tool => tool.sourceInfo.source !== 'builtin' && tool.name !== 'macuse_enable').map(tool => tool.name));
  const next = await fixture(t, { excludeTools: ['computer_history_status'], sessionStartEvent: { type: 'session_start', reason: 'resume' } }, f.sessionManager);
  assert.deepEqual(next.session.getActiveToolNames().filter(name => owned.has(name)), ['macuse']);
  assert.deepEqual(next.errors, []);
});

for (const selected of [['macuse_reset'], ['macuse', 'computer_history_status'], []]) {
  test(`SDK post-bind selection replaces saved declaration: ${JSON.stringify(selected)}`, async t => {
    const f = await fixture(t);
    f.session.setActiveToolsByName(['macuse']);
    declare(f);
    const next = await fixture(t, { tools: selected, sessionStartEvent: { type: 'session_start', reason: 'resume' } }, f.sessionManager);
    next.session.setActiveToolsByName(selected);
    assert.deepEqual(next.session.getActiveToolNames(), selected);
    assert.deepEqual(next.errors, []);
  });
}

test('SDK post-bind selection cannot bypass exclusions', async t => {
  const f = await fixture(t);
  f.session.setActiveToolsByName(['macuse']);
  declare(f);
  const next = await fixture(t, { excludeTools: ['computer_history_status'], sessionStartEvent: { type: 'session_start', reason: 'resume' } }, f.sessionManager);
  next.session.setActiveToolsByName(['macuse', 'computer_history_status']);
  assert.deepEqual(next.session.getActiveToolNames(), ['macuse']);
  assert.deepEqual(next.errors, []);
});

test('native tree and reload boundaries stop the owned session without starting native services', async t => {
  const f = await fixture(t);
  declare(f);
  const selected = f.sessionManager.getLeafId();
  f.sessionManager.appendMessage({ role: 'user', content: 'Offline branch', timestamp: 1 });
  const createOwnedSession = async () => {
    const result = await f.session.getToolDefinition('macuse').execute('invalid', {}, undefined, undefined, f.session.extensionRunner.createContext());
    assert.equal(result.details.macuse.dispatched, false);
    const status = f.session.extensionRunner.getCommand('macuse-status');
    const read = async () => {
      let text;
      await status.handler('', { hasUI: true, ui: { notify: value => { text = value; } } });
      return text;
    };
    assert.ok((await read()).startsWith('{'), 'A refused call still creates an owned, unstarted session');
    return read;
  };
  const treeStatus = await createOwnedSession();
  await f.session.navigateTree(selected);
  assert.match(await treeStatus(), /macuse is stopped/);
  const reloadStatus = await createOwnedSession();
  await f.session.reload();
  assert.match(await reloadStatus(), /macuse is stopped/);
  assert.deepEqual(f.errors, []);
});
