# macuse agent instructions

This repo investigates OpenAI Codex Computer Use reuse from non-Codex agents such as pi.

## Canonical paths

- High-level live demo: `tools/macuse-demo.mjs`
- Health audit: `tools/macuse-doctor.mjs`
- Client config generator: `tools/macuse-config.mjs`
- Working app-server bridge: `tools/codex-computer-use-appserver.mjs`
- Standard MCP wrapper for Cursor/non-pi clients: `tools/codex-computer-use-appserver-mcp.mjs`
- Shared app-server/MCP helper module: `tools/cu-helpers.mjs`
- Async native AX observation/selected-text helper: `tools/macos-native.mjs` and `tools/macos-native.swift`
- Direct raw-MCP probe harness: `tools/probe-codex-computer-use-mcp.mjs`
- Installable pi extension source with persistent app-server session: `extensions/codex-computer-use.ts` plus modules in `extensions/codex-computer-use-modules/`
- Main findings: `docs/reference/codex-computer-use-external-harness.md`
- Local install facts: `docs/reference/codex-computer-use-local-install.md`
- Safety policy: `docs/reference/codex-computer-use-safety-policy.md`

## Development policy

- Pi 0.84.0 is the minimum supported Pi version. Apply extension code/dependency changes with a new Pi process, not `/reload`; reload still resets tool activation. Restart CLI/MCP/native helper processes after code changes.
- Native AX features require macOS Accessibility access and an installed Swift compiler (`xcrun swiftc`); compilation is lazy and source-hash cached. Do not install tooling or bypass privacy permissions implicitly.
- Keep app-server isolated to `computer-use`, `event-stream`, and `computer-history`: disable inherited MCP servers/plugins and the `apps` feature without dropping the launchers' `CODEX_HOME`.
- No backwards-compatibility shims for Codex app-server, Computer Use, or pi extension APIs during development. Cut fully to the protocol and runtime shape required by the currently installed pi and Codex Computer Use versions, update all repo tools/docs/tests together, and remove stale aliases instead of carrying compatibility paths.

## Safety

- Read-only Computer Use probes are allowed: `list_apps`, `get_app_state`, `event_stream_status`, `computer_history_status`, and `computer_history_get_settings`; the auxiliary status/settings calls can expose activity, artifact, and privacy metadata.
- Record & Replay starts and Computer History resume require exact user intent plus `allowRecording: true` and a non-empty safety note. `computer_history_update_settings` requires exact approval plus `allowPrivacyChange: true`, a safety note, the complete `observation`, preserving every unchanged field from a fresh settings read. Event-stream stop and Computer History pause are allowed without those flags.
- The pi extension registers all 18 tools in macuse's configured MCP families plus `macuse_sequence`, `macuse_tools`, and `macuse_restart`; only `list_apps`, `get_app_state`, `macuse_sequence`, and `macuse_tools` start active after startup, new-session, resume, fork, or reload boundaries. Mutating GUI tools require a narrow target, a recent `get_app_state`, `allowMutating: true`, and a safety note; use `macuse_sequence` when ordered before/after evidence or waits matter. For element-targeted actions, prefer stable `elementId`, then exact `elementDescription`, unique role/name, and only then guarded `element_index`. Validate all sequence arguments before first dispatch. Mutations reject stale documents and accept `expectedTitle`/`expectedUrl` guards. Verify `set_value` against the resolved field; unrelated text/clock changes are not action evidence. If a sequence fails, preserve partial details and Pi's error flag. Inspect `dispatched`/`outcome`; offer a resume index only for a failed action that was not dispatched. Timeouts/aborts do not cancel upstream work and never authorize automatic replay. The extension, CLI, and MCP wrapper filter outbound calls through `upstream-tool-args.mjs`; update that pinned key map from live `tools/list` schemas when upstream changes.
- Aim to avoid interrupting the user; do not promise universal focus/input isolation. Prefer `perform_secondary_action` with `action: "Press"`, `press_key`, `set_value`, or element-targeted `scroll` over pointer `click`/`drag`. Direct pointer tools require `allowPointer: true`; sequence pointer steps require `allowPointerClick`/`allowPointerDrag`. Never warp the cursor. Native activation/window events are observations, not input attribution; report unknown/unavailable coverage honestly. Run `node tools/validate-macuse.mjs focus` after focus-related changes. Validation must capture Activity Monitor's original tab and restore it in `finally`, not force CPU.
- Native text insertion replaces only `AXSelectedText` after identity/value/selection guards and verifies exact readback; it posts no keyboard input and writes no clipboard. Unsupported Unicode must fail before mutation; never fall back/replay after an attempted edit with unknown outcome.
- Parse/cache the full upstream state before presentation caps. Pi `get_app_state` defaults to minimal output and focus observation enabled; sequences default to compact. Do not imply standalone CLI/MCP feature parity with Pi's executor.
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
