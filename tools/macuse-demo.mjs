#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  REPO_ROOT,
  VERSION,
  commandLine,
  ensureDir,
  markdownTable,
  nowIsoForPath,
  parseJsonOutput,
  runCommand,
  writeJsonFile,
} from "./macuse-utils.mjs";

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
/** @typedef {{ help?: false, out: string, skipDoctor: boolean, skipMcp: boolean, toolTimeoutMs: number }} DemoRunOptions */
/** @typedef {{ name: string, command: string, durationMs: number, ok: boolean, status: number | null, stdout: string, stderr: string, json: unknown }} JsonCommand */
/** @typedef {{ name: string, command: string, ok: boolean, durationMs: number, stdout: string, stderr: string, status?: number | null, json?: unknown }} CommandRecord */
/** @typedef {{ ok: boolean, generatedAt: string, out: string, repoRoot: string, status: { doctor: boolean | null, mutating: boolean, focus: boolean, mcp: boolean | null }, artifacts: { report: string, html: string, transcript: string, cursorConfig: string } }} DemoReport */
/** @typedef {{ generatedAt: string, out: string, commands: CommandRecord[], report?: DemoReport }} Transcript */

function help() {
  process.stdout.write(
    `macuse live demo ${VERSION}\n\nUsage:\n  node tools/macuse-demo.mjs [options]\n\nOptions:\n  --out <dir>              Artifact directory. Default: .scratch/macuse-demo-<timestamp>.\n  --skip-doctor            Skip the embedded standard doctor pass.\n  --skip-mcp               Skip the standard-MCP wrapper validation pass.\n  --tool-timeout-ms <ms>   Tool timeout for live checks. Default: 90000.\n  -h, --help               Show this help.\n\nWhat it proves:\n  - native persistent JavaScript Computer Use works outside Codex\n  - the shared session supports a real Activity Monitor app flow\n  - tab actions restore the actual original selection\n  - native activation observations report any observed interruption\n  - standard MCP inventory/read/guard checks pass, unless --skip-mcp is passed\n\nExamples:\n  node tools/macuse-demo.mjs\n  node tools/macuse-demo.mjs --out .scratch/demo\n`,
  );
}

/**
 * @param {string[]} argv
 * @returns {{ help: true } | DemoRunOptions}
 */
function parse(argv) {
  if (argv.includes("-h") || argv.includes("--help")) return { help: true };
  /** @type {DemoRunOptions} */
  const opts = {
    out: resolve(REPO_ROOT, ".scratch", `macuse-demo-${nowIsoForPath()}`),
    skipDoctor: false,
    skipMcp: false,
    toolTimeoutMs: 90_000,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined) throw new Error("unknown option: undefined");
    const next = () => {
      i += 1;
      const value = argv[i];
      if (i >= argv.length || value === undefined) throw new Error(`${token} requires a value`);
      return value;
    };
    if (token === "--out") opts.out = resolve(next());
    else if (token === "--skip-doctor") opts.skipDoctor = true;
    else if (token === "--skip-mcp") opts.skipMcp = true;
    else if (token === "--tool-timeout-ms") {
      const n = Number(next());
      if (!Number.isInteger(n) || n <= 0)
        throw new Error("--tool-timeout-ms must be a positive integer");
      opts.toolTimeoutMs = n;
    } else throw new Error(`unknown option: ${token}`);
  }
  return opts;
}

/**
 * @param {string} name
 * @param {string[]} args
 * @param {number} timeoutMs
 * @returns {JsonCommand}
 */
function runJsonCommand(name, args, timeoutMs) {
  const result = runCommand(name, process.execPath, args, { timeoutMs });
  return {
    name,
    command: commandLine(process.execPath, args),
    durationMs: result.durationMs,
    ok: result.ok,
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    json: result.ok ? parseJsonOutput(name, result.stdout) : null,
  };
}

/**
 * @param {boolean | null} status
 * @returns {string}
 */
const statusIcon = (status) => {
  if (status === null) return "skipped";
  return status ? "✅" : "❌";
};
/**
 * @param {DemoReport} report
 * @returns {string}
 */
function renderReport(report) {
  return `# macuse live demo\n\nGenerated: ${report.generatedAt}\nArtifact directory: ${report.out}\n\n## Verdict\n\n${report.ok ? "✅ macuse actual-app demo passed." : "❌ Demo found a problem. Inspect transcript.json."}\n\n${markdownTable(
    ["Proof point", "Status", "Evidence"],
    [
      [
        "Doctor",
        statusIcon(report.status.doctor),
        report.status.doctor === null ? "not run" : "standard checks passed",
      ],
      [
        "Activity Monitor mutation",
        report.status.mutating ? "✅" : "❌",
        "native JavaScript selects an alternate tab and restores the captured original",
      ],
      [
        "Background focus",
        report.status.focus ? "✅" : "❌",
        "no target activation observed during this controlled run; attribution unknown",
      ],
      [
        "MCP wrapper",
        statusIcon(report.status.mcp),
        report.status.mcp === null
          ? "not run"
          : "native runtime, schemas and pre-dispatch refusal passed",
      ],
    ],
  )}\n\n## Artifacts\n\n${markdownTable(
    ["Artifact", "Path"],
    [
      ["Report", "report.md"],
      ["HTML dashboard", "index.html"],
      ["Transcript", "transcript.json"],
      ["Cursor MCP config", "cursor-mcp.json"],
    ],
  )}\n\n## Re-run\n\n\`\`\`bash\nnode tools/macuse-demo.mjs --out ${report.out}\n\`\`\`\n`;
}

/**
 * @param {DemoReport} report
 * @returns {string}
 */
