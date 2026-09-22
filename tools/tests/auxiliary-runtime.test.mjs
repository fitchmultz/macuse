import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { AuxiliaryRuntime, auxiliaryTools, validateAuxiliaryArguments } from '../../lib/auxiliary-runtime.mjs';

const names = ['event_stream_start', 'event_stream_status', 'event_stream_stop', 'computer_history_pause', 'computer_history_resume', 'computer_history_status', 'computer_history_get_settings', 'computer_history_update_settings'];
const recording = { allowRecording: true, safetyNote: 'The user requested this recording.' };
const observation = () => ({ defaultApplicationBehavior: 'do_not_observe', defaultURLBehavior: 'observe', allowlist: [{ scope: 'app', bundleID: 'test.app' }], blocklist: [{ scope: 'url', urlDomain: 'private.example' }] });
const privacy = () => ({ allowPrivacyChange: true, safetyNote: 'The user approved this exact change; other freshly read fields are preserved.', observation: observation() });
const success = { content: [{ type: 'text', text: 'ok' }], isError: false };
const meta = result => result.details.macuse;

async function until(predicate, label) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `Timed out waiting for ${label}`);
    await delay(5);
  }
}

function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'macuse-auxiliary-test-'));
  const log = join(dir, 'rpc.jsonl');
  const binary = join(dir, 'codex.cjs');
  const release = join(dir, 'release');
  writeFileSync(log, '');
  writeFileSync(binary, `#!${process.execPath}
const { appendFileSync, readFileSync, existsSync } = require('node:fs');
const { createInterface } = require('node:readline');
const log = ${JSON.stringify(log)};
const release = ${JSON.stringify(release)};
const options = ${JSON.stringify(options)};
const names = ${JSON.stringify(names)};
const success = ${JSON.stringify(success)};
const record = data => appendFileSync(log, JSON.stringify({ pid: process.pid, ...data }) + '\\n');
const send = message => process.stdout.write(JSON.stringify(message) + '\\n');
const reply = (id, result) => send({ id, result });
let held;
let heldTimer;
let finishing = false;
record({ event: 'spawn', argv: process.argv.slice(2), home: process.env.CODEX_HOME ?? null });
const input = createInterface({ input: process.stdin });
input.on('line', line => {
  const m = JSON.parse(line);
  record({ event: 'rpc', ...m });
  if (!m.method || m.id === undefined || m.method === options.holdStage) return;
  if (m.method === 'initialize') reply(m.id, {});
  else if (m.method === 'config/read') reply(m.id, options.badConfig ? {} : { config: { mcp_servers: { unrelated: { enabled: true }, 'computer-use': { enabled: true }, 'event-stream': { enabled: false, command: 'must-be-overridden' } }, plugins: { unrelated: { enabled: true } } } });
  else if (m.method === 'thread/start') reply(m.id, { thread: { id: 'fixture-thread' } });
  else if (m.method === 'mcpServerStatus/list') {
    const name = m.params.cursor ? 'computer-history' : 'event-stream';
    const tools = Object.fromEntries(names.filter(tool => tool.startsWith(name === 'event-stream' ? 'event_stream_' : 'computer_history_')).map(tool => [tool, {}]));
    reply(m.id, { data: options.missingInventory ? [] : [{ name, tools }], nextCursor: name === 'event-stream' ? 'history-page' : null });
  } else if (m.method === 'mcpServer/tool/call') {
    const calls = readFileSync(log, 'utf8').trim().split('\\n').map(JSON.parse).filter(row => row.event === 'tool').length;
    record({ event: 'tool', params: m.params });
    const action = options.responses?.[calls] ?? success;
    if (action === 'exit') process.exit(7);
    else if (action === 'hold') {
      held = m;
      heldTimer = setInterval(() => {
        if (existsSync(release)) { clearInterval(heldTimer); held = null; reply(m.id, success); }
      }, 5);
    } else if (action === 'elicit') {
      held = m;
      send({ id: 'approval', method: 'mcpServer/elicitation/request', params: {} });
    } else if (action.rpcError) send({ id: m.id, error: { code: -32000, message: action.rpcError } });
    else reply(m.id, action);
  }
});
input.on('line', line => {
  const m = JSON.parse(line);
  if (m.id === 'approval' && m.result && held) { reply(held.id, success); held = null; }
});
const finish = event => {
  record({ event });
  if (options.ignoreStop) return;
  if (finishing) return;
  finishing = true;
  clearInterval(heldTimer);
  if (held && options.lateReply) {
    send({ id: 'late-approval', method: 'mcpServer/elicitation/request', params: {} });
    reply(held.id, success);
  }
  setTimeout(() => { record({ event: 'exit' }); process.exit(0); }, options.exitDelay ?? 0);
};
input.on('close', () => finish('eof'));
process.on('SIGTERM', () => finish('term'));
if (options.ignoreStop) setInterval(() => {}, 60000);
`);
  chmodSync(binary, 0o755);
  const runtime = new AuxiliaryRuntime({ cwd: dir, codexBin: binary });
  t.after(async () => { await runtime.stop(); rmSync(dir, { recursive: true, force: true }); });
  const events = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  const calls = () => events().filter(row => row.event === 'tool');
  return { runtime, events, calls, release: () => writeFileSync(release, '') };
}

