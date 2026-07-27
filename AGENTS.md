# macuse agent instructions

This repo investigates OpenAI Codex Computer Use reuse from non-Codex agents such as pi.

## Canonical paths

- High-level live demo: `tools/macuse-demo.mjs`
- Health audit: `tools/macuse-doctor.mjs`
- Client config generator: `tools/macuse-config.mjs`
- Working app-server bridge: `tools/codex-computer-use-appserver.mjs`
- Standard MCP wrapper for Cursor/non-pi clients: `tools/codex-computer-use-appserver-mcp.mjs`
- Shared app-server/MCP helper module: `tools/cu-helpers.mjs`
- Direct raw-MCP probe harness: `tools/probe-codex-computer-use-mcp.mjs`
- Installable pi extension source with persistent app-server session: `extensions/codex-computer-use.ts` plus modules in `extensions/codex-computer-use-modules/`
- Main findings: `docs/reference/codex-computer-use-external-harness.md`
- Local install facts: `docs/reference/codex-computer-use-local-install.md`
- Safety policy: `docs/reference/codex-computer-use-safety-policy.md`

## Development policy

- No backwards-compatibility shims for Codex app-server, Computer Use, or pi extension APIs during development. Cut fully to the protocol and runtime shape required by the currently installed pi and Codex Computer Use versions, update all repo tools/docs/tests together, and remove stale aliases instead of carrying compatibility paths.

## Safety

- Read-only Computer Use probes are allowed: `list_apps`, `get_app_state`, `event_stream_status`, `computer_history_status`, and `computer_history_get_settings`; the auxiliary status/settings calls can expose activity, artifact, and privacy metadata.
- Record & Replay starts and Computer History resume require exact user intent plus `allowRecording: true` and a non-empty safety note. `computer_history_update_settings` requires exact approval plus `allowPrivacyChange: true`, a safety note, and the complete `observation` settings object. Event-stream stop and Computer History pause are allowed without those flags.
- The pi extension exposes all 18 live upstream tools directly plus `macuse_sequence` and `macuse_restart`. Mutating GUI tools require a narrow target, a recent `get_app_state`, `allowMutating: true`, and a safety note; use `macuse_sequence` when ordered before/after evidence or waits matter. For element-targeted actions, prefer stable `elementId`, then exact `elementDescription`, unique role/name, and only then guarded `element_index`. If a sequence fails, inspect completed steps plus the failed-step diagnostic before retrying.
- Preserve the user's mouse/system focus. Prefer `perform_secondary_action` with `action: "Press"`, `press_key`, `set_value`, or element-targeted `scroll` over pointer `click`/`drag`. Direct `click`/`drag` require `allowPointer: true`; sequence pointer steps require `allowPointerClick`/`allowPointerDrag`. Pointer tools restore mouse position afterward. Run `node tools/validate-macuse.mjs focus` after focus-related changes.
- Do not perform purchases, sends, deletes, credential/account/security/privacy changes, installs, or ambiguous wrong-window actions without fresh explicit approval for that exact operation.
- Keep direct raw-MCP probes non-mutating; use them for discovery, app-approval denial paths, and parity investigation.

## macOS Automation / TCC requirements

- `-609`, `-1712`, `-1743`, and AppleEvents denial signatures mean the responsible host app lacks TCC/Automation access, not necessarily that Computer Use is down.
- Preserve `list_apps` errors; do not turn them into "No apps matched the requested filter."
- Repair with `node tools/macuse-repair.mjs --apply --repair-tcc --responsible auto --restart-tccd --sudo-password-env MACUSE_SUDO_PASSWORD`; it grants the responsible launcher and SkyComputerUseClient to `com.openai.sky.CUAService` after backing up the user TCC DB.

Full background, log predicates, and the June 26, 2026 repair note: `docs/reference/codex-computer-use-external-harness.md`.

## Validation commands

```bash
node tools/macuse-doctor.mjs --out .scratch/doctor
node tools/macuse-demo.mjs --out .scratch/macuse-demo
node tools/validate-macuse.mjs quick
node tools/validate-macuse.mjs read-only
node tools/validate-macuse.mjs mutating
node tools/validate-macuse.mjs focus
node tools/validate-macuse.mjs mcp
```

For focused checks, run the underlying commands directly:

```bash
node --check tools/probe-codex-computer-use-mcp.mjs
node --check tools/codex-computer-use-appserver.mjs
node tools/probe-codex-computer-use-mcp.mjs discover
node tools/probe-codex-computer-use-mcp.mjs deny --app Finder
node tools/codex-computer-use-appserver.mjs status --quiet --pretty
node tools/codex-computer-use-appserver.mjs list-apps --running-only --filter "Activity Monitor" --quiet --pretty
node tools/codex-computer-use-appserver.mjs get-state --app "Activity Monitor" --quiet --pretty
```

Use `PI_OFFLINE=1 pi --no-context-files --no-skills --no-prompt-templates --no-themes --no-extensions -e ./extensions/codex-computer-use.ts --list-models '__no_such_model__'` as a cheap extension-load smoke test. Use `PI_OFFLINE=1 pi --approve --no-context-files --no-prompt-templates --no-themes -e . --list-models '__no_such_model__'` to smoke-load the package manifest, extension, and bundled skill together.
