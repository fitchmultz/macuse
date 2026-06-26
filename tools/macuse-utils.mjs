import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TOOLS_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(TOOLS_DIR, '..');

/** Canonical package version. Single source of truth; read from package.json once. */
export const VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8'));
    if (pkg && typeof pkg.version === 'string') return pkg.version;
  } catch {
    // Fall through; readFileSync failure is unrecoverable for a tool run from the repo.
  }
  throw new Error(`macuse: could not read version from ${resolve(REPO_ROOT, 'package.json')}`);
})();
export const DEFAULT_CODEX_BIN = '/Applications/Codex.app/Contents/Resources/codex';
export const DEFAULT_COMPUTER_USE_PLUGIN_ROOT = '/Users/yourname/.codex/plugins/cache/openai-bundled/computer-use';
export const DEFAULT_COMPUTER_USE_PLUGIN_DIR = discoverComputerUsePluginDir();
export const DEFAULT_COMPUTER_USE_APP = '/Users/yourname/.codex/computer-use/Codex Computer Use.app';
export const COMPUTER_USE_TOOL_NAMES = ['click', 'drag', 'get_app_state', 'list_apps', 'perform_secondary_action', 'press_key', 'scroll', 'select_text', 'set_value', 'type_text'];

function compareVersionLike(a, b) {
  const aa = a.split(/[^0-9]+/).filter(Boolean).map(Number);
  const bb = b.split(/[^0-9]+/).filter(Boolean).map(Number);
  for (let i = 0; i < Math.max(aa.length, bb.length); i += 1) {
    const delta = (aa[i] || 0) - (bb[i] || 0);
    if (delta !== 0) return delta;
  }
  return a.localeCompare(b);
}

export function discoverComputerUsePluginDir(root = DEFAULT_COMPUTER_USE_PLUGIN_ROOT, opts = {}) {
  try {
    const entries = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort(compareVersionLike)
      .reverse();
    const found = entries.find((entry) => existsSync(resolve(root, entry, '.mcp.json')));
    if (found) return resolve(root, found);
  } catch {
    // Fall back to latest path observed when this helper was updated.
  }
  return opts.fallback === false ? null : resolve(root, '1.0.809');
}

export function nowIsoForPath(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

export function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

export function writeJsonFile(path, value) {
  ensureDir(dirname(path));
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function readJsonFile(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function isExecutable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function fileExists(path) {
  return existsSync(path);
}

export function runCommand(name, command, args = [], opts = {}) {
  const started = Date.now();
  const result = spawnSync(command, args, {
    cwd: opts.cwd || REPO_ROOT,
    env: { ...process.env, ...(opts.env || {}) },
    encoding: 'utf8',
    input: opts.input,
    timeout: opts.timeoutMs || 120_000,
    maxBuffer: opts.maxBuffer || 20 * 1024 * 1024,
  });
  return {
    name,
    command,
    args,
    cwd: opts.cwd || REPO_ROOT,
    durationMs: Date.now() - started,
    status: result.status,
    signal: result.signal,
    error: result.error ? result.error.message : null,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    ok: !result.error && result.status === 0,
  };
}

export function mustRun(name, command, args = [], opts = {}) {
  const result = runCommand(name, command, args, opts);
  if (!result.ok) {
    const detail = result.error || result.stderr || result.stdout || `exit ${result.status}`;
    throw new Error(`${name} failed: ${detail.trim().slice(0, 2000)}`);
  }
  return result;
}

export function parseJsonOutput(label, text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${error.message}\n${text.slice(0, 1000)}`);
  }
}

export function frontmostApp() {
  const front = runCommand('frontmost asn', '/usr/bin/lsappinfo', ['front'], { timeoutMs: 5000 });
  if (!front.ok || !front.stdout.trim()) return null;
  const asn = front.stdout.trim();
  const bundle = runCommand('frontmost bundle id', '/usr/bin/lsappinfo', ['info', '-only', 'bundleid', asn], { timeoutMs: 5000 });
  const name = runCommand('frontmost name', '/usr/bin/lsappinfo', ['info', '-only', 'name', asn], { timeoutMs: 5000 });
  return {
    asn,
    bundleId: (bundle.stdout.match(/="([^"]+)"/) || [])[1] || null,
    name: (name.stdout.match(/="([^"]+)"/) || [])[1] || null,
  };
}

export function mousePosition() {
  const script = 'import CoreGraphics; if let e = CGEvent(source: nil) { let p = e.location; print(Int(p.x), Int(p.y)) }';
  const result = runCommand('mouse position', 'swift', ['-e', script], { timeoutMs: 10_000 });
  if (!result.ok) return null;
  const [x, y] = result.stdout.trim().split(/\s+/).map((value) => Number(value));
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

export function sha256File(path) {
  const hash = createHash('sha256');
  hash.update(readFileSync(path));
  return hash.digest('hex');
}

export function imageInfo(path) {
  if (!existsSync(path)) return null;
  const result = runCommand('image info', 'sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', path], { timeoutMs: 10_000 });
  const width = Number((result.stdout.match(/pixelWidth:\s*(\d+)/) || [])[1]);
  const height = Number((result.stdout.match(/pixelHeight:\s*(\d+)/) || [])[1]);
  return {
    path: resolve(path),
    bytes: readFileSync(path).byteLength,
    sha256: sha256File(path),
    width: Number.isFinite(width) ? width : null,
    height: Number.isFinite(height) ? height : null,
  };
}

export function toolText(result) {
  return (result?.content || [])
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

export function stepText(step) {
  return toolText(step?.result);
}

export function markdownEscape(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, '<br>');
}

export function markdownTable(headers, rows) {
  const header = `| ${headers.map(markdownEscape).join(' | ')} |`;
  const sep = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => `| ${row.map(markdownEscape).join(' | ')} |`);
  return [header, sep, ...body].join('\n');
}

export function commandLine(command, args = []) {
  return [command, ...args].map((part) => (/^[A-Za-z0-9_./:=@-]+$/.test(part) ? part : JSON.stringify(part))).join(' ');
}