test('exports exactly eight guarded auxiliary tools; invalid calls never start a process', async () => {
  const runtime = new AuxiliaryRuntime({ codexBin: '/must/not/start' });
  assert.deepEqual(auxiliaryTools.map(tool => tool.name), names);
  assert.deepEqual(auxiliaryTools.filter(tool => tool.annotations.readOnlyHint).map(tool => tool.name), ['event_stream_status', 'computer_history_status', 'computer_history_get_settings']);
  assert.equal(runtime.status().running, false);
  for (const [tool, input] of [
    ['list_apps', {}], ['get_app_state', {}], ['event_stream_start', {}], ['computer_history_resume', { allowRecording: true, safetyNote: ' ' }],
    ['event_stream_start', { allowRecording: 'true', safetyNote: 'requested' }], ['event_stream_stop', { unexpected: true }],
    ['computer_history_update_settings', { observation: observation() }], ['computer_history_status', null], ['computer_history_status', []],
  ]) {
    const result = await runtime.callTool(tool, input);
    assert.equal(result.isError, true);
    assert.equal(meta(result).dispatched, false);
    assert.equal(meta(result).outcome, 'not_dispatched');
    assert.equal(meta(result).attempts, 0);
  }
  for (const timeoutMs of [0, -1, Infinity, NaN, '100', 2_147_483_648]) assert.equal((await runtime.callTool('event_stream_status', {}, { timeoutMs })).isError, true);
  const controller = new AbortController();
  controller.abort();
  assert.equal(meta(await runtime.callTool('event_stream_status', {}, { signal: controller.signal })).reason, 'aborted');
  assert.equal(runtime.status().running, false);
  await runtime.stop();
});

