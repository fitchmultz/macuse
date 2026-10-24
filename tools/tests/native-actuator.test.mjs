import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { NativeActuator } from '../native-actuator.mjs';

const exec = promisify(execFile);
const noDispatch = error => error.dispatched === false && error.mutationAttempted === false && error.outcome === 'not-dispatched';

test('actuator rejects non-JSON and malformed Unicode before native dispatch', async () => {
  const actuator = new NativeActuator();
  const cycle = {}; cycle.self = cycle;
  try {
    for (const [args, pattern] of [[cycle, /acyclic/], [{ value: 1n }, /only JSON/], [{ value: undefined }, /only JSON/],
      [{ value: '\ud800' }, /well-formed Unicode/], [{ value: Infinity }, /finite/], [{ value: NaN }, /finite/]]) {
      await assert.rejects(actuator.act(args), error => error instanceof TypeError && noDispatch(error) && pattern.test(error.message));
    }
  } finally { await actuator.stop(); }
});

test('full wire framing budget refuses a near-limit act as not dispatched', async () => {
  const actuator = new NativeActuator();
  const args = { value: 'x'.repeat(1_000_000 - Buffer.byteLength(JSON.stringify({ value: '' }))) };
  assert.equal(Buffer.byteLength(JSON.stringify(args)), 1_000_000);
  try {
    await assert.rejects(actuator.act(args), error =>
      error instanceof RangeError && noDispatch(error) && /wire request exceeds one megabyte/.test(error.message));
  } finally { await actuator.stop(); }
});

test('native process denies missing authority and stale observation without touching an app', { skip: process.platform !== 'darwin' }, async () => {
  const actuator = new NativeActuator();
  try {
    // Caller data cannot replace the transport-selected method or correlation ID.
    await assert.rejects(actuator.act({ method: 'observe', id: 999, app: 'not.a.running.app' }), error => noDispatch(error) && /allowMutating/.test(error.message));
    await assert.rejects(actuator.act({ app: 'not.a.running.app', observationId: 'invented', elementToken: 'invented', action: 'press',
      allowMutating: true, safetyNote: 'Negative control: no target observation exists.' }), error => noDispatch(error) && /Fresh same-app observation/.test(error.message));
  } finally { await actuator.stop(); }
});

test('native wire rejects an oversized unterminated request before parsing or AX access', { skip: process.platform !== 'darwin', timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'macuse-actuator-wire-'));
  try {
    const binary = join(directory, 'actuator');
    await exec('/usr/bin/xcrun', ['swiftc', fileURLToPath(new URL('../native-actuator.swift', import.meta.url)), '-o', binary]);
    const result = await new Promise((resolve, reject) => {
      const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'] });
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      let output = '';
      child.stdout.on('data', chunk => { output += chunk; });
      child.stdin.on('error', () => {}); // Native rejection may close the pipe while the final bytes are buffered.
      child.once('error', reject);
      child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, output }); });
      child.stdin.end(Buffer.alloc(1_000_001, 97));
    });
    assert.deepEqual(result, { code: 1, signal: null, output: '' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('stop during cold compilation drains owned processes and cancels queued dispatch, then permits a fresh session', { skip: process.platform !== 'darwin', timeout: 30_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'macuse-actuator-stop-'));
  try {
    const module = new URL('../native-actuator.mjs', import.meta.url).href;
    const script = `
      import assert from 'node:assert/strict';
      import childProcess from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      const realSpawn = childProcess.spawn;
      const children = [];
      let writes = 0;
      let stopping;
      let actuator;
      childProcess.spawn = (...args) => {
        const child = realSpawn(...args);
        const tracked = { pid: child.pid, exited: false };
        children.push(tracked);
        child.once('close', () => { tracked.exited = true; });
        if (child.stdin) {
          const write = child.stdin.write.bind(child.stdin);
          child.stdin.write = (...args) => { writes++; return write(...args); };
        }
        if (args[0] === '/usr/bin/xcrun' && !stopping) queueMicrotask(() => { stopping = actuator.stop(); });
        return child;
      };
      syncBuiltinESMExports();
      const { NativeActuator } = await import(${JSON.stringify(module)});
      actuator = new NativeActuator();
      const results = await Promise.allSettled([actuator.act({}), actuator.act({})]);
      await stopping;
      assert.equal(results.length, 2);
      for (const result of results) {
        assert.equal(result.status, 'rejected');
        assert.equal(result.reason.dispatched, false);
      }
      assert.equal(writes, 0, 'pre-stop requests must not reach native stdin');
      assert.ok(children.length >= 1, 'exercise real cold compiler startup');
      assert.ok(children.every(child => child.exited), 'stop must settle only after owned children exit');
      await assert.rejects(actuator.act({}), /allowMutating/);
      await actuator.stop();
      assert.ok(children.every(child => child.exited));
      console.log(JSON.stringify({ coldStartupCancelled: true, queuedDispatchCancelled: true, reusable: true }));
    `;
    const { stdout } = await exec(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, HOME: home }, timeout: 25_000 });
    assert.deepEqual(JSON.parse(stdout), { coldStartupCancelled: true, queuedDispatchCancelled: true, reusable: true });
  } finally { await rm(home, { recursive: true, force: true }); }
});
