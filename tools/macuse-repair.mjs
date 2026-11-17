#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { REPO_ROOT, VERSION, ensureDir, writeJsonFile } from "./macuse-utils.mjs";
import { MacOSNative } from "./macos-native.mjs";
import { add, reapRegistry } from "./macuse-repair-process.mjs";
import {
  stopComputerUseService,
  stopMacuseAppservers,
  unlockConsole,
  wakeAndStopScreensaver,
} from "./macuse-repair-steps.mjs";

/** @typedef {import("./macuse-repair-process.mjs").RepairOptions} RepairOptions */
/** @typedef {import("./macuse-repair-process.mjs").RepairReport} RepairReport */

function help() {
  process.stdout
    .write(`macuse repair ${VERSION}\n\nUsage:\n  node tools/macuse-repair.mjs [options]\n\nDefault mode is dry-run. Pass --apply to make safe local repairs.\n\nOptions:\n  --apply                         Perform safe repairs: wake display, stop screensaver, reap stale registry files.\n  --restart-appserver             With --apply, stop macuse-owned codex app-server processes from registry records.\n  --restart-service               With --apply, stop global SkyComputerUseService and SkyComputerUseClient mcp helpers.\n  --unlock-with-env <VAR>         With --apply, unlock the console using a password stored in environment variable VAR.\n                                  Uses a temporary local Swift HID-event helper; the password is not placed in argv.\n  --prompt-permissions            With --apply, check Accessibility for Macuse Helper and trigger the macOS prompt if needed.\n  --out <path>                    Write machine-readable report JSON.\n  --json                          Print JSON instead of Markdown.\n  -h, --help                      Show this help.\n\nExamples:\n  node tools/macuse-repair.mjs\n  node tools/macuse-repair.mjs --apply\n  node tools/macuse-repair.mjs --apply --restart-appserver
  node tools/macuse-repair.mjs --apply --restart-service\n  node tools/macuse-repair.mjs --apply --unlock-with-env MACUSE_UNLOCK_PASSWORD\n  node tools/macuse-repair.mjs --apply --prompt-permissions\n\nSafety:\n  --prompt-permissions uses macOS's native Accessibility prompt for Macuse Helper; it never edits TCC databases.\n  --restart-appserver stops macuse-owned app-server records only. --restart-service is separate and broader.\n  No sends, deletes, purchases, installs, or unrequested privacy changes are performed.\n`);
}

/**
 * @param {string} token
 * @returns {Partial<RepairOptions>}
 */
function repairFlag(token) {
  if (token === "--apply") {
    return { apply: true };
  }
  if (token === "--restart-appserver") {
    return { restartAppserver: true };
  }
  if (token === "--restart-service") {
    return { restartService: true };
  }
  if (token === "--prompt-permissions") {
    return { promptPermissions: true };
  }
  if (token === "--json") {
    return { json: true };
  }
  return {};
}

/**
 * @param {string} token
 * @param {() => string} next
 * @returns {Partial<RepairOptions>}
 */
function repairValue(token, next) {
  if (token === "--unlock-with-env") {
    return { unlockEnv: next() };
  }
  if (token === "--out") {
    return { out: resolve(next()) };
  }
  return {};
}

/**
 * @param {string[]} argv
 * @returns {RepairOptions}
 */
function parse(argv) {
  /** @type {RepairOptions} */
  const opts = {
    help: false,
    apply: false,
    restartAppserver: false,
    restartService: false,
    unlockEnv: null,
    promptPermissions: false,
    out: null,
    json: false,
  };
  if (argv.includes("-h") || argv.includes("--help")) {
    opts.help = true;
    return opts;
  }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] ?? "";
    const next = () => {
      i += 1;
      const value = argv[i];
      if (value === undefined) {
        throw new Error(`${token} requires a value`);
      }
      return value;
    };
    const flags = repairFlag(token);
    if (Object.keys(flags).length > 0) {
      Object.assign(opts, flags);
      continue;
    }
    const values = repairValue(token, next);
    if (Object.keys(values).length > 0) {
      Object.assign(opts, values);
      continue;
    }
    throw new Error(`unknown option: ${token}`);
  }
  return opts;
}

