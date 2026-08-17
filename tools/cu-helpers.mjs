import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { sanitizeRecoverableComputerUseText } from '../extensions/codex-computer-use-modules/computer-use-recovery-runtime.mjs';

export {
  appServerSessionRecoverySummary,
  isRecoverableComputerUseSessionText,
  restartComputerUseRuntime,
  sanitizeRecoverableComputerUseText,
  shouldAutoRecoverComputerUse,
  withReadOnlyComputerUseRecovery,
} from '../extensions/codex-computer-use-modules/computer-use-recovery-runtime.mjs';

export function truncateString(value, max) {
  if (typeof value !== 'string') return value;
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…[${value.length} chars]`;
}

export function getMousePosition() {
  const script = 'import CoreGraphics; if let e = CGEvent(source: nil) { let p = e.location; print(Int(p.x), Int(p.y)) }';
  const result = spawnSync('swift', ['-e', script], { encoding: 'utf8', timeout: 10000 });
  if (result.status !== 0) return null;
  const [x, y] = result.stdout.trim().split(/\s+/).map((part) => Number(part));
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

export function restoreMousePosition(position) {
  if (!position) return false;
  const script = `import CoreGraphics; CGWarpMouseCursorPosition(CGPoint(x: ${Math.trunc(position.x)}, y: ${Math.trunc(position.y)})); CGAssociateMouseAndMouseCursorPosition(1)`;
  const result = spawnSync('swift', ['-e', script], { encoding: 'utf8', timeout: 10000 });
  return result.status === 0;
}

const PRESS_KEY_ALIASES = new Map([
  ['cmd', 'super'],
  ['command', 'super'],
  ['meta', 'super'],
  ['control', 'ctrl'],
  ['option', 'alt'],
  ['esc', 'Escape'],
  ['escape', 'Escape'],
  ['return', 'Return'],
  ['enter', 'Return'],
  ['tab', 'Tab'],
  ['space', 'space'],
  ['comma', 'comma'],
  [',', 'comma'],
  ['period', 'period'],
  ['.', 'period'],
]);
const PRESS_KEY_MODIFIERS = new Set(['super', 'ctrl', 'alt', 'shift']);

function normalizePressKeyPart(value) {
  const part = String(value).trim();
  return PRESS_KEY_ALIASES.get(part.toLowerCase()) ?? part;
}

export function normalizePressKeyValue(value, modifiers = undefined) {
  const rawModifiers = modifiers === undefined ? [] : typeof modifiers === 'string' ? [modifiers] : modifiers;
  if (!Array.isArray(rawModifiers) || !rawModifiers.every((item) => typeof item === 'string')) throw new Error('press_key modifiers must be a string or array of strings.');
  const parts = [...rawModifiers.map(normalizePressKeyPart), ...String(value).split('+').map(normalizePressKeyPart)].filter(Boolean);
  const seenModifiers = new Set();
  return parts.filter((part) => {
    const normalized = part.toLowerCase();
    if (!PRESS_KEY_MODIFIERS.has(normalized)) return true;
    if (seenModifiers.has(normalized)) return false;
    seenModifiers.add(normalized);
    return true;
  }).join('+');
}

export function normalizeToolArguments(args) {
  const normalized = { ...args };
  if (normalized.element_index === undefined && normalized.element !== undefined) {
    normalized.element_index = normalized.element;
    delete normalized.element;
  }
  if (normalized.element_index !== undefined && normalized.element_index !== null) normalized.element_index = String(normalized.element_index);
  if (typeof normalized.key === 'string') {
    normalized.key = normalizePressKeyValue(normalized.key, normalized.modifiers);
    delete normalized.modifiers;
  }
  return normalized;
}

export function toolResultText(result) {
  return contentText(result?.content);
}

export function contentText(content) {
  return (content || [])
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

export function parseElementInfo(text) {
  const elements = [];
  for (const rawLine of text.split('\n')) {
    const match = rawLine.match(/^\s*(\d+)\s+(.+)$/);
    if (!match) continue;
    const line = match[0].trim();
    const id = line.match(/(?:^|[\s,])ID:\s*([^,\n]+)/)?.[1]?.trim();
    const explicitDescription = line.match(/Description:\s*([^,\n]+)/)?.[1]?.trim();
    const buttonLabel = line.match(/^\d+\s+button\s+([^,]+?)(?:,\s|$)/)?.[1]?.trim();
    const description = explicitDescription ?? (buttonLabel && !buttonLabel.startsWith('Description:') ? buttonLabel : undefined);
    elements.push({ index: match[1], id, description, line });
  }
  return elements;
}

export function updateElementCache(cache, app, text) {
  if (typeof app !== 'string') return;
  const elements = parseElementInfo(text);
  if (elements.length > 0) cache.set(app, elements);
}

export function elementTargetHint(element) {
  if (element.id) return `target: { elementId: ${JSON.stringify(element.id)} }`;
  if (element.description) return `target: { elementDescription: ${JSON.stringify(element.description)} }`;
  return `fallback: { element_index: ${JSON.stringify(element.index)} }`;
}

export function elementLineWithTargetHint(element) {
  return `${element.line} — ${elementTargetHint(element)}`;
}

export function elementSummary(elements, { limit = 40, targetHints = false } = {}) {
  if (elements.length === 0) return 'No cached elements for this app.';
  const render = targetHints ? elementLineWithTargetHint : (element) => element.line;
  const shown = elements.slice(0, limit).map(render).join('\n');
  const remaining = elements.length > limit ? `\n…${elements.length - limit} more elements omitted` : '';
  return `${shown}${remaining}`;
}

export function editDistance(a, b) {
  const aa = String(a).toLowerCase();
  const bb = String(b).toLowerCase();
  const previous = Array.from({ length: bb.length + 1 }, (_, index) => index);
  for (let i = 1; i <= aa.length; i += 1) {
    let last = previous[0];
    previous[0] = i;
    for (let j = 1; j <= bb.length; j += 1) {
      const old = previous[j];
      previous[j] = aa[i - 1] === bb[j - 1] ? last : Math.min(previous[j - 1], previous[j], last) + 1;
      last = old;
    }
  }
  return previous[bb.length] ?? 0;
}

export function closestElementSuggestions(elements, value, field, limit = 3) {
  const candidates = elements
    .map((element) => ({ element, value: element[field] }))
    .filter((candidate) => typeof candidate.value === 'string' && candidate.value.length > 0)
    .map((candidate) => ({ ...candidate, score: editDistance(value, candidate.value) }))
    .sort((a, b) => a.score - b.score)
    .slice(0, limit);
  if (candidates.length === 0) return '';
  return candidates.map((candidate) => `${candidate.value} (${elementTargetHint(candidate.element)})`).join(', ');
}

export function resolveElementTarget(args, cache, opts = {}) {
  const normalized = normalizeToolArguments(args);
  const usageError = opts.usageError || ((message) => new Error(message));
  const targetError = opts.targetError || ((message) => new Error(message));
  const summaryOpts = { targetHints: opts.targetHints === true };
  const closest = opts.closestSuggestions === true;
  const elementId = normalized.elementId ?? normalized.element_id;
  if (typeof elementId === 'string' && normalized.element_index === undefined) {
    if (typeof normalized.app !== 'string') throw usageError('elementId targeting requires an app argument');
    const elements = cache.get(normalized.app) || [];
    const match = elements.find((element) => element.id === elementId);
    if (!match) {
      const knownIds = elements.map((element) => element.id).filter(Boolean).join(', ');
      const suggestions = closest ? closestElementSuggestions(elements, elementId, 'id') : '';
      throw targetError(`No elementId ${elementId} found for ${normalized.app}.${knownIds ? ` Known IDs: ${knownIds}.` : ''}${suggestions ? `\nClosest elementId matches: ${suggestions}.` : ''}\nAvailable elements:\n${elementSummary(elements, summaryOpts)}`);
    }
    normalized.element_index = match.index;
    delete normalized.elementId;
    delete normalized.element_id;
  }
  const elementDescription = normalized.elementDescription ?? normalized.element_description;
  if (typeof elementDescription === 'string' && normalized.element_index === undefined) {
    if (typeof normalized.app !== 'string') throw usageError('elementDescription targeting requires an app argument');
    const elements = cache.get(normalized.app) || [];
    const matches = elements.filter((element) => element.description?.toLowerCase() === elementDescription.toLowerCase());
    if (matches.length !== 1) {
      const reason = matches.length === 0 ? 'No' : `Ambiguous ${matches.length}`;
      const suggestions = closest ? closestElementSuggestions(elements, elementDescription, 'description') : '';
      throw targetError(`${reason} elementDescription ${elementDescription} found for ${normalized.app}. Match is exact and case-insensitive.${suggestions ? `\nClosest elementDescription matches: ${suggestions}.` : ''}\nAvailable elements:\n${elementSummary(elements, summaryOpts)}`);
    }
    normalized.element_index = matches[0].index;
    delete normalized.elementDescription;
    delete normalized.element_description;
  }
  if (normalized.element_index !== undefined) {
    delete normalized.elementId;
    delete normalized.element_id;
    delete normalized.elementDescription;
    delete normalized.element_description;
  }
  return normalized;
}

function imageDimensions(path) {
  const result = spawnSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', path], { encoding: 'utf8', timeout: 10000 });
  if (result.status !== 0) return { width: null, height: null };
  const width = Number((result.stdout.match(/pixelWidth:\s*(\d+)/) || [])[1]);
  const height = Number((result.stdout.match(/pixelHeight:\s*(\d+)/) || [])[1]);
  return {
    width: Number.isFinite(width) ? width : null,
    height: Number.isFinite(height) ? height : null,
  };
}

export function sanitizeComputerUseText(text) {
  return sanitizeRecoverableComputerUseText(text);
}

export function filterToolResult(result, opts) {
  const content = [];
  let omittedImages = 0;
  let savedImagePath = null;
  let savedImageArtifact = null;
  let forcedError = false;
  for (const block of result?.content || []) {
    if (block?.type === 'text') {
      const sanitized = sanitizeRecoverableComputerUseText(block.text || '');
      forcedError = forcedError || sanitized.forcedError;
      content.push({ ...block, text: truncateString(sanitized.text, opts.maxTextChars) });
    } else if (block?.type === 'image') {
      if (opts.saveImage && !savedImagePath && block.data) {
        const outPath = resolve(opts.saveImage);
        mkdirSync(dirname(outPath), { recursive: true });
        const imageData = Buffer.from(block.data, 'base64');
        writeFileSync(outPath, imageData);
        savedImagePath = outPath;
        const dimensions = imageDimensions(outPath);
        savedImageArtifact = {
          path: outPath,
          bytes: imageData.byteLength,
          sha256: createHash('sha256').update(imageData).digest('hex'),
          width: dimensions.width,
          height: dimensions.height,
        };
        content.push({ type: 'text', text: `Saved image artifact: ${outPath} (${imageData.byteLength} bytes, ${dimensions.width && dimensions.height ? `${dimensions.width}x${dimensions.height}` : 'unknown size'}, sha256=${savedImageArtifact.sha256})` });
      }
      if (opts.includeImage) content.push(block);
      else omittedImages += 1;
    } else {
      content.push(block);
    }
  }
  return {
    content,
    isError: forcedError || (result?.isError ?? result?.is_error ?? false),
    meta: opts.quiet ? null : result?._meta ?? result?.meta ?? null,
    omittedImages,
    savedImagePath,
    savedImageArtifact,
  };
}
