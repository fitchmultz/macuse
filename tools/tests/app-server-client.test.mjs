import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createJiti } from 'jiti';

const jiti = createJiti(import.meta.url);
const { AppServerClient } = await jiti.import('../../extensions/codex-computer-use-modules/app-server-client.ts');
const { MCP_SERVERS, mcpServerConfigs } = await jiti.import('../../extensions/codex-computer-use-modules/core.ts');

async function until(predicate, description) {
  const deadline = Date.now() + 3_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${description}`);
    await delay(5);
  }
}

async function fixture(t, { holdInitialize = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'macuse-transport-test-'));
  const binary = join(dir, 'codex.cjs');
  const log = join(dir, 'rpc.jsonl');
  const release = join(dir, 'release');
  writeFileSync(log, '');
  writeFileSync(binary, `#!/usr/bin/env node
const { appendFileSync, existsSync } = require('node:fs');
const readline = require('node:readline');
const log = ${JSON.stringify(log)};
const release = ${JSON.stringify(release)};
const inventories = ${JSON.stringify(Object.fromEntries(Object.entries(MCP_SERVERS).map(([name, server]) => [name, server.tools])))};
const record = (event) => appendFileSync(log, JSON.stringify(event) + '\\n');
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
const result = (id, value) => send({ id, result: value });
record({ event: 'spawn', argv: process.argv.slice(2), codexHome: process.env.CODEX_HOME ?? null });
let active = 0;
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  record({ event: 'rpc', ...m });
  if (!m.method) return;
  if (m.method === 'initialize') { if (!${JSON.stringify(holdInitialize)}) result(m.id, {}); }
  else if (m.method === 'initialized') return;
  else if (m.method === 'config/read') result(m.id, { config: {
    mcp_servers: { unrelated: { command: '/must/not/run', enabled: true } },
    plugins: { 'unrelated@example': { enabled: true } },
  } });
  else if (m.method === 'thread/start') result(m.id, { thread: { id: 'fixture-thread' } });
  else if (m.method === 'mcpServerStatus/list') result(m.id, { data: Object.entries(inventories).map(([name, tools]) => ({ name, tools: Object.fromEntries(tools.map((tool) => [tool, {}])) })) });
  else if (m.method === 'mcpServer/tool/call') {
    active += 1;
    const label = m.params.arguments.text;
    record({ event: 'started', label, active });
    const finish = () => {
      active -= 1;
      record({ event: 'finished', label, active });
      result(m.id, { content: [{ type: 'text', text: label ?? 'ok' }], isError: false });
    };
    if (label === 'held') {
      const timer = setInterval(() => {
        if (existsSync(release + '.prompt')) {
          require('node:fs').unlinkSync(release + '.prompt');
          send({ id: 'late-permission', method: 'mcpServer/elicitation/request', params: {} });
        }
        if (existsSync(release)) { clearInterval(timer); finish(); }
      }, 5);
    } else finish();
  } else send({ id: m.id, error: { code: -32601, message: 'unsupported RPC' } });
});
`);
  chmodSync(binary, 0o755);
  const client = new AppServerClient(binary, dir);
  t.after(async () => { await client.stop(); rmSync(dir, { recursive: true, force: true }); });
  const events = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const call = (text, opts = {}) => client.callTool('type_text', { app: 'fixture', text }, { approval: 'accept-all', timeoutMs: 2_000, ...opts });
  const releaseHeld = () => writeFileSync(release, '');
  if (!holdInitialize) await client.ensureReady(2_000);
  return { client, events, call, releaseHeld, prompt: () => writeFileSync(release + '.prompt', '') };
}

test('startup isolates the ephemeral thread with native config overrides and preserves plugin home', async (t) => {
  const { client, events } = await fixture(t);
  const messages = events();
  assert.deepEqual(messages.filter(m => m.method).slice(0, 4).map(m => m.method), ['initialize', 'initialized', 'config/read', 'thread/start']);
  const configIndex = messages.findIndex((m) => m.method === 'config/read');
  const threadIndex = messages.findIndex((m) => m.method === 'thread/start');
  assert.ok(configIndex >= 0 && configIndex < threadIndex);
  const config = messages[threadIndex].params.config;
  assert.deepEqual(config.mcp_servers.unrelated, { enabled: false });
  assert.deepEqual(config.plugins['unrelated@example'], { enabled: false });
  for (const [name, expected] of Object.entries(mcpServerConfigs())) assert.deepEqual(config.mcp_servers[name], expected);
  assert.equal(messages[0].codexHome, process.env.CODEX_HOME ?? null);
  assert.deepEqual(messages[0].argv.slice(0, 3), ['app-server', '--disable', 'apps']);
  assert.equal(config.features.apps, false);
  assert.deepEqual(Object.values(client.status().inventories).map((inventory) => inventory.toolCount).sort((a, b) => a - b), [3, 5, 10]);
});

for (const reason of ['aborted', 'timeout']) {
  test(`${reason} returns outcome-unknown promptly but retains ownership through the late RPC response`, async (t) => {
    const { client, events, call, releaseHeld, prompt } = await fixture(t);
    const controller = new AbortController();
    const first = call('held', { signal: controller.signal, timeoutMs: reason === 'timeout' ? 100 : 2_000 }).catch((error) => error);
    await until(() => events().some((m) => m.event === 'started'), 'first dispatch');
    if (reason === 'aborted') controller.abort();
    const error = await Promise.race([first, delay(500).then(() => assert.fail('local cancellation waited for upstream completion'))]);
    assert.equal(error.details.reason, reason);
    assert.equal(error.details.dispatched, true);
    assert.equal(error.details.outcomeUnknown, true);
    assert.match(error.message, /Upstream cancellation is unavailable/);
    assert.equal(client.status().pendingRequests.length, 1);
    assert.equal(client.status().pendingRequests[0].outcomeUnknown, true);

    prompt();
    await until(() => events().some((m) => m.id === 'late-permission' && m.result), 'late permission response');
    assert.equal(events().find((m) => m.id === 'late-permission' && m.result).result.action, 'decline');
    const second = call('second');
    // If the queue was released by local rejection, the subprocess records active=2.
    await delay(40);
    assert.deepEqual(events().filter((m) => m.event === 'started').map((m) => m.label), ['held']);
    releaseHeld();
    assert.equal((await second).result.content[0].text, 'second');
    const starts = events().filter((m) => m.event === 'started');
    assert.deepEqual(starts.map((m) => m.active), [1, 1]);
    assert.deepEqual(client.status().pendingRequests, []);
    assert.ok(!events().some((m) => /cancel|interrupt/i.test(m.method ?? '')));
  });
}

test('queued calls can abort or time out without dispatching or releasing the previous operation', async (t) => {
  const { events, call, releaseHeld } = await fixture(t);
  const firstController = new AbortController();
  const first = call('held', { signal: firstController.signal }).catch((error) => error);
  await until(() => events().some((m) => m.event === 'started'), 'first dispatch');
  firstController.abort();
  await first;
  const queuedController = new AbortController();
  const canceled = call('must-not-abort', { signal: queuedController.signal }).catch((error) => error);
  queuedController.abort();
  const timedOut = call('must-not-timeout', { timeoutMs: 30 }).catch((error) => error);
  for (const error of await Promise.all([canceled, timedOut])) {
    assert.equal(error.details.dispatched, false);
    assert.equal(error.details.outcomeUnknown, false);
  }
  releaseHeld();
  await call('last');
  assert.deepEqual(events().filter((m) => m.event === 'started').map((m) => m.label), ['held', 'last']);
});

test('explicit owned-transport restart permits fresh calls after a stuck RPC', async (t) => {
  const { client, events, call } = await fixture(t);
  const controller = new AbortController();
  const first = call('held', { signal: controller.signal }).catch((error) => error);
  await until(() => events().some((m) => m.event === 'started'), 'first dispatch');
  controller.abort();
  assert.equal((await first).details.outcomeUnknown, true);
  const queued = call('after-stop');
  await client.restart();
  assert.equal((await queued).result.content[0].text, 'after-stop');
  assert.equal(events().filter((m) => m.event === 'spawn').length, 2);
  assert.deepEqual(client.status().pendingRequests, []);
});

test('aborting startup reports that no Computer Use action was sent', async (t) => {
  const { client, events, call } = await fixture(t, { holdInitialize: true });
  const controller = new AbortController();
  const first = call('must-not-run', { signal: controller.signal }).catch((error) => error);
  await until(() => events().some((m) => m.method === 'initialize'), 'initialize request');
  controller.abort();
  const error = await first;
  assert.equal(error.details.dispatched, false);
  assert.equal(error.details.outcomeUnknown, false);
  assert.equal(error.details.method, 'initialize');
  await client.stop();
  assert.deepEqual(events().filter((m) => m.event === 'started'), []);
});

test('an already-aborted call does not launch an app-server', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'macuse-preabort-test-'));
  const client = new AppServerClient(join(dir, 'must-not-launch'), dir);
  t.after(async () => { await client.stop(); rmSync(dir, { recursive: true, force: true }); });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(client.callTool('list_apps', {}, { approval: 'inherit', timeoutMs: 100, signal: controller.signal }), (error) => error.details?.dispatched === false);
  assert.equal(client.status().running, false);
});