function renderHtml(report) {
  /** @param {unknown} value @returns {string} */
  const safe = (value) => escapeHtml(typeof value === "string" ? value : JSON.stringify(value));
  /** @param {string} value @returns {string} */
  const escapeHtml = (value) => value.replace(/[&<>]/g, escapeChar);
  /** @param {string} char @returns {string} */
  const escapeChar = (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[char] ?? char;
  const badge = report.ok
    ? '<span class="badge pass">READY</span>'
    : '<span class="badge fail">CHECK</span>';
  return `<!doctype html><meta charset="utf-8"><title>macuse live demo</title><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:40px;background:#0b1020;color:#edf2ff}.card{background:#151b2f;border:1px solid #29324d;border-radius:18px;padding:24px;margin:18px 0}.badge{display:inline-block;padding:8px 12px;border-radius:999px;font-weight:800}.pass{background:#143d2a;color:#75f0ac}.fail{background:#4a1820;color:#ff8fa3}td,th{border-bottom:1px solid #29324d;padding:10px;text-align:left}</style><h1>macuse actual-app demo ${badge}</h1><p>Generated ${safe(report.generatedAt)}</p><div class="card"><h2>Proof</h2><table><tr><th>Check</th><th>Status</th></tr><tr><td>Doctor</td><td>${safe(report.status.doctor)}</td></tr><tr><td>Activity Monitor mutation</td><td>${safe(report.status.mutating)}</td></tr><tr><td>Background focus</td><td>${safe(report.status.focus)}</td></tr><tr><td>MCP wrapper</td><td>${safe(report.status.mcp)}</td></tr></table></div><div class="card"><h2>Artifacts</h2><ul><li><a href="report.md">report.md</a></li><li><a href="transcript.json">transcript.json</a></li><li><a href="cursor-mcp.json">cursor-mcp.json</a></li></ul></div>`;
}

async function main() {
  const opts = parse(process.argv.slice(2));
  if (opts.help === true) {
    help();
    return;
  }
  ensureDir(opts.out);

  /** @type {Transcript} */
  const transcript = { generatedAt: new Date().toISOString(), out: opts.out, commands: [] };
  const cursorConfigPath = resolve(opts.out, "cursor-mcp.json");
  const config = runCommand(
    "generate Cursor MCP config",
    process.execPath,
    ["tools/macuse-config.mjs", "cursor", "--pretty", "--out", cursorConfigPath],
    { timeoutMs: 30_000 },
  );
  transcript.commands.push({
    name: "generate Cursor MCP config",
    command: commandLine(process.execPath, [
      "tools/macuse-config.mjs",
      "cursor",
      "--pretty",
      "--out",
      cursorConfigPath,
    ]),
    ok: config.ok,
    durationMs: config.durationMs,
    stdout: config.stdout,
    stderr: config.stderr,
  });

  const doctor = opts.skipDoctor
    ? null
    : runJsonCommand(
        "macuse doctor",
        [
          "tools/macuse-doctor.mjs",
          "--out",
          resolve(opts.out, "doctor"),
          "--json",
          "--tool-timeout-ms",
          String(opts.toolTimeoutMs),
        ],
        opts.toolTimeoutMs * 4,
      );
  if (doctor !== null) transcript.commands.push(doctor);

  const focus = runJsonCommand(
    "background focus validation",
    [
      "tools/validate-macuse.mjs",
      "focus",
      "--json",
      "--tool-timeout-ms",
      String(opts.toolTimeoutMs),
    ],
    600_000,
  );
  transcript.commands.push(focus);

  const mcp = opts.skipMcp
    ? null
    : runJsonCommand(
        "MCP wrapper validation",
        [
          "tools/validate-macuse.mjs",
          "mcp",
          "--json",
          "--tool-timeout-ms",
          String(opts.toolTimeoutMs),
        ],
        600_000,
      );
  if (mcp !== null) transcript.commands.push(mcp);

  // A skipped check is neutral for the verdict, matching the pre-typing
  // behavior of (doctor ? doctor.json?.ok === true : true).
  const doctorOk = doctor === null || (isRecord(doctor.json) && doctor.json.ok === true);
  const focusOk = isRecord(focus.json) && focus.json.ok === true;
  const mcpOk = mcp === null || (isRecord(mcp.json) && mcp.json.ok === true);
  /** @type {DemoReport} */
  const report = {
    ok: config.ok && doctorOk && focusOk && mcpOk,
    generatedAt: transcript.generatedAt,
    out: opts.out,
    repoRoot: REPO_ROOT,
    status: {
      doctor: doctor !== null ? doctorOk : null,
      mutating: focusOk,
      focus: focusOk,
      mcp: mcp !== null ? mcpOk : null,
    },
    artifacts: {
      report: resolve(opts.out, "report.md"),
      html: resolve(opts.out, "index.html"),
      transcript: resolve(opts.out, "transcript.json"),
      cursorConfig: cursorConfigPath,
    },
  };

  transcript.report = report;
  writeJsonFile(resolve(opts.out, "transcript.json"), transcript);
  writeJsonFile(resolve(opts.out, "manifest.json"), report);
  writeFileSync(resolve(opts.out, "report.md"), renderReport(report));
  writeFileSync(resolve(opts.out, "index.html"), renderHtml(report));

  process.stdout.write(
    `macuse demo complete\nreport: ${resolve(opts.out, "report.md")}\nhtml:   ${resolve(opts.out, "index.html")}\nok:     ${report.ok}\n`,
  );
  if (!report.ok) process.exitCode = 1;
}

/** @param {unknown} error @returns {string} */
const failureText = (error) => {
  if (error instanceof Error && error.message !== "") return error.message;
  return String(error);
};
main().catch((/** @type {unknown} */ error) => {
  process.stderr.write(`FAIL ${failureText(error)}\n`);
  process.exitCode = 1;
});
