#!/usr/bin/env node
// Credential-free probes of the installed host's real hooks, image normalizer and Responses adapters.
import assert from 'node:assert/strict';
import { findPackageJSON } from 'node:module';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { crc32, deflateSync, zstdDecompressSync } from 'node:zlib';
import { createJiti } from 'jiti';

globalThis.fetch = async () => { throw new Error('Unexpected network in offline Pi probe'); };
const root = process.argv[2] ? resolve(process.argv[2]) : dirname(findPackageJSON('@earendil-works/pi-coding-agent', import.meta.url));
const ai = dirname(findPackageJSON('@earendil-works/pi-ai', pathToFileURL(join(root, 'package.json')).href));
const load = (base, file) => import(pathToFileURL(join(base, file)).href);
const { AgentSession } = await load(root, 'dist/core/agent-session.js');
const { SessionManager } = await load(root, 'dist/core/session-manager.js');
const { ExtensionRunner } = await load(root, 'dist/core/extensions/runner.js');
const { convertToLlm } = await load(root, 'dist/core/messages.js');
const { normalizeContext } = await load(ai, 'dist/utils/transcript.js');
const jiti = createJiti(import.meta.url);
const { default: extension } = await jiti.import('../extensions/macuse.ts');
const handlers = new Map(), tools = [];
extension({ registerTool: tool => tools.push(tool), registerCommand() {}, on: (name, fn) => handlers.set(name, [fn]) });

function png(width, height) {
  const chunk = (name, bytes) => { const data = Buffer.concat([Buffer.from(name), bytes]), length = Buffer.alloc(4), crc = Buffer.alloc(4); length.writeUInt32BE(bytes.length); crc.writeUInt32BE(crc32(data)); return Buffer.concat([length, data, crc]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.alloc((width * 4 + 1) * height))), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}
const content = [{ type: 'text', text: 'Controlled synthetic image' }, { type: 'image', mimeType: 'image/png', data: png(4000, 3000) }];
const details = { macuse: { isError: true, originalContent: content, actions: [{ dispatched: true, outcome: 'unknown' }] } };
const call = { type: 'toolCall', name: 'macuse', id: 'call_image|fc_image', arguments: { code: 'synthetic fixture only' } };
const catalog = JSON.parse(await readFile(join(ai, 'dist/providers/data/openai.json'), 'utf8'));
const model = Object.values(catalog).flatMap(models => Object.values(models)).find(model => model.id === 'gpt-6-astra');
assert.ok(model, 'Installed host has no native Astra catalog entry');
const sm = SessionManager.inMemory(process.cwd());
const runner = new ExtensionRunner([{ path: 'macuse-host-validation', handlers }], { getThinkingLevel: () => 'low' }, process.cwd(), sm, {});
runner.getModel = () => model;
const host = { agent: {}, _extensionRunner: runner, settingsManager: { getImageAutoResize: () => true }, model };
AgentSession.prototype._installAgentToolHooks.call(host);
const normalized = await host.agent.afterToolCall({ toolCall: call, args: call.arguments, result: { content, details }, isError: false });
assert.equal(normalized.isError, true, 'Actual host did not apply macuse partial-failure hook');
assert.notEqual(normalized.content.find(c => c.type === 'image').data, content[1].data, 'Fixture must exercise actual host resizing');
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
sm.appendMessage({ role: 'user', content: 'Offline fixture', timestamp: 0 });
sm.appendMessage({ role: 'assistant', content: [call], api: model.api, provider: model.provider, model: model.id, stopReason: 'toolUse', timestamp: 0, usage });
sm.appendMessage({ role: 'toolResult', toolName: 'macuse', toolCallId: call.id, content: normalized.content, details, isError: true, timestamp: 0 });
let requests = [];
const fakeFetch = async (_url, init) => {
  const body = new Headers(init.headers).get('content-encoding') === 'zstd' ? zstdDecompressSync(init.body).toString() : String(init.body);
  requests.push(JSON.parse(body));
  const event = { type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', output: [], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } };
  return new Response(`event: response.completed\ndata: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
};
const fakeJwt = `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'offline-fixture' } })).toString('base64url')}.fake`;
for (const api of ['openai-responses', 'openai-codex-responses']) {
  const adapter = await load(ai, `dist/api/${api}.js`);
  const current = { ...model, api, provider: api === 'openai-responses' ? 'openai' : 'openai-codex' };
  runner.getModel = () => current;
  const send = async messages => {
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
}
console.log(JSON.stringify({ host: root, version: JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version, ok: true, checks: ['actual tool_result error flag', 'actual oversized-image normalization', 'both Responses adapters restore matching original bytes', 'strict code schema', 'image-removal policy honored'], mockRequests: requests.length }));
