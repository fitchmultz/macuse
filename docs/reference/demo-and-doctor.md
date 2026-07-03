# macuse doctor, demo, and config tools

Created: May 22, 2026
Status: Current operator entrypoints for proving the integration works

## Tools

```text
tools/macuse-doctor.mjs
tools/macuse-repair.mjs
tools/macuse-demo.mjs
tools/macuse-config.mjs
```

These are the high-level entrypoints. Lower-level bridge/probe scripts remain
available for focused debugging.

## Doctor

Run a health audit:

```bash
node tools/macuse-doctor.mjs --out .scratch/doctor
```

Run the full audit, including guarded mutating/focus and MCP wrapper smokes:

```bash
node tools/macuse-doctor.mjs --out .scratch/doctor-full --full
```

Outputs:

- `doctor.md` — Markdown verdict and check table
- `doctor.json` — machine-readable evidence

The standard doctor pass checks:

- repo root and expected local paths,
- Codex app-server binary and version,
- Computer Use plugin metadata,
- console frontmost app health,
- Node/script syntax,
- app-server Computer Use tool surface,
- direct raw-MCP discovery,
- app-server filtered/running `list_apps` for the target app, including a warning when Computer Use reports `frontmost=<none>`,
- app-server `get_app_state`, including classification for `cgWindowNotFound`, timeouts, and AppleEvents/TCC denials, and
- config generation.

The full pass also runs:

- `node tools/validate-macuse.mjs focus`
- `node tools/validate-macuse.mjs mcp`

## Repair

Preview optional repair actions without mutating state:

```bash
node tools/macuse-repair.mjs
```

Apply safe repair actions:

```bash
node tools/macuse-repair.mjs --apply
```

Safe apply mode:

- wakes the display with a short user-activity assertion,
- stops `ScreenSaver.Engine` if it is running, and
- removes stale `/tmp/macuse-appserver/macuse-appserver-*.json` records whose owner or app-server process no longer matches.

Additional auto-heal actions are opt-in because they can disrupt active local sessions or edit macOS privacy state:

```bash
# Restart only macuse-owned app-server processes recorded in /tmp/macuse-appserver.
node tools/macuse-repair.mjs --apply --restart-appserver

# Restart the global Computer Use service/helper stack when upstream service state is stale.
node tools/macuse-repair.mjs --apply --restart-service

# Unlock the console with a password supplied through an environment variable.
node tools/macuse-repair.mjs --apply --unlock-with-env MACUSE_UNLOCK_PASSWORD

# Add user TCC AppleEvents rows for the responsible launcher -> com.openai.sky.CUAService,
# back up the user TCC database, and restart tccd.
node tools/macuse-repair.mjs --apply --repair-tcc --responsible auto --restart-tccd --sudo-password-env MACUSE_SUDO_PASSWORD
```

The repair tool does **not** store or print passwords. It does not install third-party binaries. The unlock path compiles a temporary local Swift helper that posts HID events, then deletes the helper. `--repair-tcc --responsible auto` detects the responsible launcher from the current process tree (for example RepoPrompt or iTerm). `--repair-tcc` edits only the current user's TCC DB and writes a timestamped backup first, so the applying host needs Full Disk Access. `--restart-appserver` does not kill Codex's global `SkyComputerUseService` helper; use the separate `--restart-service` flag when that broader reset is intended. If broad unfiltered `list_apps` reports `procNotFound` but filtered/running `list_apps` and `get_app_state` pass, keep using filtered app lists and run `--restart-service` during a safe maintenance window.

## Demo

Run the live demo:

```bash
node tools/macuse-demo.mjs --out .scratch/macuse-demo
```

Outputs:

- `report.md` — proof report
- `index.html` — visual dashboard
- `transcript.json` — exact commands and structured results
- `manifest.json` — compact artifact manifest
- `cursor-mcp.json` — ready-to-copy MCP config for the current checkout
- `doctor/doctor.md` and `doctor/doctor.json` unless `--skip-doctor` is passed

The demo proves:

1. Codex app-server exposes all expected Computer Use tools.
2. External Computer Use can capture app screenshots/state.
3. Activity Monitor search is filtered and cleared after the search field name changes.
4. CPU/Memory tab actions work through accessibility actions without pointer clicks.
5. The sequence restores CPU/search state.
6. Native frontmost focus is unchanged.
7. The standard MCP wrapper validates, including app-approval elicitation and pointer guard behavior.

## Config generator

Generate a Cursor-compatible MCP config for the current checkout:

```bash
node tools/macuse-config.mjs cursor --pretty
```

Write it to a file:

```bash
node tools/macuse-config.mjs cursor --pretty --out configs/cursor-mcp.local.json
```

`configs/*.local.json` is gitignored so local generated configs can contain
machine-specific paths.

## npm scripts

```bash
npm run doctor
npm run doctor:full
npm run repair
npm run repair:apply
npm run demo
npm run config:cursor
npm run validate
npm run validate:focus
npm run validate:mcp
```
