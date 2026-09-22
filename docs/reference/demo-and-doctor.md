# Validation and diagnostics

Choose checks by their real effects. A documented command is a procedure, not a claim that it passed on the current host. Keep screenshots, AX text, and transcripts local when they contain private content.

## Validation modes

```bash
node tools/validate-macuse.mjs extension
node tools/validate-macuse.mjs quick
node tools/validate-macuse.mjs read-only
node tools/validate-macuse.mjs mutating
node tools/validate-macuse.mjs focus
node tools/validate-macuse.mjs mcp
```

| Mode | Scope |
| --- | --- |
| `extension` | Offline extension/contract checks; no live desktop or vendor service access. |
| `quick` | Runtime/package checks and installed-service discovery; requires local vendor components. |
| `read-only` | Live app inventory and state observations, without requested input actions. Reads can expose private content or open an app/window. |
| `mutating` | Controlled Activity Monitor actions, with the actual original selected tab captured and restored in `finally`. |
| `focus` | Controlled mutation plus native focus observations; coverage and attribution limits remain explicit. |
| `mcp` | Standard MCP transport, eleven-tool inventory, routing, and guard checks; inspect current help for its live probes. |

Use `--help` for current options and `--json` for machine-readable results. Offline compatibility checks do not certify macOS permissions, native runtime behavior, or every host. Latest stable official Pi and `fitchmultz/pi` 0.87.0 both need qualification through their public APIs; one host's result is not the other's evidence.

The credential-free host probe exercises real Pi hooks, image normalization, both Responses adapters, schema binding, and image-removal policy with synthetic fixtures and no network:

```bash
node tools/validate-pi-host.mjs
# Optionally select an installed Pi package directory explicitly.
node tools/validate-pi-host.mjs /absolute/path/to/pi-coding-agent
```

`npm run check:compat` includes this probe alongside types, tests, offline extension checks, and dry-run packaging.

For mutating/focus checks, no action should run unless Activity Monitor's original tab is known. Restore that exact tab and verify it after the test; never force CPU as cleanup. Do not terminate processes or modify unrelated Activity Monitor controls. A kernel reset may interrupt cleanup, so inspect the final result and restore only from known evidence. Raw-MCP diagnostics are kept separate from non-interruption checks.

## Doctor

```bash
node tools/macuse-doctor.mjs --out .scratch/doctor
```

The default audit is read-only. It checks local prerequisites, runtime/configuration health, and app observation, and writes `doctor.md` and `doctor.json`. Run under the same launcher as the failing Pi/MCP session when possible: Accessibility and Automation grants are host-specific.

Only request the full audit when controlled UI changes are authorized:

```bash
node tools/macuse-doctor.mjs --out .scratch/doctor-full --full
```

`--full` includes live mutating/focus checks. It is not a read-only health check.

## Demo

```bash
node tools/macuse-demo.mjs --out .scratch/macuse-demo
```

The demo is a live, controlled Activity Monitor tab workflow. It captures the original selection, changes tabs through the native API, and restores the original in `finally`. Review the generated report and transcript, including cleanup and focus coverage, before calling the run successful. Reports demonstrate that run's observations, not universal non-interruption or performance guarantees. Save screenshots separately with `saveImagePath` when visual artifacts are needed.

## Inspect schemas and generate config

These commands inspect the interface or print configuration without requesting GUI actions:

```bash
node tools/macuse.mjs tools --pretty
node tools/macuse.mjs status
node tools/macuse-config.mjs cursor --pretty
node tools/macuse-config.mjs claude-desktop --pretty
```

CLI `status` reports its own session; it does not inspect another Pi/MCP process. The config generator supports `--out` for an explicit file destination. See [MCP setup](cursor-mcp-setup.md).

For a live observation:

```bash
node tools/macuse.mjs call macuse '{"code":"var app = await cua.getApp(\"Activity Monitor\")"}'
```

Use `node tools/macuse.mjs session` for multiple calls sharing JavaScript bindings and observations. Each input line has `{ "tool": "macuse", "input": { "code": "await cua.getState()" } }`; separate `call` processes do not share state.

## Diagnose before repair

- **Missing compiler/AX access:** report the exact `xcrun swiftc` or Accessibility failure. Do not install tools or grant permissions implicitly.
- **AppleEvents/TCC failures:** `-609`, `-1712`, `-1743`, and denial logs can identify the responsible launcher's missing Automation access. Preserve the error; do not report it as an empty app list. Use supported system/vendor permission flows.
- **Missing window/locked console:** `cgWindowNotFound` or `frontmost=<none>` can reflect console/window state. Ask for the concrete user action needed; do not attempt automatic unlocking.
- **Timeout/unknown action:** inspect partial evidence and fresh app state after settlement. Do not replay the mutation. A reset cannot prove UI cancellation.
- **Stale bindings:** `macuse_reset({})` or Pi `/macuse-reset` clears owned JavaScript/observations. `/macuse-stop` stops the session's processes without killing global Computer Use helpers. Neither undoes application effects.

The retained `tools/macuse-repair.mjs` is dry-run by default. Its apply paths can wake/unlock the console, stop processes, or alter privacy state; they are not routine setup or an implicit fix. Do not use TCC database editing as a permission bypass. Broader repairs require exact user authorization and inspection of the requested effects.

`tools/probe-codex-computer-use-mcp.mjs` remains for non-mutating raw-MCP discovery and denial diagnostics. Historical raw MCP calls could hang or affect focus, so their results are not authoritative for the native v0.5.0 GUI path. See [historical findings](codex-computer-use-external-harness.md#historical-findings).
