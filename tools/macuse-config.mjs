#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ensureDir, REPO_ROOT, VERSION } from "./macuse-utils.mjs";

const WRAPPER = resolve(REPO_ROOT, "tools/macuse-mcp.mjs");

/** @typedef {{ help: boolean, client: string, out: string | null, server: string, cwd: string, pretty: boolean }} ConfigOptions */

function help() {
  process.stdout.write(
    `macuse config ${VERSION}\n\nUsage:\n  node tools/macuse-config.mjs cursor [options]\n  node tools/macuse-config.mjs claude-desktop [options]\n\nOptions:\n  --out <path>       Write config to a file instead of stdout.\n  --server <name>    MCP server name. Default: macuse.\n  --cwd <path>       MACUSE_CWD. Default: repo root.\n  --pretty           Pretty-print JSON.\n  -h, --help         Show this help.\n\nExamples:\n  node tools/macuse-config.mjs cursor --pretty\n  node tools/macuse-config.mjs cursor --out configs/cursor-mcp.local.json --pretty\n`,
  );
}

/**
 * @param {string[]} argv
 * @returns {ConfigOptions}
 */
function parse(argv) {
  /** @type {ConfigOptions} */
  const opts = {
    help: false,
    client: "cursor",
    out: null,
    server: "macuse",
    cwd: REPO_ROOT,
    pretty: false,
  };
  if (argv.includes("-h") || argv.includes("--help")) {
    opts.help = true;
    return opts;
  }
  const shifted = argv.shift();
  const client = shifted !== undefined && shifted !== "" ? shifted : "cursor";
  if (!["cursor", "claude-desktop"].includes(client)) throw new Error(`unknown client: ${client}`);
  opts.client = client;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = () => {
      i += 1;
      const value = argv[i];
      if (value === undefined) throw new Error(`${String(token)} requires a value`);
      return value;
    };
    if (token === "--out") opts.out = next();
    else if (token === "--server") opts.server = next();
    else if (token === "--cwd") opts.cwd = resolve(next());
    else if (token === "--pretty") opts.pretty = true;
    else throw new Error(`unknown option: ${String(token)}`);
  }
  return opts;
}

/**
 * @param {ConfigOptions} opts
 * @returns {{ mcpServers: Record<string, { command: string, args: string[], env: Record<string, string> }> }}
 */
function buildConfig(opts) {
  return {
    mcpServers: {
      [opts.server]: {
        command: "node",
        args: [WRAPPER],
        env: {
          MACUSE_CWD: opts.cwd,
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
  if (opts.out !== null) {
    const path = resolve(opts.out);
    ensureDir(dirname(path));
    writeFileSync(path, json);
    process.stdout.write(`${path}\n`);
  } else {
    process.stdout.write(json);
  }
}

main();
