import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { sanitizeRecoverableComputerUseText } from '../extensions/codex-computer-use-modules/computer-use-recovery-runtime.mjs';
import { validateToolArguments, pickUpstreamToolArgs } from '../extensions/codex-computer-use-modules/upstream-tool-args.mjs';
import { MacOSNative, nativeWindowClosed } from './macos-native.mjs';

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
  const blocks = [];
  let current = [];
  for (const line of text.split('\n')) {
    if (/^\s*(?:<\/?app_state>|Computer Use state|App=|Window:|The focused UI element is|Selected text:|Note:|Visible text:|Targets:|Focus summary:|Warning:)/.test(line)) {
      if (current.length) blocks.push(current.join('\n'));
      current = [];
    } else if (/^\s*\d+\s+/.test(line) && !/^\s*\d+(?:\.\d+)?\s+(?:bytes?|[kmgtpe]?i?b)(?:\/s)?\s*$/i.test(line)) {
      if (current.length) blocks.push(current.join('\n'));
      current = [line];
    } else if (current.length) current.push(line);
  }
  if (current.length) blocks.push(current.join('\n'));
  return blocks.flatMap(line => {
    const match = line.match(/^\s*(\d+)\s+([\s\S]+)$/);
    if (!match || !match[2].trim()) return [];
    const [, index, body] = match;
    const [header, ...continuation] = body.split('\n');
    const role = header.match(/^(standard window|split group|scroll area|scroll bar|value indicator|text entry area|secure text field|search text field|text field|edit field|close button|zoom button|minimize button|full screen button|radio button|pop up button|sort button|menu button|menu bar|menu item|combo box|tab group|web area|\S+)/i)[1].toLowerCase();
    const rest = header.slice(role.length).trimStart().replace(/^\([^)]*\)\s*/, '');
    const markers = [...rest.matchAll(/(?:^|,\s*)(ID|Description|Help|Secondary Actions|URL|Value|Placeholder):[ \t]?/gi)];
    const fields = Object.fromEntries(markers.map((marker, i) => {
      const key = marker[1].toLowerCase();
      const value = rest.slice(marker.index + marker[0].length, markers[i + 1]?.index);
      return [key, key === 'value' ? value : value.trim()];
    }));
    const label = rest.slice(0, markers[0]?.index).trim();
    const description = fields.description ?? (/button|checkbox|switch|combo box|link/.test(role) ? label || undefined : undefined);
    const inline = body.match(/\((?:disabled,\s*)?(?:settable|editable),\s*(?:string|float|int(?:eger)?|bool(?:ean)?)\)[ \t]?([\s\S]*)$/i)?.[1];
    const value = fields.value !== undefined ? fields.value + (continuation.length ? `\n${continuation.join('\n')}` : '') : inline;
    return { index, id: fields.id, description, role, name: description || fields.id || (inline === undefined ? label : '') || role, value, disabled: /\(disabled\)/i.test(header), line: line.trim() };
  });
}

export function updateElementCache(cache, app, text) {
  if (typeof app !== 'string') return;
  const elements = parseElementInfo(text);
  cache.set(app, elements);
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
    const matches = elements.filter((element) => element.id === elementId);
    if (matches.length !== 1) {
      if (matches.length > 1) throw targetError(`Ambiguous ${matches.length} elementId ${elementId} found for ${normalized.app}. Use a fresh guarded index.`);
      const knownIds = elements.map((element) => element.id).filter(Boolean).join(', ');
      const suggestions = closest ? closestElementSuggestions(elements, elementId, 'id') : '';
      throw targetError(`No elementId ${elementId} found for ${normalized.app}.${knownIds ? ` Known IDs: ${knownIds}.` : ''}${suggestions ? `\nClosest elementId matches: ${suggestions}.` : ''}\nAvailable elements:\n${elementSummary(elements, summaryOpts)}`);
    }
    normalized.element_index = matches[0].index;
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
  if (normalized.element_index === undefined && (normalized.role !== undefined || normalized.name !== undefined || normalized.elementRole !== undefined || normalized.elementName !== undefined)) {
    const role = normalized.role ?? normalized.elementRole;
    const name = normalized.name ?? normalized.elementName;
    const matches = (cache.get(normalized.app) || []).filter(element =>
      (role === undefined || element.role.toLowerCase() === role.toLowerCase()) &&
      (name === undefined || [element.name, element.description, element.id].some(value => value?.toLowerCase() === name.toLowerCase())));
    if (matches.length !== 1) throw targetError(`Expected one role/name target; found ${matches.length}.`);
    normalized.element_index = matches[0].index;
  }
  if (normalized.element_index !== undefined) {
    const element = (cache.get(normalized.app) || []).find(item => item.index === normalized.element_index);
    if (!element) throw targetError(`element_index ${normalized.element_index} is not present in the fresh snapshot.`);
    for (const [guard, field] of [['expectedRole', 'role'], ['expectedName', 'name'], ['expectedDescription', 'description'], ['expectedId', 'id'], ['expectedValue', 'value']]) {
      if (normalized[guard] !== undefined && normalized[guard] !== element[field]) throw targetError(`Guard failed before mutation: ${guard} did not match the fresh target.`);
    }
    delete normalized.elementId;
    delete normalized.element_id;
    delete normalized.elementDescription;
    delete normalized.element_description;
  }
  return normalized;
}

