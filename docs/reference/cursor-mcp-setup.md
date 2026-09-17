# Cursor MCP setup for Codex Computer Use

Source: Local `macuse` app-server-backed MCP wrapper
Created: May 22, 2026
Installed-version baseline: August 17, 2026, ChatGPT 26.810.52044 and plugin 1.0.1000717; behavior follows current wrapper source
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
- creates an ephemeral app-server thread with only `computer-use`, `event-stream`, and `computer-history`, disabling inherited MCP servers/plugins and the `apps` feature while preserving each launcher's working directory, arguments, and `CODEX_HOME`,
- exposes all 18 tools in the configured Computer Use, Record & Replay, and Computer History families over standard MCP,
- defaults to `approval: "inherit"`, auto-accepting Computer Use app approvals under macuse's standing app-access policy,
- routes tool execution through app-server `mcpServer/tool/call`,
- sanitizes stopped-session sentinels and restarts only its app-server session before retrying read-only app/status/settings calls once,
- requires `allowMutating:true`, a `safetyNote`, and an immediate `get_app_state` before every Computer Use mutation,
- requires `allowRecording:true` plus `safetyNote` for Record & Replay starts and Computer History resume,
- requires `allowPrivacyChange:true`, `safetyNote`, the complete `observation` object with unchanged fields preserved for Computer History settings updates, and
- requires `allowPointer:true` for pointer `click` / `drag`; macuse never warps the cursor, but upstream input can still interrupt the user.

Native selected-text editing uses the shared async helper, lazily compiled with installed `xcrun swiftc` and requiring Accessibility access. It replaces `AXSelectedText` in a guarded, already-focused control and verifies exact readback without keyboard events or clipboard writes. Unsupported Unicode fails before mutation; an attempted unverified edit never falls back/replays. ASCII may use upstream typing when native editing is unsupported.

This standalone wrapper is not the Pi sequence executor: do not assume Pi waits, summaries, or full structured failure-evidence parity. A timeout does not cancel an upstream action; inspect current state and never replay a mutation automatically. Restart the MCP process after code/native-helper changes.

## Tool use rules

1. Every mutation requires `allowMutating:true` and a `safetyNote`; the wrapper immediately refreshes `get_app_state` before dispatch. Use `expectedTitle` / `expectedUrl` to guard the intended document; inspect a fresh snapshot if the guard fails.
2. Prefer `perform_secondary_action` with `action: "Press"`, `press_key`,
   `set_value`, `select_text`, or element-targeted `scroll` over pointer tools.
3. Pointer `click` and `drag` require `allowPointer: true`.
4. App approval defaults to `approval: "inherit"`. Use `approval: "ask"` only
   when a client should surface MCP elicitation prompts, or `approval: "deny"`
   for denial-path tests.
5. Use `event_stream_status`, `computer_history_status`, and `computer_history_get_settings` only when activity/artifact/privacy metadata is relevant. Record & Replay starts and Computer History resume require explicit user intent, `allowRecording:true`, and `safetyNote`; settings changes require fresh exact approval, `allowPrivacyChange:true`, the complete `observation` object with unchanged fields preserved.
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
