# macuse agent instructions

This repo investigates OpenAI Codex Computer Use reuse from non-Codex agents such as pi.

## Canonical paths

- Working app-server bridge: `tools/codex-computer-use-appserver.mjs`
- Direct raw-MCP probe harness: `tools/probe-codex-computer-use-mcp.mjs`
- Project-local pi extension: `.pi/extensions/codex-computer-use.ts`
- Main findings: `docs/reference/codex-computer-use-external-harness.md`
- Local install facts: `docs/reference/codex-computer-use-local-install.md`

## Safety

- Read-only Computer Use probes are allowed: `list_apps` and `get_app_state`.
- Do not run mutating GUI actions (`click`, `type_text`, `drag`, `scroll`, `press_key`, `set_value`, `select_text`, or secondary actions) without explicit user approval for that task and a stated safety policy.
- Keep direct raw-MCP probes non-mutating; use them for discovery, app-approval denial paths, and parity investigation.

## Validation commands

```bash
node tools/validate-macuse.mjs quick
node tools/validate-macuse.mjs read-only
```

For focused checks, run the underlying commands directly:

```bash
node --check tools/probe-codex-computer-use-mcp.mjs
node --check tools/codex-computer-use-appserver.mjs
node tools/probe-codex-computer-use-mcp.mjs discover
node tools/probe-codex-computer-use-mcp.mjs deny --app Finder
node tools/codex-computer-use-appserver.mjs status --quiet --pretty
node tools/codex-computer-use-appserver.mjs list-apps --quiet --pretty
node tools/codex-computer-use-appserver.mjs get-state --app Calculator --approval accept-once --quiet --pretty
```

Use `PI_OFFLINE=1 pi --no-context-files --no-skills --no-prompt-templates --no-themes --no-extensions -e .pi/extensions/codex-computer-use.ts --list-models '__no_such_model__'` as a cheap extension-load smoke test.