test('settings validation requires complete scoped entries and snapshots only observation', () => {
  const input = privacy();
  const copied = validateAuxiliaryArguments('computer_history_update_settings', input);
  assert.deepEqual(copied, { observation: input.observation });
  input.observation.allowlist[0].bundleID = 'changed';
  assert.equal(copied.observation.allowlist[0].bundleID, 'test.app');
  for (const field of Object.keys(observation())) {
    const partial = privacy();
    delete partial.observation[field];
    assert.throws(() => validateAuxiliaryArguments('computer_history_update_settings', partial));
  }
  for (const entry of [null, [], Object.create({ scope: 'app', bundleID: 'test.app' }), Object.create({ scope: 'url', urlDomain: 'example.com' }), { scope: 'other' }, { scope: 'app' }, { scope: 'app', bundleID: ' ' }, { scope: 'url' },
    ...['', 'https://example.com', 'example.com/path', 'example.com?x', 'example.com#x', 'example.com\\path', 'example .com'].map(urlDomain => ({ scope: 'url', urlDomain })),
    { scope: 'app', bundleID: 'test', extra: true }, { scope: 'url', urlDomain: 'example.com', bundleID: 4 },
  ]) assert.throws(() => validateAuxiliaryArguments('computer_history_update_settings', { ...privacy(), observation: { ...observation(), allowlist: [entry] } }));
  assert.throws(() => validateAuxiliaryArguments('computer_history_update_settings', { ...privacy(), observation: { ...observation(), extra: true } }));
  assert.throws(() => validateAuxiliaryArguments('computer_history_update_settings', { ...privacy(), observation: { ...observation(), blocklist: {} } }));
  assert.throws(() => validateAuxiliaryArguments('computer_history_update_settings', { ...privacy(), observation: { ...observation(), blocklist: new Array(1) } }));
  assert.throws(() => validateAuxiliaryArguments('event_stream_start', Object.create(recording)));
  assert.throws(() => validateAuxiliaryArguments('computer_history_update_settings', { ...privacy(), observation: Object.create(observation()) }));
  assert.deepEqual(validateAuxiliaryArguments('event_stream_start', recording), {});
  assert.deepEqual(validateAuxiliaryArguments('computer_history_resume', recording), {});
  assert.deepEqual(validateAuxiliaryArguments('event_stream_stop'), {});
  assert.deepEqual(validateAuxiliaryArguments('computer_history_pause'), {});
});

test('lazy authenticated JSONL startup isolates only auxiliary launchers and retains CODEX_HOME', async t => {
  const { runtime, events, calls } = fixture(t);
  assert.deepEqual(events(), []);
  assert.equal(runtime.status().running, false);
  for (const tool of names) {
    const input = ['event_stream_start', 'computer_history_resume'].includes(tool) ? recording : tool === 'computer_history_update_settings' ? privacy() : {};
    const result = await runtime.callTool(tool, input);
    assert.equal(result.isError, false);
    assert.equal(meta(result).tool, tool);
    assert.equal(meta(result).dispatched, true);
    assert.equal(meta(result).outcome, 'reported');
  }
  const rows = events();
  assert.equal(rows.filter(row => row.event === 'spawn').length, 1);
  assert.deepEqual(rows[0].argv, ['app-server', '--disable', 'apps', '--enable', 'computer_use', '--enable', 'plugins', '--enable', 'tool_call_mcp_elicitation']);
  assert.equal(rows[0].home, process.env.CODEX_HOME ?? null);
  assert.deepEqual(rows.filter(row => row.method).slice(0, 4).map(row => row.method), ['initialize', 'initialized', 'config/read', 'thread/start']);
  const start = rows.find(row => row.method === 'thread/start').params;
  assert.equal(start.ephemeral, true);
  assert.equal(start.approvalPolicy, 'on-request');
  assert.equal(start.config.features.apps, false);
  assert.deepEqual(start.config.plugins, { unrelated: { enabled: false } });
  assert.deepEqual(start.config.mcp_servers.unrelated, { enabled: false });
  assert.deepEqual(start.config.mcp_servers['computer-use'], { enabled: false });
  assert.deepEqual(Object.keys(start.config.mcp_servers).filter(name => start.config.mcp_servers[name].enabled), ['event-stream', 'computer-history']);
  for (const [name, plugin] of [['event-stream', 'record-and-replay'], ['computer-history', 'computer-history']]) {
    const config = start.config.mcp_servers[name];
    assert.equal(config.command, `${process.env.MACUSE_CHATGPT_RESOURCES ?? '/Applications/ChatGPT.app/Contents/Resources'}/plugins/openai-bundled/plugins/${plugin}/bin/computer-use-client-launcher`);
    assert.deepEqual(config.args, [name, 'mcp']);
    assert.deepEqual(config.env_vars, ['CODEX_HOME']);
  }
  assert.equal(rows.filter(row => row.method === 'mcpServerStatus/list').length, 2, 'both inventory pages are checked');
  assert.deepEqual(calls().map(row => row.params.arguments), names.map(name => name === 'computer_history_update_settings' ? { observation: observation() } : {}));
  assert.deepEqual(calls().map(row => row.params.server), names.map(name => name.startsWith('event_stream_') ? 'event-stream' : 'computer-history'));
  await runtime.stop();
  assert.equal(runtime.status().running, false);
  assert.equal(runtime.status().pendingRequests, 0);
  assert.equal(events().filter(row => row.event === 'eof').length, 1);
  assert.equal((await runtime.callTool('computer_history_status')).isError, false);
  assert.equal(events().filter(row => row.event === 'spawn').length, 2);
});

