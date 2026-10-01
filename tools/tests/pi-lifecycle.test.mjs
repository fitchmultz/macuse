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
const load = file => import(pathToFileURL(join(root, 'dist/core', file)).href);
const { createAgentSession } = await load('sdk.js');
const { DefaultResourceLoader } = await load('resource-loader.js');
const { SettingsManager } = await load('settings-manager.js');
const { SessionManager } = await load('session-manager.js');
const { ModelRuntime } = await load('model-runtime.js');
const hostVersion = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;

async function fixture(t, options = {}, manager) {
  const dir = await mkdtemp(join(tmpdir(), 'macuse-lifecycle-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { settings = {}, ...sessionOptions } = options;
  await writeFile(join(dir, 'settings.json'), JSON.stringify(settings));
  const settingsManager = SettingsManager.create(dir, dir);
  const resourceLoader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    additionalExtensionPaths: [fileURLToPath(new URL('../../extensions/macuse.ts', import.meta.url))],
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

test('native defaults can select auxiliary tools at startup without activating their siblings', async t => {
  const f = await fixture(t, { settings: { defaultTools: ['+computer_history_status'] } });
  assert.ok(f.session.getActiveToolNames().includes('computer_history_status'));
  assert.ok(!f.session.getActiveToolNames().includes('computer_history_resume'));
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
  assert.deepEqual(f.session.getActiveToolNames().sort(), ['macuse_tools', 'computer_history_status', 'macuse_reset', 'grep'].sort());
  // No request/declaration occurs between these live selection changes and reload.
  f.session.setActiveToolsByName(['macuse_tools', 'grep']);
  await f.session.reload();
  assert.deepEqual(f.session.getActiveToolNames().sort(), ['grep', 'macuse_tools']);
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
  assert.deepEqual(f.session.getActiveToolNames(), ['macuse_tools']);
  await f.session.navigateTree(selected);
  assert.deepEqual(f.session.getActiveToolNames().sort(), ['computer_history_status', 'macuse_tools']);
  f.sessionManager.appendCompaction('Offline summary', null, 100);
  await f.session.reload();
  assert.deepEqual(f.session.getActiveToolNames().sort(), ['computer_history_status', 'macuse_tools']);
  f.session.setActiveToolsByName([]);
  f.sessionManager.appendMessage({ role: 'system', content: '', toolsRemoved: [{ name: 'macuse_tools' }, { name: 'computer_history_status' }], timestamp: 2 });
  await f.session.reload();
  assert.deepEqual(f.session.getActiveToolNames().filter(name => name.startsWith('macuse') || name === 'computer_history_status'), []);
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
  const owned = new Set(f.session.getAllTools().filter(tool => tool.sourceInfo.source !== 'builtin').map(tool => tool.name));
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
