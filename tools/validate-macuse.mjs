#!/usr/bin/env node
import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { MacuseSession } from '../lib/macuse-session.mjs';
import { tools } from '../lib/tools.mjs';
import { VERSION } from './macuse-utils.mjs';

const checked = result => {
  assert.equal(result.isError, false, result.content.filter(p => p.type === 'text').map(p => p.text).join('\n'));
  return result;
};
const selectedTab = observation => {
  const selected = observation?.elements.filter(e => e.role === 'radio button' && e.value === '1' && ['CPU', 'Memory', 'Energy', 'Disk', 'Network'].includes(e.description ?? e.name));
  return selected?.length === 1 ? selected[0].description ?? selected[0].name : undefined;
};

export async function activityMonitorCheck(session, { strictFocus = false, timeoutMs = 90000 } = {}) {
  const app = 'Activity Monitor', results = [], failures = [];
  let original, attempted = false;
  const call = async code => {
    const result = await session.callTool('macuse', { code, apps: [app], allowMutating: true, safetyNote: 'Activity Monitor only: select a tab and restore its original selection; never Stop, Inspector, Actions, or terminate processes.', timeoutMs });
    results.push(result);
    return checked(result);
  };
  const read = () => call('await activity.getAXState()');
  const tab = name => {
    const matches = session.runtime.getObservation(app)?.elements.filter(e => e.role === 'radio button' && (e.description ?? e.name) === name);
    assert.equal(matches?.length, 1, `Expected one ${name} tab`);
    return matches[0];
  };
  const press = async name => {
    const target = tab(name);
    return call(`await activity.performSecondaryAction(${Number(target.index)}, "Press"); await activity.getAXState()`);
  };
  const checkFocus = result => {
    const f = result.details.macuse.focus;
    assert.ok(f?.observationAvailable && f.coverage.applicationActivation && !f.coverage.truncated && f.before?.frontmost && f.after?.frontmost, 'Native activation coverage unavailable; background behavior is unproven');
    const target = a => a?.bundleId === 'com.apple.ActivityMonitor';
    assert.equal(target(f.before.frontmost), false, 'Activity Monitor is already frontmost; background behavior is unproven');
    assert.equal(target(f.after.frontmost) || f.transitions.some(e => e.kind === 'activation' && target(e.app)), false, 'Activity Monitor activation observed; attribution unknown');
  };
  try {
    const first = await call('var activity = await cua.getApp("Activity Monitor")');
    original = selectedTab(session.runtime.getObservation(app));
    assert.ok(original, 'Original Activity Monitor tab is unknown; no mutation performed');
    if (strictFocus) checkFocus(first);
    const alternate = original === 'Memory' ? 'CPU' : 'Memory';
    tab(alternate);
    attempted = true;
    await press(alternate);
    assert.equal(selectedTab(session.runtime.getObservation(app)), alternate);
  } catch (error) { failures.push(error); }
  finally {
    if (original && attempted) {
      try {
        await read();
        if (selectedTab(session.runtime.getObservation(app)) !== original) await press(original);
        assert.equal(selectedTab(session.runtime.getObservation(app)), original, 'Original tab was not restored');
      } catch (error) { failures.push(new Error(`Activity Monitor cleanup failed: ${error.message}`)); }
    }
  }
  if (strictFocus) for (const result of results) { try { checkFocus(result); } catch (error) { failures.push(error); } }
  if (failures.length) throw new AggregateError(failures, failures.map(e => e.message).join('; '));
  return { originalTab: original, restored: true, inputAttribution: 'unknown', operations: results.map(r => r.details.macuse) };
}

