const wireContent = content => {
  const text = content.filter(part => part.type === 'text').map(part => part.text).join('\n').toWellFormed();
  return [
    ...(text ? [{ type: 'input_text', text }] : []),
    ...content.filter(part => part.type === 'image').map(part => ({ type: 'input_image', detail: 'auto', image_url: `data:${part.mimeType};base64,${part.data}` })),
  ];
};

// Pi normalizes tool images after tool_result. Restore only this tool's intact
// retained outputs for Astra, whose auto sizing already means original.
export function restoreMacuseImages(payload, entries, model) {
  if (model?.id !== 'gpt-6-astra' || !['openai-responses', 'openai-codex-responses'].includes(model.api) || !Array.isArray(payload?.input)) return;
  const retained = new Map(entries.filter(entry => entry.type === 'message' && entry.message.role === 'toolResult' && entry.message.toolName === 'macuse')
    .map(entry => [entry.message.toolCallId.split('|')[0], entry.message]));
  let changed = false;
  const input = payload.input.map(item => {
    if (!['function_call_output', 'custom_tool_call_output'].includes(item.type) || !Array.isArray(item.output) || !item.output.some(part => part.type === 'input_image')) return item;
    const saved = retained.get(item.call_id);
    const original = saved?.details?.macuse?.originalContent;
    if (!Array.isArray(original) || JSON.stringify(item.output) !== JSON.stringify(wireContent(saved.content))) return item;
    const images = content => content.filter(part => part.type === 'image');
    if (images(original).length !== images(saved.content).length || JSON.stringify(images(original)) === JSON.stringify(images(saved.content))) return item;
    changed = true;
    return { ...item, output: wireContent(original) };
  });
  if (changed) return { ...payload, input };
}
