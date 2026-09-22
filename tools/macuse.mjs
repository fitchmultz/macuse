#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { MacuseSession } from '../lib/macuse-session.mjs';
import { tools } from '../lib/tools.mjs';
import { VERSION } from './macuse-utils.mjs';

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { help: { type: 'boolean', short: 'h' }, pretty: { type: 'boolean' }, file: { type: 'string' }, out: { type: 'string' } } });
  const [command = 'help', tool = 'macuse', json = '{}'] = positionals;
  if (values.help || command === 'help') {
    console.log(`macuse ${VERSION}\n\nUsage:\n  macuse tools [--pretty]\n  macuse status\n  macuse call <tool> '<JSON arguments>' [--file code.js] [--out result.json]\n  macuse session\n\nSession input: one {"tool":"macuse","input":{"code":"await cua.getState()"}} per line.\nBindings and observations persist only within that process. --file supplies macuse's code.\nTool schemas describe mutation gates; no automatic replay after cancellation.\n`);
    return;
  }
  const print = async value => {
    const text = `${JSON.stringify(value, null, values.pretty ? 2 : 0)}\n`;
    if (values.out) await writeFile(values.out, text, { flag: 'wx' });
    else process.stdout.write(text);
  };
  if (command === 'tools') return print(tools);
  if (!['call', 'session', 'status'].includes(command)) throw new Error(`Unknown command: ${command}`);
  if (command === 'session' && (values.out || values.file)) throw new Error('session does not accept --out or --file');
  const session = new MacuseSession();
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    if (command === 'status') return await print(session.status());
    const call = async (name, input) => {
      const result = await session.callTool(name, input, { signal: controller.signal });
      await print(result);
      if (result.isError) process.exitCode = 1;
    };
    if (command === 'call') {
      const input = JSON.parse(json);
      if (values.file) {
        if (tool !== 'macuse') throw new Error('--file is only valid for macuse JavaScript');
        input.code = await readFile(values.file, 'utf8');
      }
      await call(tool, input);
    } else {
      const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
      controller.signal.addEventListener('abort', () => lines.close(), { once: true });
      for await (const line of lines) {
        if (!line.trim()) continue;
        const request = JSON.parse(line);
        await call(request.tool, request.input);
        if (controller.signal.aborted) break;
      }
    }
  } finally {
    await session.stop();
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}
main().catch(error => { console.error(`macuse: ${error.message}`); process.exitCode = 1; });
