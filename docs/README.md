# macuse notes

This repository records local investigation and tooling for reusing OpenAI Codex Computer Use from non-Codex harnesses such as pi.

## Current status

- Direct raw MCP (`SkyComputerUseClient mcp`) works for discovery, but app-approval denial and accepted service-backed read-only calls can fail or hang in tested external hosts. Validation treats the raw-MCP denial probe as diagnostic-only; the Codex app-server bridge is the authoritative positive path.
- The Codex app-server and Computer Use plugin now ship inside `/Applications/ChatGPT.app`; macuse explicitly injects the bundled Computer Use MCP transport into its private thread so global Codex config cannot disable or shadow it.
- The packaged pi extension keeps a persistent Codex app-server thread, verifies all three thread-scoped MCP inventories with paginated `mcpServerStatus/list` calls before serving requests, and exposes one `macuse` tool with `list_apps`, `get_app_state`, `sequence`, `event_stream`, `computer_history`, and `restart_computer_use` actions. It supports compact/minimal/full output, `targetScope: "main"` output filtering, sequence-level default `app`, per-step multi-app targeting, running-app filtering, focus before/after evidence, normalized text assertions, wait helpers that can match raw text-entry values, machine-readable parsed state/element/change details with semantic tags and target-stability diagnostics, partial failure results, stale-index guards, search-field role normalization, empty-`set_value` clear fallback, robust element targeting (`element_index`, `element`, `elementId`, `elementDescription`, role/name selectors, or `arguments.targets` fallback objects), and macOS app-server lifecycle hardening via `/macuse-stop`, PID records, startup stale reaping, and a watchdog for crash cleanup.
- Activity Monitor search/filter/clear and CPU/Memory tab probes have passed without destructive actions. Focus validation confirms native frontmost focus is not stolen. App approval defaults to `inherit`, matching Codex's Any App setting by auto-accepting app approvals in the bridge. Broader mutating GUI actions remain gated by `allowMutating` and a `safetyNote`.
- `macuse-doctor` classifies common service failures including `cgWindowNotFound`, `frontmost=<none>`, timeouts, and AppleEvents/TCC denials. `macuse-repair --repair-tcc --responsible auto` resolves the responsible launcher from the current process tree (for RepoPrompt/iTerm hosts); apply still requires a host with Full Disk Access to edit the user TCC DB.

## Tools

```bash
node tools/macuse-demo.mjs --out .scratch/macuse-demo
node tools/macuse-doctor.mjs --out .scratch/doctor
node tools/macuse-repair.mjs
node tools/macuse-repair.mjs --apply
node tools/macuse-config.mjs cursor --pretty
node tools/validate-macuse.mjs --help
node tools/probe-codex-computer-use-mcp.mjs --help
node tools/codex-computer-use-appserver.mjs --help
node tools/codex-computer-use-appserver-mcp.mjs --help
```

Use the validation wrapper for repeated checks:

```bash
node tools/validate-macuse.mjs quick
node tools/validate-macuse.mjs read-only
node tools/validate-macuse.mjs mutating
node tools/validate-macuse.mjs focus
node tools/validate-macuse.mjs mcp
```

Installable pi package resources:

```text
extensions/codex-computer-use.ts
skills/macuse/SKILL.md
```

Reload pi after changing package resources:

```text
/reload
```

## References

- [Codex Computer Use external harness investigation](reference/codex-computer-use-external-harness.md)
- [Codex Computer Use local install](reference/codex-computer-use-local-install.md)
- [OpenAI Codex app Computer Use docs](https://developers.openai.com/codex/app/computer-use)
- [Doctor, demo, and config tools](reference/demo-and-doctor.md)
- [Computer Use parity matrix](reference/parity-matrix.md)
- [Cursor MCP setup](reference/cursor-mcp-setup.md)
- [Non-Codex Computer Use safety policy](reference/codex-computer-use-safety-policy.md)
- [Bridge macOS background Computer Use reference](reference/bridge-macos-background-computer-use.md)
