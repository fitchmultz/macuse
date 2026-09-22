# MCP setup

The standard MCP server shares macuse's native runtime, guards, selected-text insertion, and auxiliary recording/history tools. Use it for Cursor or another MCP-capable client. See [local requirements](codex-computer-use-local-install.md) first.

## Configure the client

Generate configuration from the installed checkout:

```bash
node tools/macuse-config.mjs cursor --pretty
node tools/macuse-config.mjs claude-desktop --pretty
```

Both emit the standard `mcpServers` shape. The generator supports `--out`, `--server`, and `--cwd`; its default server name is `macuse`. A path-adjusted example:

```json
{
  "mcpServers": {
    "macuse": {
      "command": "node",
      "args": ["/Users/yourname/Projects/macuse/tools/macuse-mcp.mjs"],
      "env": {
        "MACUSE_CWD": "/Users/yourname/Projects/macuse"
      }
    }
  }
}
```

Use the actual absolute checkout path and a Node executable available to the client. Restart the MCP process after changing code or dependencies. Starting a server exposes tools; it does not start recording.

## Use the tools

The server exposes eleven tools: `macuse`, `macuse_insert_text`, `macuse_reset`, and the eight `event_stream_*` / `computer_history_*` tools listed in the [safety policy](codex-computer-use-safety-policy.md). `macuse_tools` is Pi-only and is not an MCP tool.

Call `macuse` with:

```json
{ "code": "await cua.getState()" }
```

Then bind the chosen app:

```json
{ "code": "var app = await cua.getApp(\"Activity Monitor\")", "apps": ["Activity Monitor"] }
```

Bindings and observations persist for that server process. Read the emitted documentation/state, await every action, and use `await app.getAXState()` or `await app.getAXStateAndScreenshot()` for subsequent observations. These methods emit automatically.

Mutations require exact `apps` scope, `allowMutating:true`, and a concrete `safetyNote`, plus a prior same-app observation. Pointer actions additionally require `allowPointer:true`. The server refreshes full state before each action, validates document/target identity, and verifies full-field `setValue` exactly. Native element indexes come from the observed state; there is no additional selector language.

Use `macuse_insert_text` for selected-range Unicode insertion into an already-focused, freshly observed field. It preserves unselected text and verifies native readback without keyboard input or clipboard writes. Observe again afterward. Raw `typeText` is ASCII-only; paste is disabled.

Tool results contain text/images and `isError`; structured macuse evidence is in MCP `_meta`. Inspect partial `dispatched`/`outcome` evidence. Timeout/abort resets JavaScript and awaits settlement, but a GUI effect may already have happened. Never automatically replay an uncertain action. `macuse_reset({})` clears bindings/observations without undoing GUI state.

## Scope and diagnostics

Primary GUI calls use installed `@oai/cua-repl`, computer-only and Sky-only in the normal vendor sandbox. Only recording/history calls start the separate app-server, with existing auth and `CODEX_HOME`. macuse adds no separate evaluator or module-loader tool, and enables no browser/audio or Messages service.

Recording starts/history resume and settings replacement retain their explicit approval flags and safety notes. Read-only status/settings calls can expose private metadata. Flags do not create permission.

```bash
node tools/validate-macuse.mjs mcp
```

Review [validation scopes](demo-and-doctor.md) before running live checks. macOS permissions apply to the responsible client launcher; a working terminal session does not prove that Cursor has the same grants.
