#!/usr/bin/env node
// Credential-free probes of the installed host's real hooks, image normalizer and Responses adapters.
import assert from 'node:assert/strict';
import { findPackageJSON } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { crc32, deflateSync, zstdDecompressSync } from 'node:zlib';
import { createJiti } from 'jiti';

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log('Usage: node tools/validate-pi-host.mjs [PI_PACKAGE_DIR] [MACUSE_PACKAGE_DIR]\nOffline SDK, image-normalization and Responses-adapter checks.\nExample: node tools/validate-pi-host.mjs /tmp/pi/node_modules/@earendil-works/pi-coding-agent /tmp/packed/package\nExit: 0 checks passed; 1 validation failure.');
  process.exit(0);
}
globalThis.fetch = async () => { throw new Error('Unexpected network in offline Pi probe'); };
const root = process.argv[2] ? resolve(process.argv[2]) : dirname(findPackageJSON('@earendil-works/pi-coding-agent', import.meta.url));
process.env.PI_PACKAGE_DIR = root;
const ai = dirname(findPackageJSON('@earendil-works/pi-ai', pathToFileURL(join(root, 'package.json')).href));
const load = (base, file) => import(pathToFileURL(join(base, file)).href);
const { createAgentSession, convertToLlm, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await load(root, 'dist/index.js');
const { fauxProvider, fauxAssistantMessage, InMemoryCredentialStore, InMemoryModelsStore, normalizeContext } = await load(ai, 'dist/index.js');
const { openaiProvider } = await load(ai, 'dist/providers/openai.js');
const { openaiCodexProvider } = await load(ai, 'dist/providers/openai-codex.js');
const jiti = createJiti(import.meta.url);
const { default: extension } = await jiti.import(process.argv[3] ? join(resolve(process.argv[3]), 'extensions/macuse.ts') : '../extensions/macuse.ts');

function png(width, height) {
  const chunk = (name, bytes) => { const data = Buffer.concat([Buffer.from(name), bytes]), length = Buffer.alloc(4), crc = Buffer.alloc(4); length.writeUInt32BE(bytes.length); crc.writeUInt32BE(crc32(data)); return Buffer.concat([length, data, crc]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.alloc((width * 4 + 1) * height))), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}
const content = [{ type: 'text', text: 'Controlled synthetic image' }, { type: 'image', mimeType: 'image/png', data: png(4000, 3000) }];
const details = { macuse: { isError: true, originalContent: content, actions: [{ dispatched: true, outcome: 'unknown' }] } };
const call = { type: 'toolCall', name: 'macuse', id: 'call_image|fc_image', arguments: { code: 'synthetic fixture only' } };
// Astra is a user-configured route, not guaranteed to be in the host catalog.
const model = { ...openaiProvider().getModels().find(model => model.api === 'openai-responses' && model.input.includes('image')), id: 'gpt-6-astra' };
assert.ok(model.api, 'Installed host has no Responses image model');
const scratch = await mkdtemp(join(tmpdir(), 'macuse-host-'));
const faux = fauxProvider({ provider: 'macuse-image-probe', tokensPerSecond: 1000000, models: [{ id: 'fixture', input: ['text', 'image'] }] });
faux.setResponses([fauxAssistantMessage(call, { stopReason: 'toolUse' }), fauxAssistantMessage('Observed synthetic image')]);
const credentials = new InMemoryCredentialStore();
const modelRuntime = await ModelRuntime.create({ credentials, modelsStore: new InMemoryModelsStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
modelRuntime.registerNativeProvider(faux.provider);
await modelRuntime.refresh({ providers: [faux.provider.id], allowNetwork: false });
const tools = [];
const resourceLoader = new DefaultResourceLoader({ cwd: scratch, agentDir: scratch,
  noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
  extensionFactories: [pi => extension({ ...pi, registerTool(tool) {
    tools.push(tool);
    // Synthetic tool output isolates Pi's real result hooks and image normalization from the desktop.
    pi.registerTool(tool.name === 'macuse' ? { ...tool, execute: async () => ({ content, details }) } : tool);
  } })],
});
await resourceLoader.reload();
assert.deepEqual(resourceLoader.getExtensions().errors, []);
const sm = SessionManager.inMemory(scratch);
const { session } = await createAgentSession({ cwd: scratch, agentDir: scratch, modelRuntime, model: faux.getModel(), resourceLoader,
  sessionManager: sm, tools: ['macuse'], settingsManager: SettingsManager.inMemory({ images: { autoResize: true }, compaction: { enabled: false }, retry: { enabled: false } }) });
try {
  await session.bindExtensions({ onError: error => { throw new Error(error.error); } });
  await session.prompt('Return the controlled synthetic image.');
  const normalized = session.messages.find(message => message.role === 'toolResult' && message.toolName === 'macuse');
  assert.ok(normalized, 'Native tool execution must produce a result');
  assert.equal(normalized.isError, true, 'Actual host did not apply macuse partial-failure hook');
  assert.notEqual(normalized.content.find(c => c.type === 'image').data, content[1].data, 'Fixture must exercise actual host resizing');
  assert.equal(normalized.details.macuse.originalContent, undefined);
  assert.equal(normalized.details.macuse.originalImages[0].data, content[1].data);
  assert.equal(JSON.stringify(normalized).split(content[1].data).length - 1, 1, 'Original bytes must serialize once');
  const runner = session.extensionRunner;
  const requests = [];
  const fakeFetch = async (_url, init) => {
    const body = new Headers(init.headers).get('content-encoding') === 'zstd' ? zstdDecompressSync(init.body).toString() : String(init.body);
    requests.push(JSON.parse(body));
    const event = { type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', output: [], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } };
    return new Response(`event: response.completed\ndata: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  };
  const fakeJwt = `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'offline-fixture' } })).toString('base64url')}.fake`;
  for (const api of ['openai-responses', 'openai-codex-responses']) {
    const adapter = api === 'openai-responses' ? openaiProvider() : openaiCodexProvider();
    const current = { ...model, api, provider: api === 'openai-responses' ? 'openai' : 'openai-codex' };
    if (api === 'openai-responses') await modelRuntime.setRuntimeApiKey(current.provider, 'offline-only');
    else await credentials.modify(current.provider, async () => ({ type: 'oauth', access: fakeJwt, refresh: 'offline-only', expires: Date.now() + 3600000 }));
    await session.setModel(current);
    const send = async messages => {
      messages = await runner.emitContext(messages);
      const response = await adapter.streamSimple(current, normalizeContext({ systemPrompt: 'Offline test', tools: tools.filter(t => ['macuse', 'macuse_insert_text', 'macuse_reset', 'macuse_tools'].includes(t.name)), messages: convertToLlm(messages) }), { apiKey: api === 'openai-responses' ? 'offline-only' : fakeJwt, transport: 'sse', maxRetries: 0, fetch: fakeFetch, reasoning: 'low', onPayload: payload => runner.emitBeforeProviderRequest(payload) }).result();
      assert.equal(response.stopReason, 'stop', response.errorMessage);
      return requests.at(-1);
    };
    const messages = sm.buildSessionContext().messages;
    const payload = await send(messages);
    assert.ok(payload.tools.every(tool => tool.strict === true));
    assert.equal(JSON.stringify(payload.tools).includes('uniqueItems'), false, 'OpenAI rejects uniqueItems in strict tool schemas');
    const output = payload.input.find(item => item.type === 'function_call_output');
    assert.equal(output.output.find(p => p.type === 'input_image').image_url, `data:image/png;base64,${content[1].data}`);
    assert.equal(output.output.find(p => p.type === 'input_image').detail, 'auto');
    assert.equal(JSON.stringify(output).includes('displayed at'), false);
    const filtered = await send(messages.map(message => message.role === 'toolResult' ? { ...message, content: [{ type: 'text', text: 'Image removed by host policy' }] } : message));
    assert.equal(JSON.stringify(filtered).includes('input_image'), false);
    const originalLeaf = sm.getLeafId();
    const resultEntry = sm.getEntries().find(entry => entry.type === 'message' && entry.message.role === 'toolResult');
    sm.appendContextEdit(resultEntry.id, { content: [{ type: 'text', text: 'Image removed by persisted context edit' }] });
    assert.equal(JSON.stringify(await send(sm.buildSessionContext().messages)).includes('input_image'), false);
    const editedLeaf = sm.getLeafId();
    sm.branch(originalLeaf);
    await runner.emit({ type: 'session_tree', oldLeafId: editedLeaf, newLeafId: originalLeaf });
    const branched = await send(sm.buildSessionContext().messages);
    assert.equal(branched.input.find(item => item.type === 'function_call_output').output.find(p => p.type === 'input_image').image_url, `data:image/png;base64,${content[1].data}`);
    await runner.emit({ type: 'session_start', reason: 'resume' });
    const resumed = await send(sm.buildSessionContext().messages);
    assert.equal(resumed.input.find(item => item.type === 'function_call_output').output.find(p => p.type === 'input_image').image_url, `data:image/png;base64,${content[1].data}`);
  }
  sm.appendCompaction('Synthetic retained-none boundary', null, 100);
  await runner.emitContext(sm.buildSessionContext().messages);
  assert.equal(await runner.emitBeforeProviderRequest(requests.at(-1)), requests.at(-1), 'A post-handler retain-none draft cannot restore old images');
  console.log(JSON.stringify({ host: root, version: JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version, ok: true, checks: ['actual tool execution and tool_result error flag', 'actual oversized-image normalization and single-copy originals', 'both Responses adapters restore matching original bytes', 'strict code schema', 'image-removal policy and persisted edit honored', 'branch/resume exact-byte restoration', 'post-handler retain-none compaction'], mockRequests: requests.length }));
} finally {
  await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
  session.dispose();
  await rm(scratch, { recursive: true, force: true });
}
