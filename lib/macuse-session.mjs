import { CuaRuntime, imageMetadata } from './cua-runtime.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { AuxiliaryRuntime } from './auxiliary-runtime.mjs';
import { insertText } from './native-input.mjs';
import { MacOSNative, nativeWindowClosed } from '../tools/macos-native.mjs';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { tools } from './tools.mjs';

const validator = new AjvJsonSchemaValidator();
const validators = new Map(tools.map(tool => [tool.name, validator.getValidator(tool.inputSchema)]));

const failure = (tool, message) => ({
  content: [{ type: 'text', text: message }], isError: true,
  details: { macuse: { tool, isError: true, dispatched: false, outcome: 'not_dispatched' } },
});

// One desktop session owns code execution, AX insertion, and their observations.
export class MacuseSession {
  constructor({ cwd = process.cwd(), runtime = new CuaRuntime({ cwd }), native = new MacOSNative(), auxiliary = new AuxiliaryRuntime({ cwd }) } = {}) {
    this.cwd = cwd;
    this.runtime = runtime;
    this.native = native;
    this.auxiliary = auxiliary;
    this.queue = Promise.resolve();
    this.generation = 0;
  }

  callTool(tool, input = {}, options = {}) {
    const check = validators.get(tool)?.(input);
    if (!check?.valid) return Promise.resolve(failure(tool, check?.errorMessage ?? `Unknown macuse tool: ${tool}`));
    if (tool === 'macuse_reset') return this.reset();
    input = structuredClone(input);
    const generation = this.generation;
    const run = async () => {
      if (generation !== this.generation || options.signal?.aborted) return failure(tool, 'Cancelled before dispatch; no new action was sent.');
      const controller = this.active = new AbortController();
      const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
      try {
        let result;
        if (tool === 'macuse') result = await this.execute(input, { ...options, signal });
        else if (tool === 'macuse_insert_text') {
          result = await insertText(this.native, input, this.runtime.getObservation(input.app), { signal });
          if (result.details.macuse.dispatched) this.runtime.invalidateObservation(input.app);
        } else result = await this.auxiliary.callTool(tool, input, { ...options, signal });
        if (result.details.macuse.kernelReset && generation === this.generation) this.generation++;
        result.details.macuse.isError = result.isError === true;
        let remaining = 20000;
        const content = result.content.map(part => {
          if (part.type !== 'text') return part;
          const text = part.text.slice(0, remaining);
          remaining = Math.max(0, remaining - text.length);
          return { ...part, text };
        });
        if (content.some((part, index) => part.type === 'text' && part.text !== result.content[index].text)) {
          result.details.macuse.fullOutput = result.content;
          content.push({ type: 'text', text: 'Text output capped at 20000 characters. Use JavaScript filtering or a narrower observation; complete output remains in result details. Internal guards use the full state.' });
          result.content = content;
        }
        if (result.details.macuse.savedImage) result.content.push({ type: 'text', text: `Saved screenshot: ${JSON.stringify(result.details.macuse.savedImage)}` });
        const actions = result.details.macuse.actions;
        if (actions?.length) result.content.push({ type: 'text', text: JSON.stringify({ status: result.details.macuse.status, actionCount: actions.length, ...(actions.length > 20 ? { shown: 'last 20 actions; complete evidence in details' } : {}), actions: actions.slice(-20).map(({ id, method, app, dispatched, outcome, verification }) => ({ id, method, app, dispatched, outcome, verification })) }) });
        if (result.isError) result.content.push({ type: 'text', text: 'Execution failed or has an unverified outcome. Inspect fresh state before continuing; never automatically replay a dispatched or unknown-outcome mutation.' });
        return result;
      } finally { if (this.active === controller) this.active = undefined; }
    };
    const result = this.queue.then(run);
    this.queue = result.catch(() => {});
    return result;
  }

