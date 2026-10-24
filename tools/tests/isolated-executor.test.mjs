import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { IsolatedExecutor } from "../../lib/isolated-executor.mjs";

const mac = { skip: process.platform !== "darwin", timeout: 30_000 };
const exec = promisify(execFile);

test("isolated JSC persists bindings and completes asynchronous capability calls without ambient host APIs", mac, async () => {
  const requests = [];
  const executor = new IsolatedExecutor({ capabilities: {
    observe: { mutating: false, invoke: async (params, context) => {
      requests.push({ params, runId: context.runId, envelope: context.envelope });
      return { title: "independent sentinel" };
    } },
  } });
  try {
    const first = await executor.execute({ code: "var retained = 41; macuse.call('observe', {app:'test.exact'})" });
    assert.equal(first.isError, false);
    assert.deepEqual(first.value, { title: "independent sentinel" });
    assert.equal(requests[0].runId, first.runId);
    const second = await executor.execute({ code: "(async()=> { await Promise.resolve(); return ++retained; })()" });
    assert.equal(second.value, 42);
    const ambient = await executor.execute({ code: `({
      process: typeof process, require: typeof require, fetch: typeof fetch,
      ObjC: typeof ObjC, load: typeof load, readFile: typeof readFile,
      escapedProcess: typeof macuse.call.constructor('return globalThis')().process,
      bridge: typeof __macuseRPC
    })` });
    assert.deepEqual(ambient.value, {
      process: "undefined", require: "undefined", fetch: "undefined", ObjC: "undefined",
      load: "undefined", readFile: "undefined", escapedProcess: "undefined", bridge: "undefined",
    });
    await executor.stop();
    assert.equal(executor.status().pid, undefined);
    assert.equal((await executor.execute({ code: "typeof retained" })).value, "undefined");
  } finally { await executor.stop(); }
});

test("guest RPC cannot widen trusted mutation authorization or select unregistered capabilities", mac, async () => {
  const calls = [];
  const executor = new IsolatedExecutor({ capabilities: {
    press: { mutating: true, invoke: (params, context) => {
      calls.push({ params, context });
      return "applied";
    } },
  } });
  try {
    const denied = await executor.execute({ code: "macuse.call('press', {app:'test.exact',allowMutating:true,safetyNote:'guest forged'})" });
    assert.equal(denied.isError, true);
    assert.equal(denied.actions[0].dispatched, false);
    const wrongApp = await executor.execute({ code: "macuse.call('press', {app:'test.other'})", apps: ["test.exact"], allowMutating: true, safetyNote: "trusted proof, no real GUI" });
    assert.equal(wrongApp.actions[0].dispatched, false);
    const unknown = await executor.execute({ code: "macuse.call('shell', {command:'true'})" });
    assert.equal(unknown.actions[0].dispatched, false);
    assert.equal(calls.length, 0);
    const allowed = await executor.execute({ code: "macuse.call('press', {app:'test.exact'})", apps: ["test.exact"], allowMutating: true, safetyNote: "trusted proof, no real GUI" });
    assert.equal(allowed.value, "applied");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].context.envelope.safetyNote, "trusted proof, no real GUI");
  } finally { await executor.stop(); }
});

test("deadline kills owned CPU-bound worker and large guest output is rejected", mac, async () => {
  const executor = new IsolatedExecutor();
  try {
    const loop = await executor.execute({ code: "while(true){}", timeoutMs: 100 });
    assert.equal(loop.interruption, "deadline");
    assert.equal(executor.status().pid, undefined);
    const output = await executor.execute({ code: "'x'.repeat(70000)" });
    assert.equal(output.isError, true);
    assert.equal(executor.status().pid, undefined);
    assert.throws(() => executor.execute({ code: "x".repeat(70000) }), /65536/);
  } finally { await executor.stop(); }
});