// Same native per-thread isolation as the extension; keep the inherited CODEX_HOME.
export function isolatedThreadConfig(configRead, servers) {
  const config = configRead?.config;
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('config/read response did not include config');
  const disabled = value => Object.fromEntries(Object.keys(value && typeof value === 'object' && !Array.isArray(value) ? value : {}).map(name => [name, { enabled: false }]));
  return {
    features: { apps: false, computer_use: true, plugins: true, tool_call_mcp_elicitation: true },
    mcp_servers: { ...disabled(config.mcp_servers), ...servers },
    plugins: disabled(config.plugins),
  };
}

export function validateBridgeArguments(tool, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error(`${tool} arguments must be an object`);
  validateToolArguments(tool, { ...args, ...(typeof args.modifiers === 'string' ? { modifiers: [args.modifiers] } : {}) });
  pickUpstreamToolArgs(tool, args);
  // These selectors belong to the richer extension executor, not this bridge.
  if (args.targets !== undefined) throw new Error('targets fallback is supported by the pi extension only; use an explicit bridge target.');
  if (args.approval !== undefined && !['inherit', 'accept-all', 'accept-once', 'ask', 'deny'].includes(args.approval)) throw new Error('Invalid approval mode');
  for (const key of ['requireStateChange', 'allowMutating', 'allowPointer', 'allowRecording', 'allowPrivacyChange']) {
    if (args[key] !== undefined && typeof args[key] !== 'boolean') throw new Error(`${key} must be a boolean`);
  }
  if (args.safetyNote !== undefined && typeof args.safetyNote !== 'string') throw new Error('safetyNote must be a string');
  if (args.click_count !== undefined && (!Number.isInteger(args.click_count) || args.click_count <= 0)) throw new Error('click_count must be a positive integer');
  if (args.pages !== undefined && args.pages <= 0) throw new Error('pages must be positive');
}

function documentState(text) {
  const app = text.match(/^App=([^\n]+)/m)?.[1]?.trim() ?? null;
  const title = text.match(/^Window:\s*"([^"]*)"/m)?.[1] ?? null;
  const elements = parseElementInfo(text);
  const window = elements.find(element => element.role === 'standard window');
  const url = window?.line.match(/(?:^|,\s*)URL:\s*([^,\n]+)/)?.[1]?.trim() ?? null;
  return { app, title, url, pid: Number(app?.match(/\bpid\s+(\d+)/)?.[1]) || undefined, elements };
}

function documentChanged(previous, fresh) {
  const appChanged = previous.pid && fresh.pid ? previous.pid !== fresh.pid : previous.app !== fresh.app;
  return appChanged || (previous.url || fresh.url ? previous.url !== fresh.url : previous.title !== fresh.title);
}

function assertDocument(previous, fresh, args) {
  if (!fresh.app) throw new Error('Fresh app-state preflight did not identify an app. No mutation performed.');
  if (args.expectedTitle !== undefined && args.expectedTitle !== fresh.title) throw new Error('Window title guard failed. No mutation performed.');
  if (args.expectedUrl !== undefined && args.expectedUrl !== fresh.url) throw new Error('Document URL guard failed. No mutation performed.');
  if (previous && documentChanged(previous, fresh)) {
    throw new Error('Target document changed since the last observed state. No mutation performed; inspect it with get_app_state before retrying.');
  }
}

const stateError = result => Boolean(result?.isError || result?.is_error || sanitizeRecoverableComputerUseText(toolResultText(result)).forcedError);
const stateResult = text => ({ isError: false, content: [{ type: 'text', text }] });
const guiMutations = new Set(['click', 'drag', 'press_key', 'type_text', 'set_value', 'select_text', 'scroll', 'perform_secondary_action']);
const readOnlyTools = new Set(['list_apps', 'get_app_state', 'event_stream_status', 'computer_history_status', 'computer_history_get_settings']);

function matchingTarget(target, after) {
  const matches = after.elements.filter(element => target?.id ? element.id === target.id : element.role === target?.role && element.name === target?.name);
  return matches.length === 1 ? matches[0] : undefined;
}

