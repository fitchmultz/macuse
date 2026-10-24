#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { release } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const exec = promisify(execFile);
const proofTool = 'macuse_independent_proof';
const resetTool = 'macuse_independent_proof_reset';
const ordinaryField = 'macuse-fixture-field';
const contextField = 'macuse-fixture-context-field';
const unicode = 'prefix 独立 👩🏽‍💻 e\u0301 suffix';
const contextValue = 'postwrite CHANGED';
const safetyNote = 'Owned disposable macuse fixture only: exercise observed radio controls and complete test fields, then restore their captured originals. No user apps, documents, selected-range, keyboard, or pointer actions.';
const artifacts = ['package.json', 'package-lock.json', 'lib/cua-guard-service.mjs', 'lib/app-state.mjs',
  'lib/isolated-executor.mjs', 'tools/isolated-executor.swift', 'lib/independent-proof-session.mjs',
  'lib/independent-proof-session.d.mts', 'lib/independent-proof-tools.mjs', 'lib/independent-proof-jsonl.mjs',
  'extensions/independent-proof.ts', 'tools/independent-proof-cli.mjs', 'tools/independent-proof-mcp.mjs',
  'tools/independent-proof-pi-worker.mjs', 'tools/native-actuator.mjs', 'tools/native-actuator.swift',
  'tools/actuator-fixture.mjs', 'tools/fixtures/actuator-app.swift'];

async function hash(path) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
}
async function sourceHashes(root) {
  return Object.fromEntries(await Promise.all(artifacts.map(async path => [path, await hash(join(root, path))])));
}
function exited(pid) {
  try { process.kill(pid, 0); return false; }
  catch (error) { if (error.code === 'ESRCH') return true; throw error; }
}
function requireExited(workers, boundary) {
  for (const worker of workers) assert.equal(exited(worker.pid), true, `${boundary}: owned worker remains: ${worker.executable}`);
}
async function descendants(pid) {
  const { stdout } = await exec('/bin/ps', ['-axo', 'pid=,ppid=,comm='], { maxBuffer: 4 * 1024 * 1024 });
  const rows = stdout.split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    return match ? [{ pid: Number(match[1]), parent: Number(match[2]), executable: match[3].trim() }] : [];
  });
  const owned = new Set([pid]);
  let previous;
  do {
    previous = owned.size;
    for (const row of rows) if (owned.has(row.parent)) owned.add(row.pid);
  } while (previous !== owned.size);
  const selected = rows.filter(row => row.pid !== pid && owned.has(row.pid));
  for (const row of selected) assert.doesNotMatch(row.executable, /ChatGPT|SkyComputerUseService|node_repl|codex-cli|Codex Computer Use/i, 'Unexpected vendor executable in the owned proof tree');
  const workers = selected.filter(row => /\/macuse\/(isolated-executor\/worker-|actuator-proof\/native-actuator-)/.test(row.executable));
  assert.ok(workers.some(row => row.executable.includes('/isolated-executor/worker-')), 'Actual independent JSC child not observed');
  assert.ok(workers.some(row => row.executable.includes('/actuator-proof/native-actuator-')), 'Actual independent native actuator child not observed');
  return Promise.all(workers.map(async row => ({ ...row, sha256: await hash(row.executable) })));
}