/**
 * @param {RepairReport} report
 * @returns {string}
 */
function renderMarkdown(report) {
  const rows = report.actions
    .map(
      (action) =>
        `| ${action.status} | ${action.name} | ${action.summary.replaceAll("|", "\\|")} |`,
    )
    .join("\n");
  return `# macuse repair report\n\nGenerated: ${report.generatedAt}\nMode: ${report.apply ? "apply" : "dry-run"}\nRepo: ${REPO_ROOT}\n\n| Status | Action | Summary |\n| --- | --- | --- |\n${
    rows.length > 0 ? rows : "| ok | no-op | no actions requested |"
  }\n\nRun doctor after repair:\n\n\`\`\`bash\nnode tools/macuse-doctor.mjs --out .scratch/doctor\n\`\`\`\n`;
}

/**
 * @param {RepairOptions} opts
 * @returns {Record<string, unknown>}
 */
function reportOptions(opts) {
  return {
    apply: opts.apply,
    restartAppserver: opts.restartAppserver,
    restartService: opts.restartService,
    unlockEnv: opts.unlockEnv !== null && opts.unlockEnv !== "" ? opts.unlockEnv : null,
    promptPermissions: opts.promptPermissions,
    out: opts.out,
    json: opts.json,
  };
}

/**
 * @param {{ accessibilityTrusted: boolean, prompted: boolean }} status
 * @returns {string}
 */
function accessibilityRepairSummary(status) {
  if (status.accessibilityTrusted) {
    return "Accessibility is already enabled for Macuse Helper.";
  }
  if (status.prompted) {
    return "Accessibility prompt opened for Macuse Helper; approve once in System Settings > Privacy & Security > Accessibility.";
  }
  return "Accessibility is still off for Macuse Helper.";
}

/**
 * @param {RepairReport} report
 * @param {boolean} apply
 * @param {boolean} requested
 * @returns {Promise<void>}
 */
async function promptAccessibilityRepair(report, apply, requested) {
  if (!requested) {
    return;
  }
  if (!apply) {
    add(report, {
      status: "would-fix",
      name: "prompt_permissions",
      summary:
        "would check Accessibility for Macuse Helper and open the macOS prompt if not yet granted",
      details: { bundleId: "com.fitchmultz.macuse.helper" },
    });
    return;
  }
  const native = new MacOSNative();
  try {
    const status = await native.ensureAccessibility({ prompt: true });
    add(report, {
      status: status.accessibilityTrusted || status.prompted ? "fixed" : "warn",
      name: "prompt_permissions",
      summary: accessibilityRepairSummary(status),
      details: status,
    });
  } catch (error) {
    add(report, {
      status: "fail",
      name: "prompt_permissions",
      summary: error instanceof Error ? error.message : String(error),
      details: null,
    });
  } finally {
    await native.stop();
  }
}

async function main() {
  const opts = parse(process.argv.slice(2));
  if (opts.help) {
    help();
    return;
  }
  /** @type {RepairReport} */
  const report = {
    ok: false,
    generatedAt: new Date().toISOString(),
    apply: opts.apply,
    options: reportOptions(opts),
    actions: [],
  };
  wakeAndStopScreensaver(report, opts.apply);
  reapRegistry(report, opts.apply);
  if (opts.restartAppserver) {
    stopMacuseAppservers(report, opts.apply);
  }
  if (opts.restartService) {
    stopComputerUseService(report, opts.apply);
  }
  unlockConsole(report, opts.apply, opts.unlockEnv);
  await promptAccessibilityRepair(report, opts.apply, opts.promptPermissions);
  report.ok = report.actions.every((action) => action.status !== "fail");
  if (opts.out !== null) {
    ensureDir(dirname(opts.out));
    writeJsonFile(opts.out, report);
  }
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(renderMarkdown(report));
  }
  if (!report.ok) {
    process.exitCode = 1;
  }
}

main().catch((/** @type {unknown} */ error) => {
  const message = error instanceof Error ? error.message : "";
  process.stderr.write(`FAIL ${message !== "" ? message : String(error)}\n`);
  process.exitCode = 1;
});
