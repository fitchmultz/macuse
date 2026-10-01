import { formatDimensionNote, resizeImage } from '@earendil-works/pi-coding-agent';

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

const originalContent = (content, details) => {
  if (Array.isArray(details?.originalContent)) return details.originalContent;
  if (!Array.isArray(details?.originalImages) || typeof details.originalText !== 'string') return;
  const restored = images(content).slice(), indices = new Set();
  for (const { index, ...part } of details.originalImages) {
    if (!Number.isInteger(index) || index < 0 || index >= restored.length || indices.has(index) || part.type !== 'image' || typeof part.data !== 'string' || typeof part.mimeType !== 'string') return;
    indices.add(index);
    restored[index] = part;
  }
  return [{ type: 'text', text: details.originalText }, ...restored];
};

// Public native resize bytes and notes, not arbitrary output differences, prove
// attribution. A later tool_result hook may redact either images or text.
export async function retainMacuseOriginals(message, resizeOptions) {
  const details = message?.role === 'toolResult' && message.toolName === 'macuse' && message.details?.macuse;
  if (!details) return;
  const original = originalContent(message.content, details);
  const profile = details.originalResizeOptions ?? resizeOptions;
  delete details.originalContent;
  delete details.originalImages;
  delete details.originalText;
  delete details.originalResizeOptions;
  if (!Array.isArray(original)) return;
  const before = images(original), after = images(message.content);
  if (before.length !== after.length) return;
  const changed = [], remaining = [];
  let index = 0;
  for (let position = 0; position < message.content.length; position++) {
    const part = message.content[position];
    if (part.type !== 'image') { remaining.push(part); continue; }
    const source = before[index];
    if (!sameImage(source, part)) {
      // Native screenshots are PNG. Unsupported conversion provenance fails
      // closed rather than reproducing Pi's private image-processing pipeline.
      if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(source.mimeType)) return;
      const resized = await resizeImage(Buffer.from(source.data, 'base64'), source.mimeType, profile);
      if (!resized?.wasResized || resized.data !== part.data || resized.mimeType !== part.mimeType) return;
      const note = message.content[++position];
      if (note?.type !== 'text' || note.text !== formatDimensionNote(resized)) return;
      changed.push({ index, ...source });
    }
    index++;
  }
  if (text(remaining) !== text(original)) return;
  if (changed.length) {
    details.originalImages = changed;
    details.originalText = text(original);
    details.originalResizeOptions = profile ?? {};
  }
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
    const original = originalContent(saved.content, details);
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
  const add = async (message, resizeOptions) => {
    if (message?.role !== 'toolResult' || message.toolName !== 'macuse') return;
    await retainMacuseOriginals(message, resizeOptions);
    const key = message.toolCallId.split('|')[0];
    // A reused wire ID cannot establish which original produced a resized
    // payload. The finalized event and its appended entry share one object.
    if (retained.has(key) && retained.get(key) !== message) retained.set(key, null);
    else retained.set(key, message);
  };
  return {
    reset() { manager = undefined; leaf = undefined; retained.clear(); },
    async messageEnd(message, resizeOptions) {
      if (manager) await add(message, resizeOptions);
      else await retainMacuseOriginals(message, resizeOptions);
    },
    async select(sm, messages, resizeOptions) {
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
        for (const entry of sm.buildContextEntries()) if (entry.type === 'message') await add(entry.message, resizeOptions);
      } else {
        for (const entry of suffix.reverse()) if (entry.type === 'message') await add(entry.message, resizeOptions);
      }
      manager = sm;
      leaf = current;
      const selected = new Map();
      for (const message of messages) if (message.role === 'toolResult' && message.toolName === 'macuse') {
        const key = message.toolCallId.split('|')[0], saved = retained.get(key);
        if (saved && message.toolCallId === saved.toolCallId && message.timestamp === saved.timestamp && sameWire(wireContent(message.content), wireContent(saved.content))) selected.set(key, saved);
      }
      return selected;
    },
  };
}