test('resource install override and CODEX_HOME reach isolated launcher configuration', t => {
  const { runtime, events } = fixture(t);
  const script = `import { AuxiliaryRuntime } from ${JSON.stringify(new URL('../../lib/auxiliary-runtime.mjs', import.meta.url).href)};
    const runtime = new AuxiliaryRuntime(${JSON.stringify({ cwd: runtime.cwd, codexBin: runtime.codexBin })});
    try { const result = await runtime.callTool('event_stream_status'); if (result.isError) throw new Error(JSON.stringify(result)); }
    finally { await runtime.stop(); }`;
  execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, MACUSE_CHATGPT_RESOURCES: '/custom/ChatGPT.app/Contents/Resources', CODEX_HOME: '/preserved/codex-home' }, timeout: 5000 });
  assert.equal(events()[0].home, '/preserved/codex-home');
  const config = events().find(row => row.method === 'thread/start').params.config;
  for (const name of ['event-stream', 'computer-history']) {
    assert.ok(config.mcp_servers[name].command.startsWith('/custom/ChatGPT.app/Contents/Resources/'));
    assert.deepEqual(config.mcp_servers[name].env_vars, ['CODEX_HOME']);
  }
});

test('validated active calls retain the proven elicitation response path', async t => {
  const { runtime, events } = fixture(t, { responses: ['elicit'] });
  assert.equal((await runtime.callTool('event_stream_start', recording)).isError, false);
  assert.deepEqual(events().find(row => row.id === 'approval' && row.result).result, { action: 'accept', content: {}, _meta: null });
});

for (const reason of ['aborted', 'timeout']) test(`${reason} stops and awaits owned transport before queue release, ignores late success, and never replays`, async t => {
  const { runtime, events, calls } = fixture(t, { responses: [success, 'hold', success], exitDelay: 150, lateReply: true });
  await runtime.callTool('event_stream_status');
  const controller = new AbortController();
  let settled = false;
  const first = runtime.callTool('event_stream_start', recording, { signal: controller.signal, timeoutMs: reason === 'timeout' ? 80 : 3000 }).then(result => { settled = true; return result; });
  await until(() => calls().length === 2, 'mutation dispatch');
  const next = runtime.callTool('computer_history_status');
  if (reason === 'aborted') controller.abort();
  await until(() => events().some(row => row.event === 'eof'), 'owned stdin EOF');
  assert.equal(settled, false, 'caller must retain ownership until process exit');
  assert.equal(calls().length, 2);
  const result = await first;
  assert.equal(result.isError, true);
  assert.equal(meta(result).reason, reason);
  assert.equal(meta(result).dispatched, true);
  assert.equal(meta(result).outcome, 'unknown');
  assert.equal(meta(result).attempts, 1);
  assert.equal((await next).isError, false);
  const rows = events();
  assert.ok(rows.findIndex(row => row.event === 'exit') < rows.findIndex(row => row.event === 'tool' && row.params.tool === 'computer_history_status'));
  assert.equal(calls().filter(row => row.params.tool === 'event_stream_start').length, 1);
  assert.equal(rows.some(row => row.id === 'late-approval' && row.result?.action === 'accept'), false);
  assert.equal(rows.some(row => /cancel|interrupt/i.test(row.method ?? '')), false);
});