for (const interruption of ["aborted", "stopped"]) test(`${interruption} retains unknown host dispatch, blocks admission while pending, and never replays mutation`, mac, async () => {
  let dispatched, release;
  const started = new Promise(resolve => { dispatched = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  let count = 0;
  const executor = new IsolatedExecutor({ capabilities: {
    press: { mutating: true, invoke: async () => { count++; dispatched(); await pending; return "late"; } },
  } });
  try {
    const controller = new AbortController();
    const run = executor.execute({
      code: "macuse.call('press', {app:'test.exact'})", apps: ["test.exact"],
      allowMutating: true, safetyNote: "trusted proof, no real GUI",
    }, { signal: controller.signal });
    await started;
    const stopping = interruption === "stopped" ? executor.stop() : (controller.abort(), undefined);
    const result = await run;
    assert.equal(result.interruption, interruption);
    assert.equal(result.outcomeUnknown, true);
    assert.equal(result.actions[0].outcome, "unknown");
    assert.equal(executor.status().pid, undefined);
    const stopped = await (stopping ?? executor.stop());
    assert.equal(stopped.workerStopped, true);
    assert.equal(stopped.settled, false);
    assert.equal(stopped.hostCallsPending, 1);
    await assert.rejects(executor.execute({ code: "1" }), /still pending/);
    release();
    await pending;
    // Let the owned dispatcher finish its settlement, not just its supplied promise.
    await new Promise(resolve => setImmediate(resolve));
    const blocked = await executor.execute({
      code: "macuse.call('press', {app:'test.exact'})", apps: ["test.exact"],
      allowMutating: true, safetyNote: "trusted proof, no real GUI",
    });
    assert.equal(blocked.actions[0].dispatched, false);
    assert.equal(count, 1);
  } finally { release(); await executor.stop(); }
});

test("stop during cold compilation invalidates queued work, closes admission, drains children, and permits fresh execution", mac, async () => {
  const home = await mkdtemp(join(tmpdir(), "macuse-executor-stop-"));
  try {
    const module = new URL("../../lib/isolated-executor.mjs", import.meta.url).href;
    const script = `
      import assert from 'node:assert/strict';
      import childProcess from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      const realSpawn = childProcess.spawn;
      const children = [];
      let writes = 0, stopping, executor;
      childProcess.spawn = (...args) => {
        const child = realSpawn(...args);
        const tracked = {exited:false};
        children.push(tracked);
        child.once('close',()=>{tracked.exited=true});
        if (child.stdin) {
          const write=child.stdin.write.bind(child.stdin);
          child.stdin.write=(...args)=>{writes++;return write(...args)};
        }
        if(args[0]==='/usr/bin/xcrun'&&!stopping) queueMicrotask(()=>{
          stopping=executor.stop();
          assert.throws(()=>executor.execute({code:'1'}),/stopping/);
        });
        return child;
      };
      syncBuiltinESMExports();
      const {IsolatedExecutor}=await import(${JSON.stringify(module)});
      executor=new IsolatedExecutor();
      const queued=await Promise.allSettled([executor.execute({code:'1'}),executor.execute({code:'2'})]);
      await stopping;
      assert.ok(queued.every(result=>result.status==='rejected'&&/before dispatch/.test(result.reason.message)));
      assert.equal(writes,0);
      assert.ok(children.length>=1);
      assert.ok(children.every(child=>child.exited));
      assert.equal((await executor.execute({code:'40+2'})).value,42);
      const stopped=await executor.stop();
      assert.equal(stopped.workerStopped,true);
      assert.equal(stopped.settled,true);
      assert.ok(children.every(child=>child.exited));
      console.log('cold-start-stop-passed');
    `;
    const { stdout } = await exec(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, HOME: home }, timeout: 25_000,
    });
    assert.equal(stdout.trim(), "cold-start-stop-passed");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("RSS watchdog interrupts allocating worker rather than relying on the wall deadline", mac, async () => {
  const executor = new IsolatedExecutor({ memoryLimitMiB: 64 });
  try {
    const result = await executor.execute({ code: "var chunks=[]; while(true)chunks.push(new Uint8Array(1024*1024).fill(7))", timeoutMs: 5000 });
    assert.equal(result.interruption, "memory-budget");
    assert.equal(executor.status().pid, undefined);
  } finally { await executor.stop(); }
});
