#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { findPackageJSON } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tools } from '../../lib/tools.mjs';

const root = process.argv[2] ? resolve(process.argv[2]) : dirname(findPackageJSON('@earendil-works/pi-coding-agent', import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const extension = fileURLToPath(new URL('../../extensions/macuse.ts', import.meta.url));
const directory = mkdtempSync(join(tmpdir(), 'macuse-cli-'));
try {
  const observer = join(directory, 'observe.ts');
  const observation = join(directory, 'observation.json');
  cpSync(fileURLToPath(new URL('./ci-observer.ts', import.meta.url)), observer);
  const result = spawnSync(process.execPath, [join(root, manifest.bin.pi), '--offline', '--mode', 'rpc', '-ne', '-ns', '-np', '-nc',
    '--no-themes', '--no-approve', '--no-session', '-e', extension, '-e', observer], {
    cwd: directory,
    env: { ...process.env, PI_OFFLINE: '1', PI_TELEMETRY: '0', MACUSE_CI_OBSERVATION: observation },
    encoding: 'utf8',
    input: `${JSON.stringify({ id: 'macuse-ci', type: 'prompt', message: '/macuse-ci-probe' })}\n`,
    timeout: 45_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const events = result.stdout.split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.deepEqual(events.filter(event => event.type === 'extension_error'), [], 'Pi extension startup failed');
  assert.ok(events.some(event => event.id === 'macuse-ci' && event.type === 'response' && event.success === true), 'Probe command did not complete');
  assert.ok(!events.some(event => event.type === 'agent_start'), 'Probe started a model turn');
  const observed = JSON.parse(readFileSync(observation, 'utf8'));
  assert.equal(realpathSync(observed.packageDir), realpathSync(root), 'The wrong Pi host loaded');
  assert.equal(observed.version, manifest.version);
  const expectedTools = [...tools.map(tool => tool.name), 'macuse_tools'];
  assert.deepEqual(observed.tools.filter(name => expectedTools.includes(name)).sort(), expectedTools.sort(), 'macuse tools were not all registered');
  for (const name of ['macuse', 'macuse_insert_text', 'macuse_reset', 'macuse_tools']) {
    assert.ok(observed.activeTools.includes(name), `${name} was not active`);
  }
  assert.ok(observed.commands.includes('macuse-status'), 'macuse commands were not registered');
  console.log(JSON.stringify({ host: observed.packageDir, version: observed.version, activeTools: observed.activeTools.filter(name => name.startsWith('macuse')) }));
} finally {
  rmSync(directory, { recursive: true, force: true });
}