async function mcpCheck({ live = false, timeoutMs = 90000 } = {}) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('./macuse-mcp.mjs', import.meta.url))], stderr: 'pipe' });
  const client = new Client({ name: 'macuse-validation', version: VERSION });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map(t => t.name).sort(), tools.map(t => t.name).sort());
    for (const [name, args] of [['macuse_insert_text', { app: 'must-not-launch', text: 'must-not-insert' }], ['event_stream_start', {}], ['computer_history_update_settings', {}]]) {
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.isError, true);
      assert.equal(result._meta.macuse.dispatched, false);
    }
    if (live) checked(await client.callTool({ name: 'macuse', arguments: { code: 'await cua.getState()', timeoutMs, trackFocus: false } }, undefined, { timeout: timeoutMs + 10000 }));
    return { tools: listed.tools.length, live };
  } finally { await client.close(); }
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { json: { type: 'boolean' }, verbose: { type: 'boolean' }, app: { type: 'string', default: 'Activity Monitor' }, 'tool-timeout-ms': { type: 'string', default: '90000' }, help: { type: 'boolean', short: 'h' } } });
  const mode = positionals[0] ?? 'quick';
  if (values.help) { console.log('macuse validation: extension (offline) | quick | read-only | mutating | focus | mcp\nmutating/focus select an Activity Monitor tab and restore the captured original in finally. No recording/privacy changes.'); return; }
  assert.ok(['extension', 'quick', 'read-only', 'mutating', 'focus', 'mcp'].includes(mode), `Unknown mode: ${mode}`);
  const timeoutMs = Number(values['tool-timeout-ms']);
  assert.ok(Number.isInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 300000, 'Invalid timeout');
  const checks = [];
  const check = async (name, run) => {
    const detail = await run();
    checks.push({ name, status: 'pass', detail });
    if (!values.json) console.log(`PASS ${name}`);
  };
  const session = new MacuseSession();
  try {
    if (mode === 'extension') {
      await check('Pi extension contract (no desktop)', () => {
        const result = spawnSync(process.execPath, ['--test', 'tools/tests/pi-extension.test.mjs'], { encoding: 'utf8', env: { ...process.env, PI_OFFLINE: '1' }, timeout: 60000 });
        assert.equal(result.status, 0, result.stderr + result.stdout);
        return 'Registration, lifecycle, partial error flags, scoped original-image restoration';
      });
      await check('MCP schemas and pre-dispatch refusal', () => mcpCheck());
    } else {
      await check('Native persistent JavaScript', async () => {
        checked(await session.callTool('macuse', { code: 'var macuseProbe = 41; nodeRepl.write(macuseProbe)', trackFocus: false, timeoutMs }));
        const result = checked(await session.callTool('macuse', { code: 'nodeRepl.write(macuseProbe + 1)', trackFocus: false, timeoutMs }));
        assert.match(result.content.map(p => p.text ?? '').join('\n'), /42/);
        return session.status();
      });
      await check('Native computer-only inventory', async () => checked(await session.callTool('macuse', { code: 'var inventory = await cua.getState(); if (inventory.browsers.length) throw new Error("Unexpected browser surface")', trackFocus: false, timeoutMs })).details);
      if (mode === 'read-only') {
        await check('Native app state and image', async () => {
          checked(await session.callTool('macuse', { code: `var inspected = await cua.getApp(${JSON.stringify(values.app)})`, apps: [values.app], timeoutMs }));
          const result = checked(await session.callTool('macuse', { code: 'await inspected.getAXStateAndScreenshot()', apps: [values.app], timeoutMs }));
          assert.ok(result.content.some(p => p.type === 'image'), 'No screenshot returned');
          assert.ok(session.runtime.getObservation(values.app)?.title, 'No parsed window title');
          return result.details;
        });
      }
      if (['mutating', 'focus'].includes(mode)) await check('Activity Monitor tab restoration', () => activityMonitorCheck(session, { strictFocus: mode === 'focus', timeoutMs }));
      if (mode === 'mcp') await check('MCP live native runtime', () => mcpCheck({ live: true, timeoutMs }));
    }
  } catch (error) { checks.push({ name: 'Validation failure', status: 'fail', detail: error.message }); }
  finally { await session.stop(); }
  const ok = checks.every(c => c.status === 'pass');
  const report = { ok, mode, generatedAt: new Date().toISOString(), counts: { pass: checks.filter(c => c.status === 'pass').length, warn: 0, fail: checks.filter(c => c.status === 'fail').length }, checks };
  if (values.json) console.log(JSON.stringify(report, null, 2));
  else if (!ok) console.error(checks.at(-1).detail);
  if (!ok) process.exitCode = 1;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch(error => { console.error(error); process.exitCode = 1; });
