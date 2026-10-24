import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Launch a task-owned real app. This is never a user's existing editor or Activity Monitor. */
export async function startActuatorFixture() {
  if (process.platform !== 'darwin') throw new Error('The actuator fixture requires macOS.');
  const directory = await mkdtemp(join(tmpdir(), 'macuse-actuator-fixture-'));
  const app = `com.macuse.actuator-fixture.${randomUUID()}`;
  const contents = join(directory, 'ActuatorFixture.app', 'Contents');
  const binary = join(contents, 'MacOS', 'ActuatorFixture');
  let child;
  let closing;
  const stop = () => closing ??= (async () => {
    if (child && child.exitCode === null && child.signalCode === null) await new Promise(resolve => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 1000);
      child.once('close', () => { clearTimeout(timer); resolve(); });
      child.kill('SIGTERM');
    });
    await rm(directory, { recursive: true, force: true });
  })();
  try {
    await mkdir(join(contents, 'MacOS'), { recursive: true });
    await writeFile(join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${app}</string><key>CFBundleName</key><string>macuse actuator fixture</string><key>CFBundleExecutable</key><string>ActuatorFixture</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`);
    await new Promise((resolve, reject) => {
      const compiler = spawn('/usr/bin/xcrun', ['swiftc', fileURLToPath(new URL('./fixtures/actuator-app.swift', import.meta.url)), '-o', binary], { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      const timer = setTimeout(() => compiler.kill('SIGKILL'), 60_000);
      compiler.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8000); });
      compiler.once('error', error => { clearTimeout(timer); reject(error); });
      compiler.once('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`Fixture compilation failed: ${stderr}`)); });
    });
    child = spawn(binary, [], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
    await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('Fixture startup timed out.')), 10_000);
      const finish = error => { clearTimeout(timer); child.stdout.removeAllListeners('data'); error ? reject(error) : resolve(); };
      child.once('error', finish);
      child.once('close', () => finish(new Error(`Fixture exited before ready: ${stderr}`)));
      child.stdout.on('data', chunk => {
        output += chunk.toString();
        if (output.length > 4000) return finish(new Error('Fixture startup output exceeds budget.'));
        if (output.includes('\n')) {
          try {
            const receipt = JSON.parse(output.split('\n')[0]);
            finish(receipt.ready === true && receipt.pid === child.pid ? undefined : new Error('Fixture identity receipt did not match owned process.'));
          } catch (error) { finish(error); }
        }
      });
    });
    return { app, pid: child.pid, title: 'macuse disposable actuator fixture', stop };
  } catch (error) { await stop(); throw error; }
}
