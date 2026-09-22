import assert from 'node:assert/strict';
import test from 'node:test';
import { createJiti } from 'jiti';
import { restoreMacuseImages } from '../../lib/pi-images.mjs';
import { tools as specs } from '../../lib/tools.mjs';

const jiti = createJiti(import.meta.url);
const { default: extension } = await jiti.import('../../extensions/macuse.ts');

export function extensionFixture() {
  const tools = new Map(), handlers = new Map(), commands = new Map();
  let active = ['read'];
  extension({
    registerTool(tool) { tools.set(tool.name, tool); active.push(tool.name); },
    registerCommand(name, command) { commands.set(name, command); },
    on(name, handler) { handlers.set(name, handler); },
    getActiveTools: () => active,
    setActiveTools: names => { active = names.filter(name => name !== 'event_stream_start'); },
  });
  return { tools, handlers, commands, active: () => active };
}

test('Pi uses the shared strict surface, resets auxiliary activation, and preserves other tools', async () => {
  const f = extensionFixture();
  assert.equal(f.tools.size, specs.length + 1);
  for (const spec of specs) {
    const tool = f.tools.get(spec.name);
    assert.deepEqual(JSON.parse(JSON.stringify(tool.parameters)), spec.inputSchema);
    assert.equal(tool.executionMode, 'sequential');
    assert.deepEqual(tool.constrainedSampling, { type: 'json_schema', strict: 'prefer' });
  }
  for (const reason of ['startup', 'reload', 'resume', 'new', 'fork']) {
    await f.handlers.get('session_start')({ reason });
    assert.deepEqual(f.active().sort(), ['read', 'macuse', 'macuse_insert_text', 'macuse_reset', 'macuse_tools'].sort());
    const loaded = await f.tools.get('macuse_tools').execute('load', { tools: ['computer_history_status', 'event_stream_start'] });
    assert.deepEqual(loaded.details.added, ['computer_history_status']);
    assert.deepEqual(loaded.details.unavailable, ['event_stream_start']);
  }
  const result = { toolName: 'macuse', content: [{ type: 'text', text: 'Partial observation' }], details: { macuse: { isError: true, actions: [{ dispatched: true, outcome: 'unknown' }] } } };
  assert.deepEqual(f.handlers.get('tool_result')(result), { isError: true });
  assert.equal(result.details.macuse.actions[0].outcome, 'unknown');
  assert.equal(f.handlers.get('tool_result')({ ...result, toolName: 'foreign' }), undefined);
  await f.handlers.get('session_tree')();
  await f.handlers.get('session_shutdown')();
});

const image = data => ({ type: 'image', mimeType: 'image/png', data });
const text = value => ({ type: 'text', text: value });
const original = [text('Observed'), image('original-bytes'), image('small-unchanged')];
const normalized = [text('Observed'), image('resized-bytes'), text('Image displayed at 2000x1500'), image('small-unchanged')];
const entry = { type: 'message', message: { role: 'toolResult', toolName: 'macuse', toolCallId: 'call_one|fc_one', content: normalized, details: { macuse: { originalContent: original } } } };
const output = [ { type: 'input_text', text: 'Observed\nImage displayed at 2000x1500' }, ...normalized.filter(p => p.type === 'image').map(p => ({ type: 'input_image', detail: 'auto', image_url: `data:${p.mimeType};base64,${p.data}` })) ];

test('Astra restores only matching retained macuse images and removes only its obsolete resize note', () => {
  for (const api of ['openai-responses', 'openai-codex-responses']) for (const type of ['function_call_output', 'custom_tool_call_output']) {
    const payload = { input: [{ type, call_id: 'call_one', output }, { type, call_id: 'foreign', output }] };
    const model = { id: 'gpt-6-astra', api };
    const restored = restoreMacuseImages(payload, [entry], model);
    assert.equal(restored.input[0].output[1].image_url, 'data:image/png;base64,original-bytes');
    assert.equal(restored.input[0].output[0].text, 'Observed');
    assert.equal(restored.input[0].output[1].detail, 'auto');
    assert.deepEqual(restored.input[1], payload.input[1]);
    assert.equal(payload.input[0].output[1].image_url, 'data:image/png;base64,resized-bytes');
    assert.equal(restoreMacuseImages(payload, [], model), undefined, 'compacted/omitted entries stay omitted');
    for (const filtered of [output.slice(0, 1), output.slice(0, 2), [{ type: 'input_text', text: 'redacted' }, ...output.slice(1)]]) {
      assert.equal(restoreMacuseImages({ input: [{ type, call_id: 'call_one', output: filtered }] }, [entry], model), undefined);
    }
    assert.equal(restoreMacuseImages(payload, [entry], { id: 'other-model', api }), undefined);
    const unchanged = { ...entry, message: { ...entry.message, content: original } };
    assert.equal(restoreMacuseImages(payload, [unchanged], model), undefined);
  }
});