test('queued cancellation does not stop active work; settings are copied before waiting', async t => {
  const { runtime, calls, release, events } = fixture(t, { responses: ['hold', success] });
  const first = runtime.callTool('event_stream_status');
  await until(() => calls().length === 1, 'first dispatch');
  const controller = new AbortController();
  const aborted = runtime.callTool('event_stream_status', {}, { signal: controller.signal });
  controller.abort();
  const timeout = runtime.callTool('computer_history_pause', {}, { timeoutMs: 20 });
  for (const result of await Promise.all([aborted, timeout])) {
    assert.equal(meta(result).dispatched, false);
    assert.equal(meta(result).outcome, 'not_dispatched');
  }
  assert.equal(events().some(row => row.event === 'eof'), false);
  const input = privacy();
  const update = runtime.callTool('computer_history_update_settings', input);
  input.observation.defaultURLBehavior = 'invalid';
  input.observation.allowlist[0].bundleID = 'changed';
  release();
  assert.equal((await first).isError, false);
  assert.equal((await update).isError, false);
  assert.equal(calls().length, 2);
  assert.deepEqual(calls()[1].params.arguments, { observation: observation() });
});

for (const response of [
  { content: [{ type: 'text', text: 'This application session has been explicitly stopped by the user for this turn.' }] },
  { content: [{ type: 'text', text: 'Transport closed' }], isError: true },
  { rpcError: 'connection closed' }, 'exit',
]) test(`read-only retries one demonstrated stopped/closed session: ${JSON.stringify(response)}`, async t => {
  const { runtime, calls, events } = fixture(t, { responses: [response, success] });
  const result = await runtime.callTool('computer_history_get_settings');
  assert.equal(result.isError, false);
  assert.equal(meta(result).attempts, 2);
  assert.equal(calls().length, 2);
  assert.equal(events().filter(row => row.event === 'spawn').length, 2);
});

test('terminal stopped-session sentinel becomes a descriptive error without keyword-classifying other results', async t => {
  const stopped = { content: [{ type: 'text', text: 'This application session has been explicitly stopped by the user for this turn.' }] };
  const one = fixture(t, { responses: [stopped, stopped] });
  const result = await one.runtime.callTool('event_stream_status');
  assert.equal(result.isError, true);
  assert.equal(meta(result).attempts, 2);
  assert.match(result.content[0].text, /auxiliary application session is stopped/);
  assert.doesNotMatch(result.content[0].text, /explicitly stopped by the user for this turn/);
  const two = fixture(t, { responses: [{ content: [{ type: 'text', text: 'User denied recording; status is paused. Historical transport closed yesterday.' }], isError: false }] });
  const status = await two.runtime.callTool('computer_history_status');
  assert.equal(status.isError, false);
  assert.equal(meta(status).attempts, 1);
});

test('read-only recovery stops after one retry, without retrying unrelated errors or timeout', async t => {
  const closed = { content: [{ type: 'text', text: 'Transport closed' }], isError: true };
  const twice = fixture(t, { responses: [closed, closed] });
  const result = await twice.runtime.callTool('event_stream_status');
  assert.equal(result.isError, true);
  assert.equal(meta(result).attempts, 2);
  assert.equal(twice.calls().length, 2);
  const auth = fixture(t, { responses: [{ rpcError: 'Sender authentication failed' }] });
  assert.equal((await auth.runtime.callTool('event_stream_status')).isError, true);
  assert.equal(auth.calls().length, 1);
  const timeout = fixture(t, { responses: [success, 'hold'] });
  await timeout.runtime.callTool('event_stream_status');
  const timed = await timeout.runtime.callTool('computer_history_status', {}, { timeoutMs: 50 });
  assert.equal(meta(timed).reason, 'timeout');
  assert.equal(meta(timed).attempts, 1);
  assert.equal(timeout.calls().length, 2);
});

