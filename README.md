# macuse

Local tooling and notes for testing whether OpenAI Codex Computer Use can be reused from non-Codex agents such as pi.

## Validation

Run the reusable smoke suite:

```bash
node tools/validate-macuse.mjs quick
node tools/validate-macuse.mjs read-only
node tools/validate-macuse.mjs mutating
node tools/validate-macuse.mjs focus
node tools/validate-macuse.mjs mcp
```

## Working path

Use Codex app-server as the compatibility bridge for Computer Use calls:

```bash
node tools/codex-computer-use-appserver.mjs status --quiet --pretty
node tools/codex-computer-use-appserver.mjs list-apps --quiet --pretty
node tools/codex-computer-use-appserver.mjs get-state --app Calculator --approval accept-once --quiet --pretty
```

The project-local pi extension registers:

- `codex_cu_list_apps`
- `codex_cu_get_app_state`
- `codex_cu_sequence` for guarded multi-step flows, including mutating steps with `allowMutating: true`, a `safetyNote`, UI confirmation, and optional per-step `expectText` / `expectAbsentText` assertions. Pointer `click` steps also require `allowPointerClick: true`; pointer `drag` steps require `allowPointerDrag: true` and automatically restore mouse position. Prefer accessibility actions/keys/values to preserve mouse focus.

Run `/reload` in pi after changing `.pi/extensions/codex-computer-use.ts`.

## Standard MCP wrapper

For Cursor or another MCP-capable client, use the app-server-backed wrapper rather than raw `SkyComputerUseClient mcp`. See [`docs/reference/cursor-mcp-setup.md`](docs/reference/cursor-mcp-setup.md) or copy [`configs/cursor-mcp.example.json`](configs/cursor-mcp.example.json):

```json
{
  "mcpServers": {
    "macuse-codex-computer-use": {
      "command": "node",
      "args": ["/Users/yourname/Projects/AI/macuse/tools/codex-computer-use-appserver-mcp.mjs"],
      "env": {
        "CODEX_CU_MCP_CWD": "/Users/yourname/Projects/AI/macuse"
      }
    }
  }
}
```

The wrapper exposes the Computer Use tool family over MCP while routing execution through Codex app-server. It proxies MCP `elicitation/create` app-approval prompts when the client supports elicitation. Pointer `click` / `drag` require `allowPointer: true` and restore mouse position afterward.

## Probe path

Use the direct raw-MCP harness for discovery, app-approval denial-path checks, and raw-MCP parity investigation:

```bash
node tools/probe-codex-computer-use-mcp.mjs discover
node tools/probe-codex-computer-use-mcp.mjs deny --app Finder
```

Direct raw-MCP accepted `list_apps` / `get_app_state` still hangs in tested external hosts. Use the app-server bridge for positive read-only operation.

## Docs

Start at [`docs/README.md`](docs/README.md), then see [`docs/reference/parity-matrix.md`](docs/reference/parity-matrix.md) and [`docs/reference/codex-computer-use-external-harness.md`](docs/reference/codex-computer-use-external-harness.md) for the latest findings and refresh commands.