// One outstanding JSONL call per owned process. No replay after timeout or lost acknowledgement.
function jsonlClient(script, args, env, kind) {
  const child = spawn(process.execPath, [script, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let pending, buffered = '', stderr = '';
  const exit = new Promise(resolve => child.once('close', (code, signal) => {
    pending?.reject(new Error(`Proof ${kind} exited before acknowledgement (${signal ?? code}): ${stderr}`));
    resolve({ code, signal, stderr });
  }));
  child.once('error', error => pending?.reject(error));
  child.stdin.on('error', error => pending?.reject(error));
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffered += chunk;
    if (Buffer.byteLength(buffered) > 40_000_000) {
      pending?.reject(new Error('Proof response exceeds the parent image/frame budget; outcome may be unknown.'));
      buffered = ''; child.stdout.pause(); child.kill('SIGTERM'); return;
    }
    let end;
    while ((end = buffered.indexOf('\n')) !== -1) {
      const line = buffered.slice(0, end); buffered = buffered.slice(end + 1);
      if (!pending) { child.kill('SIGTERM'); return; }
      try { pending.resolve(JSON.parse(line)); } catch (error) { pending.reject(error); }
      pending = undefined;
    }
  });
  return {
    pid: child.pid,
    get stderr() { return stderr; },
    call(tool, input) {
      assert.equal(pending, undefined, 'Only one proof call may be outstanding');
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { reject(new Error('Proof response timed out; do not replay.')); child.kill('SIGTERM'); }, 60000);
        pending = { resolve: result => { clearTimeout(timer); resolve(result); }, reject: error => { clearTimeout(timer); reject(error); } };
        child.stdin.write(`${JSON.stringify({ tool, input })}\n`, error => { if (error) pending?.reject(error); });
      });
    },
    async close() {
      child.stdin.end();
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      try {
        const status = await exit;
        assert.equal(status.signal, null, `Proof ${kind} required forced shutdown`);
        assert.ok(status.code === 0 || kind === 'cli' && status.code === 1, `Unexpected ${kind} exit: ${JSON.stringify(status)}`);
        assert.equal(stderr.trim(), '', `Unexpected ${kind} stderr: ${stderr}`);
        return status;
      } finally { clearTimeout(timer); }
    },
  };
}
async function openClient(spec, root, env) {
  if (spec.kind !== 'mcp') return jsonlClient(join(root, 'tools', spec.kind === 'cli' ? 'independent-proof-cli.mjs' : 'independent-proof-pi-worker.mjs'), spec.kind === 'cli' ? ['session'] : [spec.host], env, spec.kind);
  const client = new Client({ name: 'independent-fixture-qualification', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(root, 'tools/independent-proof-mcp.mjs')], env, stderr: 'pipe' });
  let stderr = '';
  transport.stderr.setEncoding('utf8');
  transport.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map(tool => tool.name).sort(), [proofTool, resetTool].sort());
  } catch (error) { await client.close(); throw new Error(`MCP startup failed: ${error.message}; stderr: ${stderr}`); }
  const pid = transport.pid;
  return { pid, get stderr() { return stderr; },
    async call(name, input) {
      const result = await client.callTool({ name, arguments: input }, undefined, { timeout: 60000 });
      return { content: result.content, isError: Boolean(result.isError), details: result._meta };
    },
    async close() {
      await client.close();
      assert.equal(exited(pid), true, 'Owned MCP server did not exit');
      assert.equal(stderr.trim(), '', `Unexpected MCP stderr: ${stderr}`);
      return { exited: true, stderr };
    },
  };
}
function evidence(result) {
  assert.ok(result.details?.independent, 'Missing authoritative proof metadata');
  assert.equal(result.isError, result.details.independent.isError);
  return result.details.independent;
}
function value(result) { return evidence(result).execution.value; }
function visible(result) { return JSON.parse(result.content.find(block => block.type === 'text').text); }
function noMutation(result) {
  assert.equal(result.isError, true);
  const meta = evidence(result);
  assert.ok(meta.nativeActions.every(action => action.mutationAttempted !== true), 'Refused operation attempted native mutation');
}
function imageReceipts(result) {
  const meta = evidence(result);
  assert.equal(meta.images.length, 2);
  assert.equal(result.content.filter(block => block.type === 'image').length, 2);
  for (const receipt of meta.images) {
    const block = result.content[receipt.contentIndex];
    assert.equal(block.type, 'image');
    assert.equal(block.mimeType, receipt.mimeType);
    const bytes = Buffer.from(block.data, 'base64');
    assert.equal(createHash('sha256').update(bytes).digest('hex'), receipt.sha256);
    assert.equal(bytes.length, receipt.bytes);
    assert.equal(bytes.readUInt32BE(16), receipt.width);
    assert.equal(bytes.readUInt32BE(20), receipt.height);
    assert.equal(Math.round(receipt.captureRect.width * receipt.pointPixelScale), receipt.width);
    assert.equal(Math.round(receipt.captureRect.height * receipt.pointPixelScale), receipt.height);
  }
  return meta.images;
}
function state(observation, fixture, original) {
  assert.equal(observation.fullSnapshot, true);
  assert.equal(observation.app.bundleId, fixture.app);
  assert.equal(observation.app.pid, fixture.pid);
  assert.equal(observation.app.path, fixture.path);
  assert.match(observation.app.processStartToken, /^[1-9]\d*:\d+$/);
  assert.equal(observation.windows.length, 1);
  const window = observation.windows[0];
  assert.equal(window.title, fixture.title);
  const selected = observation.elements.filter(element => element.role === 'AXRadioButton' && [true, 1, '1'].includes(element.value));
  assert.equal(selected.length, 1);
  const name = selected[0].description || selected[0].title;
  assert.ok(['CPU', 'Memory', 'Energy'].includes(name));
  const fields = {};
  for (const identifier of [ordinaryField, contextField]) {
    const matches = observation.elements.filter(element => element.identifier === identifier && element.windowToken === window.token);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].role, 'AXTextField');
    assert.equal(typeof matches[0].value, 'string');
    fields[identifier] = matches[0];
  }
  if (original) {
    assert.equal(observation.app.processStartToken, original.birth);
    assert.equal(window.token, original.window.token);
    assert.equal(window.document, original.window.document);
  }
  return { name, fields, window, birth: observation.app.processStartToken };
}
function tab(observation, name) {
  const matches = observation.elements.filter(element => element.role === 'AXRadioButton' && (element.description || element.title) === name);
  assert.equal(matches.length, 1);
  return matches[0];
}
const callCode = (method, params) => `macuse.call(${JSON.stringify(method)},${JSON.stringify(params)})`;

