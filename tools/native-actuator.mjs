import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('./native-actuator.swift', import.meta.url));
let compiling;
async function executable() {
  if (process.platform !== 'darwin') throw new Error('The experimental native actuator requires macOS.');
  compiling ??= (async () => {
    const hash = createHash('sha256').update(await readFile(source)).update(process.arch).digest('hex').slice(0, 20);
    const directory = join(homedir(), 'Library', 'Caches', 'macuse', 'actuator-proof');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const binary = join(directory, `native-actuator-${hash}`);
    try { await access(binary); return binary; } catch { /* Compile this revision lazily. */ }
    const temporary = `${binary}.${process.pid}.tmp`;
    try {
      await new Promise((resolve, reject) => {
        const compiler = spawn('/usr/bin/xcrun', ['swiftc', source, '-o', temporary], { stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        const timer = setTimeout(() => { stderr += '\nCompiler exceeded sixty seconds.'; compiler.kill('SIGKILL'); }, 60_000);
        compiler.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8000); });
        compiler.once('error', error => { clearTimeout(timer); reject(error); });
        compiler.once('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`Native actuator compilation failed: ${stderr}`)); });
      });
      await rename(temporary, binary);
      return binary;
    } finally { await rm(temporary, { force: true }); }
  })();
  try { return await compiling; } catch (error) { compiling = undefined; throw error; }
}

/** Opt-in feasibility adapter, not selected by production MacuseSession/backend defaults. */
export class NativeActuator {
  #child;
  #pending;
  #nextId = 0;
  #tail = Promise.resolve();
  #stopping;
  #closing;
  #generation = 0;

  async #start() {
    await this.#stopping;
    if (this.#child) return this.#child;
    const child = spawn(await executable(), [], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.#child = child;
    let stderr = '';
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
    child.once('error', error => { if (this.#pending) this.#pending.failure = error; });
    child.stdin.on('error', error => {
      if (this.#pending) this.#pending.failure = error;
      void this.#terminate();
    });
    child.once('close', (code, signal) => {
      if (this.#child === child) this.#child = undefined;
      this.#pending?.reject(this.#pending.failure ?? new Error(`Native actuator exited (${signal ?? code})${stderr ? `: ${stderr}` : ''}.`));
    });
    let output = Buffer.alloc(0);
    let oversized = false;
    child.stdout.on('data', chunk => {
      if (oversized) return;
      output = Buffer.concat([output, chunk]);
      if (output.length > 20_000_000) {
        oversized = true; output = Buffer.alloc(0);
        if (this.#pending) this.#pending.failure = new Error('Native actuator output exceeds twenty megabytes; effect outcome may be unknown. Do not replay.');
        void this.#terminate();
        return;
      }
      const end = output.indexOf(10);
      if (end < 0) return;
      const line = output.subarray(0, end).toString('utf8');
      output = output.subarray(end + 1);
      let message;
      try { message = JSON.parse(line); } catch { return; }
      const pending = this.#pending;
      if (!pending || pending.id !== message.id || pending.failure) return;
      if (message.result?.error) pending.reject(Object.assign(new Error(message.result.error), { dispatched: false, mutationAttempted: false }));
      else pending.resolve(message.result);
    });
    return child;
  }

  #request(method, args, { signal, timeoutMs = 15_000 } = {}) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) return Promise.reject(new TypeError('Actuator arguments must be an object.'));
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) return Promise.reject(new RangeError('timeoutMs must be 100–60000.'));
    let saved;
    try {
      saved = structuredClone(args);
      const ancestors = new Set();
      const validate = value => {
        if (value === null) return;
        if (typeof value === 'string' && !value.isWellFormed()) throw new TypeError('Actuator strings must be well-formed Unicode.');
        if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('Actuator numbers must be finite.');
        if (!['string', 'boolean', 'number', 'object'].includes(typeof value)) throw new TypeError('Actuator arguments must contain only JSON values.');
        if (typeof value === 'object') {
          if ((!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) || ancestors.has(value)) throw new TypeError('Actuator arguments must contain only acyclic JSON arrays and objects.');
          ancestors.add(value);
          for (const item of Object.values(value)) validate(item);
          ancestors.delete(value);
        }
      };
      validate(saved);
      const json = JSON.stringify(saved);
      if (Buffer.byteLength(json) > 1_000_000) throw new RangeError('Actuator arguments exceed one megabyte.');
      saved = JSON.parse(json);
    } catch (error) {
      return Promise.reject(Object.assign(error, { dispatched: false, mutationAttempted: false, outcome: 'not-dispatched' }));
    }
    const generation = this.#generation;
    const closing = this.#closing;
    const run = this.#tail.then(async () => {
      const id = ++this.#nextId;
      const line = JSON.stringify({ ...saved, id, method });
      if (Buffer.byteLength(line) > 1_000_000) {
        throw Object.assign(new RangeError('Actuator wire request exceeds one megabyte.'), {
          dispatched: false, mutationAttempted: false, outcome: 'not-dispatched',
        });
      }
      let child;
      try {
        await closing;
        if (generation !== this.#generation) throw new Error('Actuator stopped before dispatch.');
        signal?.throwIfAborted();
        child = await this.#start();
        signal?.throwIfAborted();
        if (generation !== this.#generation) throw new Error('Actuator stopped before dispatch.');
      } catch (error) {
        await this.#terminate();
        throw Object.assign(new Error(error.message), { dispatched: false, mutationAttempted: false, outcome: 'not-dispatched' });
      }
      return new Promise((resolve, reject) => {
        let dispatched = false;
        const finish = (error, result) => {
          clearTimeout(timer); signal?.removeEventListener('abort', aborted); this.#pending = undefined;
          if (error) reject(Object.assign(new Error(error.message), {
            dispatched: error.dispatched ?? dispatched, mutationAttempted: error.mutationAttempted ?? dispatched,
            outcome: (error.dispatched ?? dispatched) ? 'unknown' : 'not-dispatched',
          }));
          else resolve(result);
        };
        const cancel = reason => {
          this.#pending.failure = new Error(`Native ${method} ${reason}; ${dispatched ? 'effect may already have occurred. Do not replay.' : 'no mutation was dispatched.'}`);
          void this.#terminate();
        };
        const aborted = () => cancel('aborted');
        const timer = setTimeout(() => cancel('timed out'), timeoutMs);
        this.#pending = { id, resolve: result => finish(null, result), reject: error => finish(error) };
        signal?.addEventListener('abort', aborted, { once: true });
        dispatched = method === 'act';
        child.stdin.write(`${line}\n`, error => {
          if (error && this.#pending?.id === id) { this.#pending.failure = error; void this.#terminate(); }
        });
      });
    });
    this.#tail = run.catch(() => {});
    return run;
  }

  observe(args, options) { return this.#request('observe', args, options); }
  screenshot(args, options) { return this.#request('screenshot', args, options); }
  act(args, options) { return this.#request('act', args, options); }

  async #terminate() {
    if (this.#stopping) return this.#stopping;
    const child = this.#child;
    if (!child) return;
    this.#stopping = new Promise(resolve => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 1000);
      child.once('close', () => { clearTimeout(timer); resolve(); });
      child.kill('SIGTERM');
    }).finally(() => { this.#stopping = undefined; });
    return this.#stopping;
  }

  async stop() {
    if (this.#closing) return this.#closing;
    const settled = this.#tail;
    this.#generation++;
    this.#closing = (async () => {
      await this.#terminate();
      await settled;
      await this.#terminate();
    })().finally(() => { this.#closing = undefined; });
    return this.#closing;
  }
}
