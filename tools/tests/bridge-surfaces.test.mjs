import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { BridgeComputerUseSession, parseElementInfo, resolveElementTarget, updateElementCache, validateBridgeArguments, isolatedThreadConfig } from '../cu-helpers.mjs';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../codex-computer-use-appserver.mjs', import.meta.url));
const mcp = fileURLToPath(new URL('../codex-computer-use-appserver-mcp.mjs', import.meta.url));
const tree = (value = 'old', title = 'A.txt', extra = '') => `App=/Test.app (bundleID test.app, pid 4242)\nWindow: "${title}", App: Test.\n0 standard window ${title}, URL: file:///tmp/${title}\n 1 text field (settable) ID: editor, Value: ${value}\n 2 button Description: Toggle\n${extra}\n</app_state>`;
const result = text => ({ content: [{ type: 'text', text }] });
const noNative = () => ({ beginObservation: async () => null, inspectApp: async () => null, stop: async () => {} });

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'macuse-bridge-test-'));
  const log = join(dir, 'calls.jsonl');
  const preload = join(dir, 'mock-native.mjs');
  await writeFile(preload, `import { MacOSNative } from ${JSON.stringify(new URL('../macos-native.mjs', import.meta.url).href)};\nMacOSNative.prototype.beginObservation = async () => null;\nMacOSNative.prototype.inspectApp = async () => null;\nMacOSNative.prototype.stop = async () => {};\n`);
  const binary = join(dir, 'fake-codex.mjs');
  await writeFile(binary, `#!${process.execPath}
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
import { MCP_SERVERS } from ${JSON.stringify(new URL('../macuse-utils.mjs', import.meta.url).href)};
const log = value => appendFileSync(process.env.TEST_LOG, JSON.stringify({ pid: process.pid, at: Date.now(), ...value }) + '\\n');
log({ event: 'spawn', argv: process.argv.slice(2), home: process.env.CODEX_HOME });
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
let value = 'old';
const tree = () => 'App=/Test.app (bundleID test.app, pid 4242)\\nWindow: "A.txt", App: Test.\\n0 standard window A.txt, URL: file:///tmp/A.txt\\n1 text field (settable) ID: editor, Value: ' + value + '\\n2 text ' + 'x'.repeat(30000) + '\\n3 button Description: Tail Target, ID: tail\\n4 text FULL_RESULT_SENTINEL\\n</app_state>';
process.on('SIGTERM', () => { log({ event: 'term' }); setTimeout(() => { log({ event: 'exit' }); process.exit(0); }, 150); });
createInterface({ input: process.stdin }).on('line', line => {
  const msg = JSON.parse(line); log({ event: 'rpc', msg });
  if (!msg.method || msg.id === undefined) return;
  if (msg.method === 'initialize') send(msg.id, {});
  else if (msg.method === 'config/read') send(msg.id, { config: { mcp_servers: { unrelated: { command: 'must-not-start' } }, plugins: { inherited: { enabled: true } } } });
  else if (msg.method === 'thread/start') send(msg.id, { thread: { id: 'thread' } });
  else if (msg.method === 'mcpServerStatus/list') send(msg.id, { data: Object.entries(MCP_SERVERS).map(([name, server]) => ({ name, tools: Object.fromEntries(server.tools.map(tool => [tool, {}])) })) });
  else if (msg.method === 'mcpServer/tool/call') {
    const { tool, arguments: args } = msg.params;
    if (tool === 'press_key' && args.key === 'a') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 'approval', method: 'mcpServer/elicitation/request', params: { message: 'test approval' } }) + '\\n');
      return;
    }
    if (tool === 'set_value') value = args.value;
    send(msg.id, { content: [{ type: 'text', text: tree() }] });
  } else send(msg.id, {});
});
`, { mode: 0o755 });
  const env = { ...process.env, CODEX_BIN: binary, CODEX_HOME: join(dir, 'preserved-home'), TEST_LOG: log };
  return { dir, log, preload, binary, env, records: async () => (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse), cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test('helper parser preserves numeric continuation, exact values, and rejects duplicate IDs', () => {
  const text = 'App=test\n0 text field ID: same, Value:  leading \n123 KB\n1 pop up button Mode, ID: same\n</app_state>';
  const elements = parseElementInfo(text);
  assert.equal(elements.length, 2);
  assert.equal(elements[0].value, ' leading \n123 KB');
  assert.equal(elements[1].role, 'pop up button');
  const cache = new Map([['test', elements]]);
  assert.throws(() => resolveElementTarget({ app: 'test', elementId: 'same' }, cache), /Ambiguous/);
  updateElementCache(cache, 'test', 'App=test\nNo windows remain.');
  assert.deepEqual(cache.get('test'), []);
  assert.deepEqual(parseElementInfo('App=test\n1 '), []);
});

test('native isolation merges disables without replacing CODEX_HOME', () => {
  const config = isolatedThreadConfig({ config: { mcp_servers: { inherited: {} }, plugins: { other: {} } } }, { 'computer-use': { enabled: true } });
  assert.equal(config.features.apps, false);
  assert.deepEqual(config.mcp_servers.inherited, { enabled: false });
  assert.deepEqual(config.plugins.other, { enabled: false });
  assert.throws(() => isolatedThreadConfig({}, {}), /config\/read/);
});

test('whole argument shapes are validated before normalization', () => {
  for (const args of [null, [], 'text', { app: 'Test', key: 1 }, { app: 'Test', key: 'a', element_index: true }]) {
    assert.throws(() => validateBridgeArguments('press_key', args));
  }
});

test('document guard captures prior state before preflight refresh', async () => {
  const calls = [];
  const session = new BridgeComputerUseSession(async (tool) => { calls.push(tool); return result(tree('old', 'B.txt')); }, { native: noNative() });
  session.remember('Test', result(tree()));
  await assert.rejects(session.run('press_key', { app: 'Test', key: 'a' }), /document changed/);
  assert.deepEqual(calls, ['get_app_state']);
});

test('a new app alias cannot bypass the last observed document', async () => {
  const calls = [];
  const session = new BridgeComputerUseSession(async tool => { calls.push(tool); return result(tree('old', 'B.txt')); }, { native: noNative() });
  session.remember('test.app', result(tree()));
  await assert.rejects(session.run('set_value', { app: 'Test', elementId: 'editor', value: 'desired' }), /document changed/);
  assert.deepEqual(calls, ['get_app_state']);
});

test('path read headers and bundle action headers retain the same app identity', async () => {
  const replies = [tree(), tree().replace('/Test.app (bundleID test.app, pid 4242)', 'test.app (pid 4242)'), tree(), tree()];
  const session = new BridgeComputerUseSession(async () => result(replies.shift()), { native: noNative() });
  await session.run('select_text', { app: 'Test', elementId: 'editor', text: 'old' });
  await session.run('press_key', { app: 'Test', key: 'super+s' });
  assert.equal(replies.length, 0);
});

test('set_value verifies only the resolved field, not an unrelated matching value', async () => {
  let calls = 0;
  const session = new BridgeComputerUseSession(async () => result(++calls === 1 ? tree() : tree('old', 'A.txt', '5 text field ID: unrelated, Value: desired')), { native: noNative() });
  await assert.rejects(session.run('set_value', { app: 'Test', elementId: 'editor', value: 'desired' }), error => error.details.dispatched && /resolved field/.test(error.message));
  assert.equal(calls, 3);
});

test('set_value cannot verify the same field in another document', async () => {
  const replies = [tree(), 'Value set', tree('desired', 'B.txt')];
  const session = new BridgeComputerUseSession(async () => result(replies.shift()), { native: noNative() });
  await assert.rejects(session.run('set_value', { app: 'Test', elementId: 'editor', value: 'desired' }), error => error.details.dispatched && /readback belongs to a different document/.test(error.message));
});

test('Unicode uses native selection insertion; attempted/unverified edits never fall back', async () => {
  for (const status of ['applied', 'unverified', 'unsupported', 'exception']) {
    const calls = [];
    const native = { ...noNative(), inspectApp: async () => ({ pid: 4242, focusedWindow: { token: 'w', title: 'A.txt', document: 'file:///tmp/A.txt' }, focusedElement: { token: 'e', selectedTextSettable: true } }), replaceSelectedText: async args => {
      assert.equal(args.text, 'café 日本語 🧪');
      if (status === 'exception') throw new Error('Native edit timeout; outcome unknown');
      return { status, mutationAttempted: true, reason: 'unverified edit' };
    } };
    const session = new BridgeComputerUseSession(async tool => { calls.push(tool); return result(tree()); }, { native });
    const promise = session.run('type_text', { app: 'Test', text: 'café 日本語 🧪' });
    if (status === 'applied') assert.equal((await promise).outcome, 'verified');
    else await assert.rejects(promise, error => error.details.dispatched === true);
    assert.ok(calls.every(tool => tool === 'get_app_state'));
    assert.equal(calls.length, status === 'applied' ? 2 : 1);
  }
});

test('native edit timeout waits for owned helper stop before releasing the caller', async () => {
  let finishStop;
  let stopping;
  const stopStarted = new Promise(resolve => { stopping = resolve; });
  const native = {
    ...noNative(),
    inspectApp: async () => ({ pid: 4242, focusedWindow: { token: 'w', title: 'A.txt', document: 'file:///tmp/A.txt' }, focusedElement: { token: 'e', selectedTextSettable: true } }),
    replaceSelectedText: async () => { throw new Error('native timeout'); },
    stop: () => { stopping(); return new Promise(resolve => { finishStop = resolve; }); },
  };
  const session = new BridgeComputerUseSession(async () => result(tree()), { native });
  let settled = false;
  const run = session.run('type_text', { app: 'Test', text: '日本語' }).catch(error => { settled = true; return error; });
  await stopStarted;
  assert.equal(settled, false);
  finishStop();
  const error = await run;
  assert.equal(error.details.dispatched, true);
});

test('last-window close requires independent native zero-window proof and never reopens for readback', async () => {
  for (const count of [0, null, 1]) {
    const calls = [];
    const native = { ...noNative(), inspectApp: async () => ({ windowsCount: count }) };
    const session = new BridgeComputerUseSession(async tool => { calls.push(tool); return tool === 'get_app_state' ? result(tree()) : { ...result('noWindowsAvailable'), isError: true }; }, { native });
    const execution = await session.run('press_key', { app: 'Test', key: 'super+w' });
    assert.equal(Boolean(execution.result.isError), count !== 0);
    assert.deepEqual(calls, ['get_app_state', 'press_key']);
  }
});

test('requireStateChange rejects an unrelated clock and an idempotent set_value', async () => {
  for (const tool of ['perform_secondary_action', 'set_value']) {
    let count = 0;
    const session = new BridgeComputerUseSession(async () => result(tree('old', 'A.txt', `3 text clock ${++count}`)), { native: noNative() });
    const args = tool === 'set_value' ? { elementId: 'editor', value: 'old' } : { elementDescription: 'Toggle', action: 'Press' };
    await assert.rejects(session.run(tool, { app: 'Test', requireStateChange: true, ...args }), /no relevant target\/document change/);
  }
});

test('focus observes transient notifications but never promises isolation', async () => {
  const native = { ...noNative(), beginObservation: async () => ({ id: 'observe' }), endObservation: async () => ({ before: {}, after: {}, transitions: [{ kind: 'activation' }, { kind: 'activation' }], coverage: { applicationActivation: true, inputAttribution: false } }) };
  const session = new BridgeComputerUseSession(async () => result(tree()), { native });
  const execution = await session.run('get_app_state', { app: 'Test' });
  assert.equal(execution.focus.changed, true);
  assert.equal(execution.focus.observedChanges, 2);
  assert.equal(execution.focus.isolationGuaranteed, false);
});

test('native unsupported Unicode fails without keyboard dispatch', async () => {
  const calls = [];
  const session = new BridgeComputerUseSession(async tool => { calls.push(tool); return result(tree()); }, { native: noNative() });
  await assert.rejects(session.run('type_text', { app: 'Test', text: '日本語' }), error => error.details.dispatched === false);
  assert.deepEqual(calls, ['get_app_state']);
});

test('CLI validates the whole sequence before spawn and removes preserve-mouse', async () => {
  const f = await fixture();
  try {
    for (const bad of [[], null, 'bad', { app: 'Test', key: 4 }]) {
      await assert.rejects(exec(process.execPath, ['--import', f.preload, cli, 'sequence', '--steps-json', JSON.stringify([{ tool: 'get_app_state', arguments: { app: 'Test' } }, { tool: 'press_key', arguments: bad }])], { env: f.env }), error => error.code === 2);
    }
    await assert.rejects(exec(process.execPath, [cli, 'status', '--preserve-mouse'], { env: f.env }), error => error.code === 2);
    await assert.rejects(readFile(f.log), { code: 'ENOENT' });
  } finally { await f.cleanup(); }
});

test('CLI assertions and target cache consume full results before output cap; startup is isolated', async () => {
  const f = await fixture();
  try {
    const { stdout } = await exec(process.execPath, ['--import', f.preload, cli, 'sequence', '--quiet', '--allow-mutating', '--safety-note', 'Test fixture only; stop after one action.', '--max-text-chars', '80', '--steps-json', JSON.stringify([
      { tool: 'get_app_state', arguments: { app: 'Test' }, expectText: 'FULL_RESULT_SENTINEL' },
      { tool: 'perform_secondary_action', arguments: { app: 'Test', elementId: 'tail', action: 'Press' }, expectText: 'FULL_RESULT_SENTINEL' },
    ])], { env: f.env });
    const output = JSON.parse(stdout);
    assert.equal(output.ok, true);
    assert.equal(output.steps[1].arguments.element_index, '3');
    assert.ok(output.steps[0].result.content[0].text.length < 120);
    const records = await f.records();
    assert.deepEqual(records.filter(row => row.msg?.method).slice(0, 4).map(row => row.msg.method), ['initialize', 'initialized', 'config/read', 'thread/start']);
    const spawn = records.find(row => row.event === 'spawn');
    assert.deepEqual(spawn.argv.slice(0, 3), ['app-server', '--disable', 'apps']);
    assert.equal(spawn.home, f.env.CODEX_HOME);
    const config = records.find(row => row.msg?.method === 'thread/start').msg.params.config;
    assert.deepEqual(config.mcp_servers.unrelated, { enabled: false });
    assert.deepEqual(config.plugins.inherited, { enabled: false });
    await assert.rejects(exec(process.execPath, ['--import', f.preload, cli, 'sequence', '--quiet', '--max-text-chars', '80', '--steps-json', JSON.stringify([
      { tool: 'get_app_state', arguments: { app: 'Test' }, expectAbsentText: 'FULL_RESULT_SENTINEL' },
    ])], { env: f.env }), error => {
      const failure = JSON.parse(error.stdout);
      assert.equal(failure.ok, false);
      assert.match(failure.failed.message, /contained forbidden text/);
      return true;
    });
  } finally { await f.cleanup(); }
});

for (const mode of ['timeout', 'cancel']) test(`MCP ${mode} retains queue until transport exit, declines late approvals, and reports tool errors`, { timeout: 15000 }, async () => {
  const f = await fixture();
  const child = spawn(process.execPath, ['--import', f.preload, mcp], { env: { ...f.env, CODEX_CU_MCP_TIMEOUT_MS: mode === 'timeout' ? '70' : '3000', MACUSE_MCP_TEST_STOP_FORCE_MS: '500' }, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let nextId = 0;
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const send = value => child.stdin.write(JSON.stringify(value) + '\n');
  const call = (method, params) => new Promise(resolve => { const id = ++nextId; pending.set(id, resolve); send({ jsonrpc: '2.0', id, method, params }); });
  createInterface({ input: child.stdout }).on('line', line => {
    const msg = JSON.parse(line);
    if (msg.method === 'elicitation/create') {
      if (mode === 'cancel') setTimeout(() => send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 3 } }), 20);
      setTimeout(() => send({ jsonrpc: '2.0', id: msg.id, result: { action: 'accept', content: {} } }), 110);
    }
    else if (pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  });
  try {
    await call('initialize', { capabilities: { elicitation: {} } });
    const bad = await call('tools/call', { name: 'press_key', arguments: [] });
    assert.equal(bad.result.isError, true);
    const args = { app: 'Test', allowMutating: true, safetyNote: 'Test fixture only; stop after one action.', approval: 'ask' };
    const first = call('tools/call', { name: 'press_key', arguments: { ...args, key: 'a' } });
    const second = call('tools/call', { name: 'press_key', arguments: { ...args, key: 'b' } });
    const [one, two] = await Promise.all([first, second]);
    assert.equal(one.result.isError, true, stderr);
    assert.equal(one.result._meta.macuse.dispatched, true);
    assert.match(one.result.content[0].text, mode === 'timeout' ? /timed out/ : /exited|cancelled/);
    assert.notEqual(two.result.isError, true, stderr);
    const records = await f.records();
    const firstAction = records.find(row => row.msg?.params?.arguments?.key === 'a');
    const oldExit = records.find(row => row.pid === firstAction.pid && row.event === 'exit');
    const nextAction = records.find(row => row.msg?.params?.arguments?.key === 'b');
    assert.ok(oldExit && nextAction && oldExit.at <= nextAction.at);
    assert.notEqual(firstAction.pid, nextAction.pid);
    assert.ok(!records.some(row => row.msg?.result?.action === 'accept'));
    assert.ok(records.every(row => !/cancel/i.test(row.msg?.method ?? '')));
    for (const row of records.filter(row => row.msg?.method === 'thread/start')) {
      assert.deepEqual(records.filter(item => item.pid === row.pid && item.msg?.method).slice(0, 4).map(item => item.msg.method), ['initialize', 'initialized', 'config/read', 'thread/start']);
      assert.deepEqual(row.msg.params.config.plugins.inherited, { enabled: false });
      assert.deepEqual(row.msg.params.config.mcp_servers.unrelated, { enabled: false });
    }
  } finally {
    child.stdin.end();
    await new Promise(resolve => child.once('exit', resolve));
    await f.cleanup();
  }
});
