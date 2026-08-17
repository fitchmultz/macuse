# Cursor MCP setup for Codex Computer Use

Source: Local `macuse` app-server-backed MCP wrapper
Created: May 22, 2026
Updated: August 17, 2026 for ChatGPT 26.810.52044 and plugin 1.0.1000717
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

- starts Codex app-server with Computer Use feature flags, sends the current `initialized` notification, and waits for asynchronous MCP startup,
- creates an ephemeral app-server thread with `computer-use`, `event-stream`, and `computer-history` using each current bundled plugin launcher/working directory/arguments,
- exposes all 18 tools in the configured Computer Use, Record & Replay, and Computer History families over standard MCP,
- defaults to `approval: "inherit"`, auto-accepting Computer Use app approvals under macuse's standing app-access policy,
- routes tool execution through app-server `mcpServer/tool/call`,
- sanitizes stopped-session sentinels and restarts only its app-server session before retrying read-only app/status/settings calls once,
- requires `allowMutating:true`, a `safetyNote`, and an immediate `get_app_state` before every Computer Use mutation,
- requires `allowRecording:true` plus `safetyNote` for Record & Replay starts and Computer History resume,
- requires `allowPrivacyChange:true`, `safetyNote`, the complete `observation` object, and the current `showMenuBarIcon` value when present for Computer History settings updates, and
- restores mouse position after pointer `click` / `drag` calls.

## Tool use rules

1. Every mutation requires `allowMutating:true` and a `safetyNote`; the wrapper immediately refreshes `get_app_state` before dispatch.
2. Prefer `perform_secondary_action` with `action: "Press"`, `press_key`,
   `set_value`, `select_text`, or element-targeted `scroll` over pointer tools.
3. Pointer `click` and `drag` require `allowPointer: true`.
4. App approval defaults to `approval: "inherit"`. Use `approval: "ask"` only
   when a client should surface MCP elicitation prompts, or `approval: "deny"`
   for denial-path tests.
5. Use `event_stream_status`, `computer_history_status`, and `computer_history_get_settings` only when activity/artifact/privacy metadata is relevant. Record & Replay starts and Computer History resume require explicit user intent, `allowRecording:true`, and `safetyNote`; settings changes require fresh exact approval, `allowPrivacyChange:true`, the complete `observation` object, and the current `showMenuBarIcon` value when present.
6. Stop before purchases, sends, deletes, account/privacy changes, installs, or ambiguous wrong-window actions unless the user gives fresh exact approval. Hand off credential/authentication changes, browser/security warning bypasses, consequential financial transactions, and high-impact sensitive-domain decisions to the user.

## Validation

```bash
node tools/validate-macuse.mjs mcp
```

This validates:

- wrapper syntax,
- MCP initialize,
- `tools/list` with all 18 expected tools and upstream-matching auxiliary annotations,
- MCP elicitation proxy behavior when upstream emits an app-approval prompt,
- `get_app_state` for Activity Monitor,
- safe `event_stream_status` routing without starting recording,
- mutation, safety-note, pointer, recording-start, and privacy-change guards, and
- default-inherit app approval behavior.
