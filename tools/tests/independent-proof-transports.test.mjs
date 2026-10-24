import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { findPackageJSON } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const exec = promisify(execFile);
const mac = { skip: process.platform !== 'darwin', timeout: 60000 };
const tool = 'macuse_independent_proof';
const reset = 'macuse_independent_proof_reset';
const env = { ...process.env, PI_OFFLINE: '1', MACUSE_INDEPENDENT_PROOF_TARGET: '', MACUSE_CHATGPT_RESOURCES: '/no-vendor-installation-in-proof' };
const value = result => result.details.independent.execution.value;
const requests = [
  { tool, input: { code: 'var retained=41; retained' } },
  { tool: reset, input: { unexpected: true } },
  { tool, input: { code: "({counter:++retained,text:'独立\u2028é'})" } },
  { tool: reset, input: {} },
  { tool, input: { code: 'typeof retained' } },
  { tool, input: { code: "macuse.call('observe',{app:'com.macuse.actuator-fixture.11111111-1111-4111-8111-111111111111'})" } },
];

async function sessionProcess(script, args = [], expectedExit = 0, hostValidatesSchema = false) {
  const input = requests.map(request => JSON.stringify(request)).join('\r\n');
  const child = execFile(process.execPath, [fileURLToPath(new URL(script, import.meta.url)), ...args], { env, timeout: 50000, maxBuffer: 2 * 1024 * 1024 });
  child.stdin.end(input);
  const result = await new Promise((resolve, reject) => {
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      try {
        assert.equal(signal, null, stderr);
        assert.equal(code, expectedExit, stderr);
        resolve(stdout.trim().split('\n').map(line => JSON.parse(line)));
      } catch (error) { reject(error); }
    });
  });
  assert.equal(result.length, requests.length);
  assert.equal(value(result[0]), 41);
  assert.equal(result[1].isError, true);
  if (!hostValidatesSchema) {
    assert.equal(result[1].details.independent.outcome, 'not-dispatched');
    assert.equal(result[1].details.independent.dispatched, false);
  }
  assert.deepEqual(value(result[2]), { counter: 42, text: '独立\u2028é' });
  assert.equal(result[3].isError, false);
  assert.equal(value(result[4]), 'undefined');
  assert.equal(result[5].isError, true, 'Targetless native read must remain an error across the transport');
  assert.equal(result[5].details.independent.isError, true);
}

test('actual CLI preserves JSONL Unicode, bindings, predispatch reset refusal, reset and targetless native failure', mac, async () => {
  await sessionProcess('../independent-proof-cli.mjs', ['session'], 1);
  const oversized = exec(process.execPath, [fileURLToPath(new URL('../independent-proof-cli.mjs', import.meta.url)), 'session'], { env, timeout: 10000 });
  oversized.child.stdin.end('x'.repeat(131073));
  await assert.rejects(oversized, error => error.code === 1 && /128 KiB/.test(error.stderr) && error.stdout === '');
});

test('actual MCP preserves proof results, failure metadata and reset through the public stdio client', mac, async () => {
  const client = new Client({ name: 'independent-proof-transport-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../independent-proof-mcp.mjs', import.meta.url))], env, stderr: 'pipe' });
  let pid;
  try {
    await client.connect(transport);
    pid = transport.pid;
    assert.deepEqual((await client.listTools()).tools.map(tool => tool.name).sort(), [tool, reset].sort());
    const first = await client.callTool({ name: tool, arguments: { code: 'var retained=41; retained' } });
    assert.equal(first._meta.independent.execution.value, 41);
    const refused = await client.callTool({ name: 'not_a_proof_tool', arguments: {} });
    assert.equal(refused.isError, true);
    assert.equal(refused._meta.independent.outcome, 'not-dispatched');
    assert.equal(refused._meta.independent.dispatched, false);
    const denied = await client.callTool({ name: tool, arguments: requests.at(-1).input });
    assert.equal(denied.isError, true);
    assert.equal(denied._meta.independent.isError, true);
    const cleared = await client.callTool({ name: reset, arguments: {} });
    assert.equal(cleared.isError, false);
    const fresh = await client.callTool({ name: tool, arguments: { code: 'typeof retained' } });
    assert.equal(fresh._meta.independent.execution.value, 'undefined');
  } finally { await client.close(); }
  assert.ok(pid);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'Owned MCP server must exit after transport close');
});

test('actual Pi SDK tool boundary preserves proof errors and reset in a fresh isolated host process', mac, async () => {
  const host = dirname(findPackageJSON('@earendil-works/pi-coding-agent', import.meta.url));
  await sessionProcess('../independent-proof-pi-worker.mjs', [host], 0, true);
});
