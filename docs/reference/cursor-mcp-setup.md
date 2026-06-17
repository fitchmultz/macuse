# Cursor MCP setup for Codex Computer Use

Source: Local `macuse` app-server-backed MCP wrapper
Created: May 22, 2026
Status: Working local example; refresh paths if this repo moves

## Config

Use the app-server-backed wrapper, not raw `SkyComputerUseClient mcp`:

```json
{
  "mcpServers": {
    "macuse-codex-computer-use": {
      "command": "node",
      "args": [
        "/Users/yourname/Projects/AI/macuse/tools/codex-computer-use-appserver-mcp.mjs"
      ],
      "env": {
        "CODEX_CU_MCP_CWD": "/Users/yourname/Projects/AI/macuse"
      }
    }
  }
}
```

A copy is stored at:

```text
configs/cursor-mcp.example.json
```

Generate a path-correct config for the current checkout:

```bash
node tools/macuse-config.mjs cursor --pretty
node tools/macuse-config.mjs cursor --pretty --out configs/cursor-mcp.local.json
```

## Behavior

The wrapper:

- starts Codex app-server with Computer Use feature flags,
- creates an ephemeral app-server thread,
- exposes the Computer Use tool family over standard MCP,
- defaults to `approval: "inherit"`, auto-accepting Computer Use app approvals
  to match Codex's Any App setting,
- routes tool execution through app-server `mcpServer/tool/call`, and
- restores mouse position after pointer `click` / `drag` calls.

## Tool use rules

1. Call `get_app_state` before mutating a target app.
2. Prefer `perform_secondary_action` with `action: "Press"`, `press_key`,
   `set_value`, `select_text`, or element-targeted `scroll` over pointer tools.
3. Pointer `click` and `drag` require `allowPointer: true`.
4. App approval defaults to `approval: "inherit"`. Use `approval: "ask"` only
   when a client should surface MCP elicitation prompts, or `approval: "deny"`
   for denial-path tests.
5. Stop before purchases, sends, deletes, credential/account/security/privacy
   changes, installs, or ambiguous wrong-window actions unless the user gives
   fresh explicit approval for that exact operation.

## Validation

```bash
node tools/validate-macuse.mjs mcp
```

This validates:

- wrapper syntax,
- MCP initialize,
- `tools/list` with all expected Computer Use tools,
- MCP elicitation proxying on a Finder denial path,
- `get_app_state` for Activity Monitor,
- pointer guard for `click`, and
- default-inherit app approval behavior.
