export const canRestoreMacuseImages = model => model?.id === 'gpt-6-astra' && ['openai-responses', 'openai-codex-responses'].includes(model.api);

const images = content => content.filter(part => part.type === 'image');
const text = content => content.filter(part => part.type === 'text').map(part => part.text).join('\n').toWellFormed();
const wireContent = content => [
  ...(text(content) ? [{ type: 'input_text', text: text(content) }] : []),
  ...images(content).map(part => ({ type: 'input_image', detail: 'auto', image_url: `data:${part.mimeType};base64,${part.data}` })),
];
const sameImage = (a, b) => a?.type === b?.type && a?.mimeType === b?.mimeType && a?.data === b?.data;
const sameWire = (actual, expected) => Array.isArray(actual) && actual.length === expected.length && actual.every((part, i) => {
  const wanted = expected[i];
  return part && Object.keys(part).length === Object.keys(wanted).length && Object.keys(wanted).every(key => part[key] === wanted[key]);
});

// message_end precedes persistence. Keep only bytes Pi actually resized, once;
// unchanged images already live in content. Legacy originalContent remains readable.
export function retainMacuseOriginals(message) {
  const details = message?.role === 'toolResult' && message.toolName === 'macuse' && message.details?.macuse;
  const original = details?.originalContent;
  if (!Array.isArray(original)) return;
  const before = images(original), after = images(message.content);
  if (before.length !== after.length) { delete details.originalContent; return; }
  const changed = before.flatMap((part, index) => sameImage(part, after[index]) ? [] : [{ index, ...part }]);
  if (changed.length) {
    details.originalImages = changed;
    details.originalText = text(original);
  }
  delete details.originalContent;
}

// Restore only raw, intact retained outputs selected through this request's
// actual messages. A redaction/context edit must never become the baseline.
export function restoreMacuseImages(payload, retained, model) {
  if (!canRestoreMacuseImages(model) || !Array.isArray(payload?.input)) return;
  let changed = false;
  const input = payload.input.map(item => {
    if (!['function_call_output', 'custom_tool_call_output'].includes(item.type) || !Array.isArray(item.output) || !item.output.some(part => part.type === 'input_image')) return item;
    const saved = retained.get(item.call_id);
    const details = saved?.details?.macuse;
    if (!details || !sameWire(item.output, wireContent(saved.content))) return item;
    let original = details.originalContent;
    if (!original && Array.isArray(details.originalImages) && typeof details.originalText === 'string') {
      const restored = images(saved.content).slice();
      const indices = new Set();
      for (const { index, ...part } of details.originalImages) {
        if (!Number.isInteger(index) || index < 0 || index >= restored.length || indices.has(index) || part.type !== 'image' || typeof part.data !== 'string' || typeof part.mimeType !== 'string') return item;
        indices.add(index);
        restored[index] = part;
      }
      original = [{ type: 'text', text: details.originalText }, ...restored];
    }
    if (!Array.isArray(original) || images(original).length !== images(saved.content).length || images(original).every((part, i) => sameImage(part, images(saved.content)[i]))) return item;
    changed = true;
    return { ...item, output: wireContent(original) };
  });
  if (changed) return { ...payload, input };
}

// One retained-window index, not another journal. Reconcile only the appended
// suffix; drafts commit after turn_end, so the next request reads the new leaf.
export function macuseImageIndex() {
  let leaf, manager;
  const retained = new Map();
  const add = message => {
    if (message?.role !== 'toolResult' || message.toolName !== 'macuse') return;
    const key = message.toolCallId.split('|')[0];
    // A reused wire ID cannot establish which original produced a resized
    // payload. The finalized event and its appended entry share one object.
    if (retained.has(key) && retained.get(key) !== message) retained.set(key, null);
    else retained.set(key, message);
  };
  return {
    reset() { manager = undefined; leaf = undefined; retained.clear(); },
    messageEnd(message) { retainMacuseOriginals(message); if (manager) add(message); },
    select(sm, messages) {
      const current = sm.getLeafId();
      const suffix = [];
      const seen = new Set();
      let id = current;
      if (manager === sm) {
        while (id && id !== leaf) {
          const entry = sm.getEntry(id);
          if (!entry || seen.has(id)) break;
          seen.add(id);
          suffix.push(entry);
          id = entry.parentId;
        }
      }
      if (manager !== sm || id !== leaf || suffix.some(entry => entry.type === 'compaction')) {
        retained.clear();
        for (const entry of sm.buildContextEntries()) if (entry.type === 'message') add(entry.message);
      } else {
        for (const entry of suffix.reverse()) if (entry.type === 'message') add(entry.message);
      }
      manager = sm;
      leaf = current;
      const selected = new Map();
      for (const message of messages) if (message.role === 'toolResult' && message.toolName === 'macuse') {
        const key = message.toolCallId.split('|')[0], saved = retained.get(key);
        if (saved && sameWire(wireContent(message.content), wireContent(saved.content))) selected.set(key, saved);
      }
      return selected;
    },
  };
}
