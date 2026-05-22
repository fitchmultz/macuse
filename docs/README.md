# macuse notes

This repository records local investigation and tooling for reusing OpenAI Codex Computer Use from non-Codex harnesses such as pi.

## Current status

- Direct raw MCP (`SkyComputerUseClient mcp`) works for discovery and app-approval denial-path probes, but accepted service-backed read-only calls still hang in tested external hosts.
- Codex app-server works as a compatibility bridge for read-only Computer Use calls.
- The project-local pi extension exposes read-only tools only: `codex_cu_list_apps` and `codex_cu_get_app_state`.
- Mutating GUI actions (`click`, `type_text`, `drag`, `scroll`, `press_key`, `set_value`, etc.) are not enabled until a task-specific safety policy and harmless regression probe are approved.

## Tools

```bash
node tools/validate-macuse.mjs --help
node tools/probe-codex-computer-use-mcp.mjs --help
node tools/codex-computer-use-appserver.mjs --help
```

Use the validation wrapper for repeated checks:

```bash
node tools/validate-macuse.mjs quick
node tools/validate-macuse.mjs read-only
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
- [Bridge macOS background Computer Use reference](reference/bridge-macos-background-computer-use.md)