for (const tool of ['event_stream_start', 'computer_history_resume', 'computer_history_update_settings', 'event_stream_stop', 'computer_history_pause']) test(`${tool} never automatically retries a closed transport`, async t => {
  const { runtime, calls } = fixture(t, { responses: ['exit'] });
  const result = await runtime.callTool(tool, ['event_stream_start', 'computer_history_resume'].includes(tool) ? recording : tool === 'computer_history_update_settings' ? privacy() : {});
  assert.equal(result.isError, true);
  assert.equal(meta(result).dispatched, true);
  assert.equal(meta(result).outcome, 'unknown');
  assert.equal(meta(result).attempts, 1);
  assert.equal(calls().length, 1);
});

for (const holdStage of ['initialize', 'config/read', 'thread/start', 'mcpServerStatus/list']) test(`startup cancellation at ${holdStage} reports no action dispatched`, async t => {
  const { runtime, events, calls } = fixture(t, { holdStage });
  const controller = new AbortController();
  const call = runtime.callTool('event_stream_start', recording, { signal: controller.signal });
  await until(() => events().some(row => row.method === holdStage), holdStage);
  controller.abort();
  const result = await call;
  assert.equal(meta(result).dispatched, false);
  assert.equal(meta(result).reason, 'aborted');
  assert.equal(runtime.status().running, false);
  assert.deepEqual(calls(), []);
});

test('missing inventory or malformed effective config prevents dispatch', async t => {
  for (const options of [{ missingInventory: true }, { badConfig: true }]) {
    const { runtime, calls } = fixture(t, options);
    const result = await runtime.callTool('event_stream_start', recording, { timeoutMs: 500 });
    if (options.missingInventory) {
      assert.match(result.content[0].text, /Missing auxiliary tools: event-stream\/event_stream_start/);
      assert.match(result.content[0].text, /computer-history\/computer_history_update_settings/);
      assert.equal(meta(result).missingTools.length, 8);
    }
    assert.equal(result.isError, true);
    assert.equal(meta(result).dispatched, false);
    assert.equal(runtime.status().running, false);
    assert.deepEqual(calls(), []);
  }
});

test('spawn errors are not retried as transport closures', async () => {
  const runtime = new AuxiliaryRuntime({ codexBin: '/not/an/executable' });
  const result = await runtime.callTool('event_stream_status');
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /ENOENT/);
  assert.equal(meta(result).dispatched, false);
  assert.equal(meta(result).attempts, 1);
  assert.equal(runtime.status().running, false);
});

test('explicit stop settles active work without retry and leaves other owned runtimes untouched', async t => {
  const one = fixture(t, { responses: ['hold'], exitDelay: 40 });
  const two = fixture(t);
  await two.runtime.callTool('event_stream_status');
  const pending = one.runtime.callTool('event_stream_status');
  await until(() => one.calls().length === 1, 'pending read');
  await one.runtime.stop();
  const result = await pending;
  assert.equal(meta(result).reason, 'stopped');
  assert.equal(meta(result).outcome, 'unknown');
  assert.equal(one.calls().length, 1);
  assert.equal(two.runtime.status().running, true);
  assert.equal((await two.runtime.callTool('event_stream_status')).isError, false);
  assert.equal(two.events().filter(row => row.event === 'spawn').length, 1);
});

test('a subprocess ignoring EOF and SIGTERM is killed and awaited before settlement', { timeout: 7000 }, async t => {
  const { runtime, events, calls } = fixture(t, { responses: ['hold'], ignoreStop: true });
  const controller = new AbortController();
  const pending = runtime.callTool('event_stream_start', recording, { signal: controller.signal });
  await until(() => calls().length === 1, 'held action');
  controller.abort();
  const result = await pending;
  assert.equal(meta(result).outcome, 'unknown');
  assert.equal(runtime.status().running, false);
  assert.equal(runtime.status().pendingRequests, 0);
  assert.ok(events().some(row => row.event === 'eof'));
  assert.ok(events().some(row => row.event === 'term'));
});