async function qualify(spec, root, NativeActuator, startFixture) {
  const checks = [], failures = [], workers = new Map();
  const observer = new NativeActuator();
  let fixture, client, original, clientClosed = false;
  const pass = (name, detail) => checks.push({ name, status: 'pass', ...(detail ? { detail } : {}) });
  const rememberWorkers = async () => {
    const current = await descendants(client.pid);
    for (const worker of current) workers.set(worker.pid, worker);
    return current;
  };
  const observeActual = async () => {
    const observation = await observer.observe({ app: fixture.app, expectedPid: fixture.pid, expectedPath: fixture.path,
      ...(original ? { expectedProcessStartToken: original.birth } : {}) });
    return { observation, current: state(observation, fixture, original) };
  };
  try {
    fixture = await startFixture();
    original = (await observeActual()).current;
    pass('operator-owned original state captured', { selectedTab: original.name, birth: original.birth });
    const alternate = original.name === 'Memory' ? 'Energy' : 'Memory';
    const env = { ...process.env, PI_OFFLINE: '1', MACUSE_CHATGPT_RESOURCES: '/no-vendor-installation-in-independent-proof',
      MACUSE_INDEPENDENT_PROOF_TARGET: JSON.stringify({ bundleId: fixture.app, pid: fixture.pid, path: fixture.path, windowTitle: fixture.title }) };
    client = await openClient(spec, root, env);
    const run = (code, mutate = false, timeoutMs = 10000) => client.call(proofTool, { code, apps: [fixture.app], timeoutMs,
      ...(mutate ? { allowMutating: true, safetyNote } : {}) });
    const observe = async () => {
      const result = await run(`var retainedProof=41; var proofState=${callCode('observe', { app: fixture.app })}; proofState`);
      assert.equal(result.isError, false);
      state(value(result), fixture);
      return value(result);
    };
    const act = async (observation, element, action, fieldValue) => {
      const result = await run(callCode('act', { app: fixture.app, observationId: observation.observationId,
        elementToken: element.token, action, ...(action === 'setValue' ? { value: fieldValue } : {}) }), true);
      assert.equal(result.isError, false, result.content[0]?.text);
      const accepted = evidence(result).nativeActions.find(item => item.method === 'act');
      assert.equal(accepted.mutationAttempted, true);
      assert.equal(accepted.nativeAccepted, true);
      assert.ok(visible(result).nativeEvidence.some(item => item.action === action && item.outcome === accepted.outcome));
      return accepted;
    };
    const deniedScope = await run(`${callCode('observe', { app: 'not.the.owned.fixture' })};42`);
    noMutation(deniedScope);
    assert.match(visible(deniedScope).nativeEvidence[0].error, /trusted target/);
    let observation = await observe();
    const old = { observationId: observation.observationId, elementToken: tab(observation, alternate).token };
    const deniedFlags = await run(callCode('act', { app: fixture.app, ...old, action: 'press' }));
    noMutation(deniedFlags);
    assert.ok(evidence(deniedFlags).execution.actions.some(action => action.method === 'act' && action.dispatched === false));
    assert.equal((await observeActual()).current.name, original.name);
    pass('wrong app and missing parent mutation flags refused without native effect');

    observation = await observe();
    const imageCall = callCode('screenshot', { app: fixture.app, observationId: observation.observationId, windowToken: observation.windows[0].token });
    const captures = await run(`var firstImage=${imageCall};var secondImage=${imageCall};var refusedImage=${imageCall};({firstImage,secondImage,refusedImage})`);
    noMutation(captures);
    assert.equal(value(captures).refusedImage.status, 'refused');
    const images = imageReceipts(captures);
    pass('two parent PNG images survive third-capture refusal through public transport', images);

    observation = await observe();
    const pressed = await act(observation, tab(observation, alternate), 'press');
    assert.equal(pressed.verified, false);
    assert.equal(pressed.outcome, 'requires-fresh-observation');
    assert.equal((await observeActual()).current.name, alternate);
    pass('AXPress remains explicitly unverified until independently observed');
    observation = await observe();
    const ordinary = state(observation, fixture).fields[ordinaryField];
    assert.equal((await act(observation, ordinary, 'setValue', unicode)).verified, true);
    assert.equal((await observeActual()).current.fields[ordinaryField].value, unicode);
    pass('Unicode whole-field value independently observed');
    const deadlineWorkers = await rememberWorkers();
    pass('actual owned native and independent JSC process artifacts observed', deadlineWorkers);

    const deadline = await run('while(true){}', false, 100);
    assert.equal(deadline.isError, true);
    assert.equal(evidence(deadline).execution.interruption, 'deadline');
    requireExited(deadlineWorkers, 'Immediately after deadline, before recovery');
    const unchanged = (await observeActual()).current;
    assert.equal(unchanged.name, alternate);
    assert.equal(unchanged.fields[ordinaryField].value, unicode);
    observation = await observe();
    assert.equal(value(await run('retainedProof+1')), 42, 'Native observation must retain bindings before reset');
    const beforeReset = { observationId: observation.observationId, elementToken: tab(observation, alternate).token };
    assert.equal((await client.call(resetTool, {})).isError, false);
    assert.equal(value(await run('typeof retainedProof')), 'undefined');
    const staleAfterReset = await run(callCode('act', { app: fixture.app, ...beforeReset, action: 'press' }), true);
    noMutation(staleAfterReset);
    assert.match(evidence(staleAfterReset).nativeActions[0].error, /fresh same-session native observation/);
    pass('actual deadline and reset clear execution/observation state without replay');

    observation = await observe();
    const changing = state(observation, fixture).fields[contextField];
    const unknownWorkers = await rememberWorkers();
    const unknown = await run(`${callCode('act', { app: fixture.app, observationId: observation.observationId, elementToken: changing.token,
      action: 'setValue', value: contextValue })};42`, true);
    assert.equal(unknown.isError, true);
    assert.equal(evidence(unknown).priorUnknown, true);
    requireExited(unknownWorkers, 'Immediately after unknown response, before recovery');
    assert.ok(visible(unknown).nativeEvidence.some(item => item.mutationAttempted && item.outcome === 'unknown' && item.verified !== true));
    const changed = (await observeActual()).current;
    assert.equal(changed.fields[contextField].value, contextValue);
    assert.equal(changed.name, 'CPU');
    observation = await observe();
    noMutation(await run(callCode('act', { app: fixture.app, observationId: observation.observationId,
      elementToken: state(observation, fixture).fields[ordinaryField].token, action: 'setValue', value: 'DO NOT WRITE' }), true));
    assert.equal((await observeActual()).current.fields[ordinaryField].value, unicode);
    const reset = await client.call(resetTool, {});
    assert.equal(reset.isError, false);
    assert.equal(evidence(reset).priorUnknown, true);
    assert.match(reset.content[0].text, /prior.*unknown/i);
    pass('real context-changing setter retains attempted/unknown, blocks further mutation and survives reset');

    for (const identifier of [contextField, ordinaryField]) {
      observation = await observe();
      const current = state(observation, fixture).fields[identifier];
      const allowed = identifier === contextField ? [original.fields[identifier].value, contextValue] : [original.fields[identifier].value, unicode];
      assert.ok(allowed.includes(current.value), 'Unexpected fixture field value; refusing public restoration overwrite');
      if (current.value !== original.fields[identifier].value) await act(observation, current, 'setValue', original.fields[identifier].value);
    }
    observation = await observe();
    if (state(observation, fixture).name !== original.name) await act(observation, tab(observation, original.name), 'press');
    const final = (await observeActual()).current;
    assert.equal(final.name, original.name);
    for (const identifier of [ordinaryField, contextField]) assert.equal(final.fields[identifier].value, original.fields[identifier].value);
    pass('original fields and actual radio selection restored through public transport');
    const finalWorkers = await rememberWorkers();
    const finalReset = await client.call(resetTool, {});
    assert.equal(finalReset.isError, false);
    const settlement = evidence(finalReset).settlement;
    assert.equal(settlement.settled, true);
    assert.equal(settlement.workerStopped, true);
    assert.equal(settlement.nativeStopped, true);
    assert.equal(settlement.hostCallsPending, 0);
    requireExited(finalWorkers, 'Immediately after final public reset');
    pass('final public reset reports settled owned work', settlement);
    const close = await client.close(); clientClosed = true;
    requireExited(workers.values(), 'After transport close');
    pass('owned transport/executor/native workers exited', { close, workers: [...workers.values()] });
  } catch (error) { failures.push(String(error?.message ?? error)); }
  finally {
    if (client && !clientClosed) {
      try { await client.close(); } catch (error) { failures.push(`Transport cleanup failed: ${error.message}`); }
    }
    if (fixture && original) {
      try {
        // Failure cleanup is a fresh bounded original-value restoration, never an attempted-value replay.
        for (const identifier of [contextField, ordinaryField]) {
          let { observation, current } = await observeActual();
          const allowed = identifier === contextField ? [original.fields[identifier].value, contextValue] : [original.fields[identifier].value, unicode];
          assert.ok(allowed.includes(current.fields[identifier].value), 'Unexpected fixture field value; refusing cleanup overwrite');
          if (current.fields[identifier].value === original.fields[identifier].value) continue;
          if (identifier === contextField && current.name !== 'CPU') {
            await observer.act({ app: fixture.app, observationId: observation.observationId, elementToken: tab(observation, 'CPU').token, action: 'press', allowMutating: true, safetyNote });
            ({ observation, current } = await observeActual());
          }
          const restored = await observer.act({ app: fixture.app, observationId: observation.observationId, elementToken: current.fields[identifier].token,
            action: 'setValue', value: original.fields[identifier].value, allowMutating: true, safetyNote });
          assert.equal(restored.verified, true);
        }
        let { observation, current } = await observeActual();
        if (current.name !== original.name) {
          await observer.act({ app: fixture.app, observationId: observation.observationId, elementToken: tab(observation, original.name).token, action: 'press', allowMutating: true, safetyNote });
          ({ current } = await observeActual());
        }
        assert.equal(current.name, original.name);
        for (const identifier of [ordinaryField, contextField]) assert.equal(current.fields[identifier].value, original.fields[identifier].value);
        pass('independent final original-state verification');
      } catch (error) { failures.push(`Original-state cleanup failed: ${error.message}`); }
    }
    try { await observer.stop(); } catch (error) { failures.push(`Observer stop failed: ${error.message}`); }
    if (fixture) {
      try { await fixture.stop(); assert.equal(exited(fixture.pid), true, 'Owned fixture remains running'); pass('owned fixture exited'); }
      catch (error) { failures.push(`Fixture stop failed: ${error.message}`); }
    }
  }
  return { transport: spec.name, ...(spec.host ? { host: spec.host } : {}), ok: failures.length === 0, transportStderr: client?.stderr ?? '', checks,
    failures, fullIndependenceQualified: false };
}