function relevantStateChange(before, after, target, tool) {
  if (before.title !== after.title || before.url !== after.url) return true;
  const matched = matchingTarget(target, after);
  if (target && matched && (target.value !== matched.value || target.disabled !== matched.disabled)) return true;
  if (tool === 'set_value') return false;
  if (tool === 'scroll') return after.elements.some(element => element.role === 'scroll bar' && before.elements.some(old => old.index === element.index && old.value !== element.value));
  // A new menu/popover control is relevant; an unrelated changing clock is not.
  const identity = element => `${element.role}:${element.id ?? element.description ?? element.name}`;
  const controls = new Set(before.elements.map(identity));
  return after.elements.some(element => /button|field|entry area|menu|checkbox|switch|dialog/.test(element.role) && !controls.has(identity(element)));
}

/** Small shared safety boundary for CLI/MCP, not a second sequence executor.
 * All state, cache and postconditions use uncapped upstream text. */
export class BridgeComputerUseSession {
  constructor(callTool, { native = new MacOSNative(), elementCache = new Map() } = {}) {
    this.callTool = callTool;
    this.native = native;
    this.elementCache = elementCache;
    this.states = new Map();
  }

  remember(app, result) {
    if (typeof app !== 'string') return;
    if (stateError(result)) { this.elementCache.delete(app); return; }
    const text = toolResultText(result);
    const state = documentState(text);
    updateElementCache(this.elementCache, app, text);
    if (!state.app) return;
    // Reads use the app path; action responses use its bundle ID, with the same PID.
    for (const [alias, previous] of this.states) if (state.pid && state.pid === previous.pid) {
      this.states.set(alias, state); this.elementCache.set(alias, state.elements);
    }
    for (const alias of [app, state.app.match(/bundleID\s+([^,\s)]+)/)?.[1], state.app.split(/\s+\(/)[0]]) {
      if (alias) { this.states.set(alias.replace(/\/+$/, ''), state); this.elementCache.set(alias, state.elements); }
    }
  }

