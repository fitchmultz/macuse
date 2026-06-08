# macuse doctor, demo, and config tools

Created: May 22, 2026
Status: Current operator entrypoints for proving the integration works

## Tools

```text
tools/macuse-doctor.mjs
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
- Node/script syntax,
- app-server Computer Use tool surface,
- direct raw-MCP discovery,
- app-server `list_apps`,
- app-server `get_app_state`, and
- config generation.

The full pass also runs:

- `node tools/validate-macuse.mjs focus`
- `node tools/validate-macuse.mjs mcp`

## Demo

Run the live demo:

```bash
node tools/macuse-demo.mjs --out .scratch/macuse-demo
```

Outputs:

- `report.md` — proof report
- `index.html` — visual dashboard with before/during/after screenshots
- `transcript.json` — exact commands and structured results
- `manifest.json` — compact artifact manifest
- `before.jpg` — Calculator before mutation
- `during.jpg` — Calculator after accessibility action sets display to `1`
- `after.jpg` — Calculator restored to `0`
- `cursor-mcp.json` — ready-to-copy MCP config for the current checkout
- `doctor/doctor.md` and `doctor/doctor.json` unless `--skip-doctor` is passed
- `mcp-validation.txt` unless `--skip-mcp` is passed

The demo proves:

1. Codex app-server exposes all expected Computer Use tools.
2. External Computer Use can capture app screenshots/state.
3. Calculator is reset before assertions so existing app state does not poison
   the demo.
4. Accessibility actions and keyboard input mutate Calculator without pointer
   clicks.
5. The display changes to `1`, changes to `2`, and is restored to `0`.
6. The frontmost app is not stolen by Calculator.
7. The guarded sequences restore mouse position.
8. The standard MCP wrapper validates, including app-approval elicitation and
   pointer guard behavior.

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
npm run demo
npm run config:cursor
npm run validate
npm run validate:focus
npm run validate:mcp
```