async function main() {
  const { values } = parseArgs({ options: { live: { type: 'boolean' }, 'package-root': { type: 'string' },
    'official-pi': { type: 'string' }, 'fork-pi': { type: 'string' }, help: { type: 'boolean', short: 'h' } } });
  if (values.help || !values.live) {
    console.log('Usage: node tools/qualify-independent-proof.mjs --live --package-root ROOT --official-pi PI_PACKAGE_DIR --fork-pi PI_PACKAGE_DIR\nExplicit research-only owned AppKit fixture qualification through real CLI/MCP/official-Pi/fork-Pi tool paths. Without --live, no desktop access. Uses/restores only owned fixture fields and radio controls; no user apps, recording/history, selected-range, keyboard/pointer or full-independence claim.');
    if (!values.help) process.exitCode = 1;
    return;
  }
  assert.equal(process.platform, 'darwin', 'Live independent qualification requires macOS');
  assert.ok(values['official-pi'] && values['fork-pi'], 'Both exact official and fork Pi package directories are required');
  const root = resolve(values['package-root'] ?? fileURLToPath(new URL('..', import.meta.url)));
  const before = await sourceHashes(root);
  const qualifierSourceSha256 = await hash(fileURLToPath(import.meta.url));
  const { NativeActuator } = await import(pathToFileURL(join(root, 'tools/native-actuator.mjs')).href);
  const { startActuatorFixture } = await import(pathToFileURL(join(root, 'tools/actuator-fixture.mjs')).href);
  const specs = [{ kind: 'cli', name: 'CLI JSONL' }, { kind: 'mcp', name: 'MCP stdio' },
    { kind: 'pi', name: 'official Pi public SDK tools', host: resolve(values['official-pi']) },
    { kind: 'pi', name: 'fork Pi public SDK tools', host: resolve(values['fork-pi']) }];
  const results = [];
  for (const spec of specs) results.push(await qualify(spec, root, NativeActuator, startActuatorFixture));
  const after = await sourceHashes(root);
  const unchanged = JSON.stringify(before) === JSON.stringify(after) && qualifierSourceSha256 === await hash(fileURLToPath(import.meta.url));
  const hosts = await Promise.all(specs.filter(spec => spec.host).map(async spec => ({ name: spec.name, path: spec.host,
    version: JSON.parse(await readFile(join(spec.host, 'package.json'), 'utf8')).version,
    packageManifestSha256: await hash(join(spec.host, 'package.json')) })));
  const report = { ok: unchanged && results.every(result => result.ok), scope: 'owned-fixture-independent-core-through-public-transports',
    fullIndependenceQualified: false, sourceUnchanged: unchanged, qualifierSourceSha256, sourceHashes: before,
    node: { path: process.execPath, version: process.version }, os: { platform: process.platform, arch: process.arch, release: release(),
      macOS: (await exec('/usr/bin/sw_vers')).stdout.trim() }, hosts, results,
    unattempted: ['General-app and Activity Monitor compatibility', 'Selected-range insertion', 'Visual screenshot content and pointer-coordinate action mapping', 'Keyboard/pointer/focus and transition coverage',
      'Record & Replay and Computer History independence', 'Independent pinning of Apple system JavaScriptCore', 'Production signed helper deployment/default migration'] };
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}
main().catch(error => { console.error(`Independent qualification failed: ${error.message}`); process.exitCode = 1; });
