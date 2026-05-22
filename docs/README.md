# macuse notes

This repository records local investigation and tooling for reusing OpenAI Codex Computer Use from non-Codex harnesses such as pi.

## Current status

- Direct raw MCP (`SkyComputerUseClient mcp`) works for discovery and app-approval denial-path probes, but accepted service-backed read-only calls still hang in tested external hosts.
- Codex app-server works as a compatibility bridge for Computer Use calls.
- The project-local pi extension exposes standalone read-only tools (`codex_cu_list_apps`, `codex_cu_get_app_state`) and a guarded sequence tool (`codex_cu_sequence`).
- Harmless Calculator action/key and TextEdit scroll/type/set-value/select probes have passed. Focus validation confirms Calculator is not left frontmost. Broader mutating GUI actions remain guarded by `allowMutating`, a `safetyNote`, and UI confirmation.

## Tools

```bash
node tools/macuse-demo.mjs --out .scratch/macuse-demo
node tools/macuse-doctor.mjs --out .scratch/doctor
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

Project-local pi extension:

```text
.pi/extensions/codex-computer-use.ts
```

Reload pi after adding or changing the extension:

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