  async execute(input, options) {
    const { trackFocus = true, saveImagePath, ...codeInput } = input;
    let observation, focusError;
    if (trackFocus) {
      try {
        const targets = await Promise.all((input.apps ?? []).map(app => this.native.resolveApp(app, { signal: options.signal }).catch(() => null)));
        observation = await this.native.beginObservation(targets.filter(Boolean).map(app => app.pid), { signal: options.signal });
      } catch (error) { focusError = error.message; }
    }
    let result;
    const started = Date.now();
    try {
      result = await this.runtime.execute(codeInput, options);
      // Sky omits TextEdit's focused marker. Join a fresh parent AX identity to
      // one stable ID in the same complete observed document, never guess a field.
      for (const observed of result.details.macuse.observations ?? []) {
        if (observed.focused || observed.observedAt < started) continue;
        try {
          const app = await this.native.resolveApp(observed.app, { signal: options.signal });
          const state = await this.native.inspectApp(app.pid, { signal: options.signal });
          const window = state.focusedWindow, field = state.focusedElement;
          if (!state.accessibilityTrusted || !window || !field?.identifier || window.title !== observed.title || window.document !== observed.url) continue;
          const role = field.roleDescription?.toLowerCase().replace(/^search text field$/, 'search');
          const matches = observed.elements.filter(e => e.id === field.identifier && [role, field.role].includes(e.role) && e.value !== undefined && e.value === field.value);
          if (matches.length !== 1) continue;
          observed.focused = matches[0];
          result.content.push({ type: 'text', text: `Native focused field in ${observed.app}: ${matches[0].role}, ID: ${field.identifier}.` });
        } catch { /* Missing AX evidence leaves insertion unavailable, never authorizes a fallback. */ }
      }
      if (saveImagePath) {
        try {
          const image = result.content.find(part => part.type === 'image');
          if (!image) throw new Error('No image was emitted; call getScreenshot or getAXStateAndScreenshot explicitly.');
          const path = resolve(this.cwd, saveImagePath.replace(/^~(?=\/)/, homedir()));
          const bytes = Buffer.from(image.data, 'base64');
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
          result.details.macuse.savedImage = { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), ...imageMetadata(image.data) };
        } catch (error) {
          result.isError = true;
          result.content.push({ type: 'text', text: `Screenshot export failed: ${error.message}` });
        }
      }
      const last = result.details.macuse.actions?.findLast(action => action.dispatched);
      if (last?.closesWindow && last.before) {
        try {
          const app = await this.native.resolveApp(last.app);
          const state = await this.native.inspectApp(app.pid);
          if (state.accessibilityTrusted && nativeWindowClosed(last.before, state)) {
            last.verification = 'native-window-closed';
            result.content.push({ type: 'text', text: 'Native Accessibility confirms the target window is closed. No app-state read reopened it. Do not replay the close.' });
          }
        } catch (error) {
          result.content.push({ type: 'text', text: `Native close verification unavailable: ${error.message}. Do not replay the close.` });
        }
      }
    }
    finally {
      if (trackFocus) {
        let focus;
        if (observation) {
          try { focus = await this.native.endObservation(observation.id); }
          catch (error) { focusError = error.message; }
        }
        if (result) {
          result.details.macuse.focus = { ...focus, observationAvailable: Boolean(focus?.coverage.applicationActivation), observationError: focusError ?? null, inputAttribution: false, isolationGuaranteed: false };
          result.content.push({ type: 'text', text: focus
            ? `Focus observation: ${focus.transitions.length} activation/window transition(s). Input attribution unavailable; input isolation is not guaranteed.`
            : `Focus observation unavailable: ${focusError ?? 'no observation returned'}.` });
        }
      }
    }
    return result;
  }

  reset() {
    this.generation++;
    this.active?.abort();
    const result = this.queue.then(async () => {
      await this.runtime.reset();
      return { content: [{ type: 'text', text: 'JavaScript bindings and app observations cleared. Applications are unchanged. Observe before acting; no previous action was replayed.' }], isError: false, details: { macuse: { tool: 'macuse_reset', isError: false } } };
    });
    this.queue = result.catch(() => {});
    return result;
  }

  status() { return { computer: this.runtime.status(), auxiliary: this.auxiliary.status() }; }

  stop() {
    this.generation++;
    this.active?.abort();
    const result = this.queue.then(() => Promise.all([this.runtime.stop(), this.native.stop(), this.auxiliary.stop()]));
    this.queue = result.catch(() => {});
    return result;
  }
}
