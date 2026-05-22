# macuse agent instructions

This repo investigates OpenAI Codex Computer Use reuse from non-Codex agents such as pi.

## Canonical paths

- High-level live demo: `tools/macuse-demo.mjs`
- Health audit: `tools/macuse-doctor.mjs`
- Client config generator: `tools/macuse-config.mjs`
- Working app-server bridge: `tools/codex-computer-use-appserver.mjs`
- Standard MCP wrapper for Cursor/non-pi clients: `tools/codex-computer-use-appserver-mcp.mjs`
- Direct raw-MCP probe harness: `tools/probe-codex-computer-use-mcp.mjs`
- Project-local pi extension: `.pi/extensions/codex-computer-use.ts`
- Main findings: `docs/reference/codex-computer-use-external-harness.md`
- Local install facts: `docs/reference/codex-computer-use-local-install.md`
- Safety policy: `docs/reference/codex-computer-use-safety-policy.md`

## Safety

- Read-only Computer Use probes are allowed: `list_apps` and `get_app_state`.
- Mutating GUI actions must use `codex_cu_sequence` or `tools/codex-computer-use-appserver.mjs sequence` with a narrow target, before/after state checks, `allowMutating: true`, and a safety note.
- Preserve the user's mouse/system focus. Prefer `perform_secondary_action` with `action: "Press"`, `press_key`, `set_value`, or element-targeted `scroll` over pointer `click` when they can accomplish the same task. In pi, pointer `click` requires `allowPointerClick: true`; pointer `drag` requires `allowPointerDrag: true` and the bridge restores mouse position afterward. Run `node tools/validate-macuse.mjs focus` after focus-related changes.
- Do not perform purchases, sends, deletes, credential/account/security/privacy changes, installs, or ambiguous wrong-window actions without fresh explicit approval for that exact operation.
- Keep direct raw-MCP probes non-mutating; use them for discovery, app-approval denial paths, and parity investigation.

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
node tools/codex-computer-use-appserver.mjs list-apps --quiet --pretty
node tools/codex-computer-use-appserver.mjs get-state --app Calculator --approval accept-once --quiet --pretty
```

Use `PI_OFFLINE=1 pi --no-context-files --no-skills --no-prompt-templates --no-themes --no-extensions -e .pi/extensions/codex-computer-use.ts --list-models '__no_such_model__'` as a cheap extension-load smoke test.