  async run(tool, input, { readback: requestedReadback = false, signal } = {}) {
    validateBridgeArguments(tool, input);
    signal?.throwIfAborted();
    let args = normalizeToolArguments(input);
    const app = args.app;
    const mutation = guiMutations.has(tool);
    // Capture BEFORE refreshing; otherwise a same-app tab/window race overwrites the guard.
    let before = this.states.get(app?.replace(/\/+$/, ''));
    const observation = await this.native.beginObservation(before?.pid ? [before.pid] : []).catch(() => null);
    let dispatched = false;
    let dispatchPending = false;
    let nativeEditPending = false;
    let outcome = 'reported';
    let result;
    let focus;
    let failure;
    try {
      signal?.throwIfAborted();
      if (mutation) {
        const fresh = await this.callTool('get_app_state', { app, approval: args.approval });
        if (stateError(fresh)) { this.elementCache.delete(app); throw new Error(`Fresh app-state preflight failed: ${toolResultText(fresh)}`); }
        signal?.throwIfAborted();
        const freshState = documentState(toolResultText(fresh));
        before ??= [...this.states.values()].find(state => freshState.pid ? state.pid === freshState.pid : state.app === freshState.app);
        assertDocument(before, freshState, args);
        this.remember(app, fresh);
        before = freshState;
        args = resolveElementTarget(args, this.elementCache);
      }
      const target = before?.elements.find(element => element.index === args.element_index);
      const close = tool === 'press_key' && ['super+w', 'super+shift+w'].includes(args.key)
        || (tool === 'click' || tool === 'perform_secondary_action' && args.action === 'Press') && (target?.role === 'close button' || /^close(?: tab| window)?$/i.test(target?.description ?? ''));
      if (tool === 'type_text') {
        const native = before?.pid ? await this.native.inspectApp(before.pid).catch(() => null) : null;
        const window = native?.focusedWindow;
        if (window && native.focusedElement?.selectedTextSettable) {
          if (window.document && before.url ? window.document !== before.url : window.title !== before.title) throw new Error('Native text target no longer matches the inspected document. No mutation performed.');
          signal?.throwIfAborted();
          dispatched = true;
          outcome = 'unknown';
          nativeEditPending = true;
          const edit = await this.native.replaceSelectedText({ pid: native.pid, expected: { windowToken: window.token, windowTitle: window.title, document: window.document, elementToken: native.focusedElement.token }, text: args.text });
          nativeEditPending = false;
          dispatched = edit.mutationAttempted;
          if (edit.status === 'applied') {
            result = stateResult('Text inserted and exactly verified through native Accessibility; no clipboard or global keyboard input used.');
            outcome = 'verified';
          } else if (edit.status !== 'unsupported' || edit.mutationAttempted) throw new Error(`${edit.reason || 'Native edit not verified'}. Do not replay an attempted edit.`);
        }
        if (!result && /[^\x00-\x7f]/.test(args.text)) throw new Error('This control does not support verified native Unicode insertion. No upstream text dispatched; use set_value on a verified settable field.');
      }
      signal?.throwIfAborted();
      if (!result) {
        dispatched = !readOnlyTools.has(tool);
        outcome = dispatched ? 'unknown' : 'reported';
        let dispatchTool = tool;
        let dispatchArgs = args;
        if (tool === 'set_value' && args.value === '' && /search/i.test(`${target?.role} ${target?.name}`)) {
          const clears = before.elements.filter(element => element.role === 'button' && /^(?:clear|cancel)(?: search)?$/i.test(element.description ?? '') && Math.abs(Number(element.index) - Number(target.index)) <= 3);
          if (clears.length === 1) { dispatchTool = 'perform_secondary_action'; dispatchArgs = { app, element_index: clears[0].index, action: 'Press', approval: args.approval }; }
        }
        dispatchPending = true;
        result = await this.callTool(dispatchTool, dispatchArgs);
        dispatchPending = false;
      }
      signal?.throwIfAborted();
      // Never reopen an application for a post-close readback.
      if (mutation && close && (!stateError(result) || /noWindowsAvailable/.test(toolResultText(result))) && before?.pid) {
        const proof = await this.native.inspectApp(before.pid).catch(() => null);
        if (nativeWindowClosed(before, proof)) {
          if (proof?.windowsCount === 0) result = stateResult(`App=${before.app}\nNo windows remain. Native Accessibility verified the last window closed; do not replay.`);
          else if (stateError(result)) result = stateResult("Native Accessibility verified that the target document is no longer among the app's windows. Other windows remain; do not replay the close.");
          outcome = 'verified';
        }
      }
      if (mutation && !close && (tool === 'set_value' || tool === 'type_text' && !stateError(result))) {
        const readback = await this.callTool('get_app_state', { app, approval: args.approval });
        if (stateError(readback)) throw new Error('Action dispatched but post-action state unavailable. Do not replay.');
        const after = documentState(toolResultText(readback));
        if (tool === 'set_value') {
          if (documentChanged(before, after)) throw new Error('set_value was dispatched, but readback belongs to a different document. Its edit outcome is unknown; inspect the original document without replaying the edit.');
          const matched = matchingTarget(target, after);
          if (!matched || matched.value !== args.value) throw new Error('set_value was dispatched, but the resolved field did not expose the exact requested value. Do not replay.');
          outcome = 'verified';
        }
        result = readback;
      }
      if (mutation && !close && requestedReadback && !['type_text', 'set_value'].includes(tool) && !stateError(result)) {
        result = await this.callTool('get_app_state', { app, approval: args.approval });
        if (stateError(result)) throw new Error('Action dispatched but assertion readback unavailable. Do not replay.');
      }
      if (mutation && args.requireStateChange && !stateError(result)) {
        if (close) {
          if (outcome !== 'verified') throw new Error('Close dispatched without independently verified state change. Do not replay.');
        } else {
          const readback = /^App=/m.test(toolResultText(result)) ? result : await this.callTool('get_app_state', { app, approval: args.approval });
          if (stateError(readback)) throw new Error('Action dispatched but state-change readback unavailable. Do not replay.');
          if (!relevantStateChange(before, documentState(toolResultText(readback)), target, tool)) throw new Error('actionDispatchedButNoStateChange: no relevant target/document change verified. Do not replay.');
          result = readback;
          outcome = 'verified';
        }
      }
      signal?.throwIfAborted();
      if (stateError(result)) { this.elementCache.delete(app); outcome = dispatched ? 'unknown' : 'reported'; }
      else if (outcome === 'unknown') outcome = 'reported';
      if (/^App=/m.test(toolResultText(result)) || tool === 'get_app_state') this.remember(app, result);
    } catch (error) {
      // Native request timeouts also must not free the MCP queue before helper exit.
      if (nativeEditPending) await this.native.stop();
      if (dispatchPending && error.details?.dispatched === false) dispatched = false;
      error.details = { ...error.details, dispatched, outcomeUnknown: dispatched, outcome: dispatched ? 'unknown' : 'not-dispatched' };
      failure = error;
      throw error;
    } finally {
      const observed = observation && !nativeEditPending ? await this.native.endObservation(observation.id).catch(() => null) : null;
      focus = { ...(observed || {}), observationAvailable: Boolean(observed?.coverage?.applicationActivation), observedChanges: observed?.transitions?.length ?? null, changed: observed ? (observed.transitions ?? []).some(event => event.kind === 'activation' || event.kind === 'focused_window') : null, attribution: 'unknown', isolationGuaranteed: false };
      if (failure) failure.details.focus = focus;
    }
    return { result, args, dispatched, outcome, focus };
  }

  async stop() { await this.native.stop(); }
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
