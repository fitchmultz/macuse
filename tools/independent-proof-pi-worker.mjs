#!/usr/bin/env node
// Real selected-host tool execution; only model-generated calls are scripted.
import assert from 'node:assert/strict';
import { findPackageJSON } from 'node:module';
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readProofLines } from '../lib/independent-proof-jsonl.mjs';

if (process.argv.includes('--help') || !process.argv[2]) {
  console.log('Usage: node tools/independent-proof-pi-worker.mjs PI_PACKAGE_DIR\nLF JSONL {tool,input} -> actual selected Pi ToolResult. Loads only the opt-in proof extension; scripts provider tool calls, never native results. Set MACUSE_INDEPENDENT_PROOF_TARGET outside guest code for GUI calls.');
  process.exit(process.argv.includes('--help') ? 0 : 1);
}
globalThis.fetch = async () => { throw new Error('Unexpected network in independent Pi proof'); };
const host = resolve(process.argv[2]);
process.env.PI_PACKAGE_DIR = host;
const hostURL = pathToFileURL(join(host, 'package.json')).href;
const ai = dirname(findPackageJSON('@earendil-works/pi-ai', hostURL));
const load = (root, file) => import(pathToFileURL(join(root, file)).href);
const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await load(host, 'dist/index.js');
const { fauxProvider, fauxAssistantMessage, InMemoryCredentialStore, InMemoryModelsStore } = await load(ai, 'dist/index.js');
const scratch = await mkdtemp(join(tmpdir(), 'macuse-independent-pi-'));
let session, interrupted = false;
const cancel = () => { interrupted = true; process.stdin.destroy(); void session?.abort(); };
process.once('SIGINT', cancel);
process.once('SIGTERM', cancel);
try {
  const source = fileURLToPath(new URL('..', import.meta.url));
  for (const path of ['extensions', 'lib', 'tools', 'package.json']) await cp(join(source, path), join(scratch, path), { recursive: true });
  for (const [name, target] of [
    ['@earendil-works/pi-coding-agent', host],
    ['@earendil-works/pi-ai', ai],
    ['typebox', dirname(findPackageJSON('typebox', hostURL))],
    ['@modelcontextprotocol/sdk', dirname(findPackageJSON('@modelcontextprotocol/sdk', import.meta.url))],
  ]) {
    const link = join(scratch, 'node_modules', name);
    await mkdir(dirname(link), { recursive: true });
    await symlink(target, link, 'dir');
  }
  const faux = fauxProvider({ provider: 'independent-native-proof', tokensPerSecond: 1000000, models: [{ id: 'fixture', input: ['text', 'image'] }] });
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  await modelRuntime.refresh({ providers: [faux.provider.id], allowNetwork: false });
  const resourceLoader = new DefaultResourceLoader({ cwd: scratch, agentDir: scratch,
    noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    additionalExtensionPaths: [join(scratch, 'extensions/independent-proof.ts')],
  });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  ({ session } = await createAgentSession({ cwd: scratch, agentDir: scratch, modelRuntime, model: faux.getModel(), resourceLoader,
    sessionManager: SessionManager.inMemory(scratch), tools: ['macuse_independent_proof', 'macuse_independent_proof_reset'],
    settingsManager: SettingsManager.inMemory({ images: { autoResize: false }, compaction: { enabled: false }, retry: { enabled: false } }),
  }));
  await session.bindExtensions({ onError: error => { throw new Error(error.error); } });
  let sequence = 0;
  for await (const line of readProofLines(process.stdin)) {
    if (interrupted) break;
    const { tool, input } = JSON.parse(line);
    const id = `independent-proof-${++sequence}`;
    faux.setResponses([
      fauxAssistantMessage([{ type: 'toolCall', id, name: tool, arguments: input }], { stopReason: 'toolUse' }),
      fauxAssistantMessage('Proof tool returned.'),
    ]);
    await session.prompt('Execute the supplied bounded qualification call.');
    const result = session.messages.find(message => message.role === 'toolResult' && message.toolCallId === id);
    assert.ok(result, 'Actual Pi tool execution did not return a correlated result');
    process.stdout.write(`${JSON.stringify({ content: result.content, isError: result.isError, details: result.details })}\n`);
  }
} finally {
  try {
    if (session) {
      try { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); }
      finally { session.dispose(); }
    }
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
    await rm(scratch, { recursive: true, force: true });
  }
}
