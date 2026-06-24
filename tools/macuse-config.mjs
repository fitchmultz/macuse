#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ensureDir, REPO_ROOT, VERSION } from './macuse-utils.mjs';

const WRAPPER = resolve(REPO_ROOT, 'tools/codex-computer-use-appserver-mcp.mjs');

function help() {
  process.stdout.write(`macuse config ${VERSION}\n\nUsage:\n  node tools/macuse-config.mjs cursor [options]\n  node tools/macuse-config.mjs claude-desktop [options]\n\nOptions:\n  --out <path>       Write config to a file instead of stdout.\n  --server <name>    MCP server name. Default: macuse-codex-computer-use.\n  --cwd <path>       CODEX_CU_MCP_CWD. Default: repo root.\n  --pretty           Pretty-print JSON.\n  -h, --help         Show this help.\n\nExamples:\n  node tools/macuse-config.mjs cursor --pretty\n  node tools/macuse-config.mjs cursor --out configs/cursor-mcp.local.json --pretty\n`);
}

function parse(argv) {
  if (argv.includes('-h') || argv.includes('--help')) return { help: true };
  const client = argv.shift() || 'cursor';
  if (!['cursor', 'claude-desktop'].includes(client)) throw new Error(`unknown client: ${client}`);
  const opts = { client, out: null, server: 'macuse-codex-computer-use', cwd: REPO_ROOT, pretty: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`${token} requires a value`);
      return argv[i];
    };
    if (token === '--out') opts.out = next();
    else if (token === '--server') opts.server = next();
    else if (token === '--cwd') opts.cwd = resolve(next());
    else if (token === '--pretty') opts.pretty = true;
    else throw new Error(`unknown option: ${token}`);
  }
  return opts;
}

function buildConfig(opts) {
  return {
    mcpServers: {
      [opts.server]: {
        command: 'node',
        args: [WRAPPER],
        env: {
          CODEX_CU_MCP_CWD: opts.cwd,
        },
      },
    },
  };
}

function main() {
  const opts = parse(process.argv.slice(2));
  if (opts.help) {
    help();
    return;
  }
  const config = buildConfig(opts);
  const json = `${JSON.stringify(config, null, opts.pretty ? 2 : 0)}\n`;
  if (opts.out) {
    const path = resolve(opts.out);
    ensureDir(dirname(path));
    writeFileSync(path, json);
    process.stdout.write(`${path}\n`);
  } else {
    process.stdout.write(json);
  }
}

main();
