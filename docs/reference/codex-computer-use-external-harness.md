# Codex Computer Use External Harness Investigation

Source: Local Codex Computer Use app/plugin files and direct MCP probes against `SkyComputerUseClient mcp`
Author: [OpenAI](https://openai.com/) for the installed app/plugin; local investigation notes captured in this repository
Posted: Not applicable; local installed app and plugin cache
Scraped: May 22, 2026
Refreshed: May 22, 2026 09:35 MDT; spot-checked again June 8, 2026 after Codex updates; updated July 12, 2026 after Codex merged into ChatGPT. Active validation uses Activity Monitor instead of Calculator.
Observed metadata at May 22 refresh time: Codex host app `26.519.31651` build `3017`; Computer Use plugin `1.0.799`; MCP server name `Computer Use`; MCP server version `d10a51766bb4d162ef1eed308e86a0f8f3816fb860896cb92c18e6de998142af`
Current July 12 spot-check: ChatGPT host app `26.707.51957` build `5175` (bundle ID `com.openai.codex`); Codex CLI `0.144.0-alpha.4`; bundled Computer Use plugin `1.0.1000387`; the app-server-mediated pi path configures and inventory-checks `computer-use` (10 tools), `event-stream` (3), and `skysight` (5) in one explicit thread. Historical `/Applications/Codex.app` references below describe the pre-merge install. `turn-ended` remains unexposed because it has no published payload contract; the private `@oai/sky` Node REPL adapter is not MCP.

## Bottom line

A working non-Codex path now exists through **Codex app-server**, not directly
through the raw `SkyComputerUseClient mcp` process. Read-only calls are proven;
guarded smoke tests also prove harmless mutating paths work for button clicks,
key presses, scrolling, typing, and set-value on controlled apps/files.

What is proven:

- The installed Computer Use client can be launched as an MCP server outside
  Codex.
- It initializes successfully with a generic MCP client and advertises the same
  public Computer Use tool surface through `tools/list`.
- Basic direct-MCP validation paths work, such as unknown-tool,
  missing-argument, invalid-app, app-approval elicitation, and app-approval
  decline.
- Direct raw-MCP service-backed calls can hang from external hosts. Logs showed
  both a Repo Prompt-hosted Apple Events/TCC rejection and later iTerm-hosted
  Apple Events acceptance that still did not make direct raw-MCP `list_apps`
  return.
- Starting `/Applications/ChatGPT.app/Contents/Resources/codex app-server` with
  `--enable computer_use --enable plugins --enable tool_call_mcp_elicitation`,
  then creating an ephemeral `thread/start` whose config explicitly points
  `mcp_servers.computer-use` at ChatGPT's bundled Computer Use client, makes the
  app-server-mediated `mcpServer/tool/call` path work even when global config
  contains a stale or disabled server with the same name.
- Through app-server, read-only `computer-use/list_apps` completed successfully.
- Through app-server, read-only `computer-use/get_app_state` for Activity Monitor
  completed successfully and returned both accessibility-tree text and a JPEG
  screenshot block.
- A guarded app-server sequence successfully filters and clears Activity Monitor search, restores CPU/search state, and verifies native frontmost focus did not change.
- A controlled TextEdit scroll probe against `/tmp/macuse-scroll-test.txt` returned successful `scroll down` and `scroll up` steps for scroll area element `1`; screenshot hashes changed across the sequence.
- Controlled TextEdit probes against disposable `/tmp/macuse-type-test.txt` and `/tmp/macuse-set-value-test.txt` succeeded for `type_text` and `set_value`, with saved file contents matching the expected probe strings.
- A controlled TextEdit selection probe against `/tmp/macuse-select-test.txt` succeeded for `select_text` with prefix/suffix disambiguation; file contents were unchanged.
- This repository now includes both a CLI bridge and a packaged pi extension
  that expose the working app-server path. The pi extension keeps a persistent
  app-server thread for the session and provides a sequence wrapper for mutating
  flows.

What is **not** proven yet:

- Direct raw MCP `list_apps` / accepted `get_app_state` completing without the
  Codex app-server thread/session wrapper.
- Drag workflows and high-stakes click/scroll/type/set-value/select workflows beyond the controlled Activity Monitor/TextEdit smoke tests.
- Whether the local safety policy fully covers Codex's native Computer Use task
  safeguards.
- Whether app-server's `thread/start` + `mcpServer/tool/call` is a stable public
  contract or an internal compatibility layer that may change with Codex app
  updates.

The practical conclusion is: pi and Cursor should not recreate the low-level
macOS automation stack. OpenAI ships that layer, and Codex app-server currently
provides enough thread/session/lifecycle context for Computer Use calls to work
from a non-Codex harness. Treat direct raw MCP as useful for discovery and
denial-path regression tests, but use the app-server bridge for positive
operation until raw-MCP parity is understood.

## Current executable entrypoint

Primary installed client:

```text
/Users/yourname/.codex/computer-use/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient
```

Bundled plugin copy used for MCP `cwd` in the plugin manifest:

```text
/Users/yourname/.codex/plugins/cache/openai-bundled/computer-use/1.0.799
```

Current ChatGPT host-app bundled copy:

```text
/Applications/ChatGPT.app/Contents/Resources/plugins/openai-bundled/plugins/computer-use
```

The installed app, cache copy, and host-app bundled copy had matching executable
hashes at refresh time.

## MCP config exposed by the plugin

Path:

```text
/Users/yourname/.codex/plugins/cache/openai-bundled/computer-use/1.0.799/.mcp.json
```

Content at refresh time:

```json
{
  "mcpServers": {
    "computer-use": {
      "command": "./Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient",
      "args": ["mcp"],
      "cwd": "."
    }
  }
}
```

Equivalent direct non-Codex harness config:

```json
{
  "mcpServers": {
    "computer-use": {
      "command": "/Users/yourname/.codex/computer-use/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient",
      "args": ["mcp"],
      "cwd": "/Users/yourname/.codex/plugins/cache/openai-bundled/computer-use/1.0.799"
    }
  }
}
```

## Tool surface observed through `tools/list`

The server advertised these tools:

- `list_apps`
- `get_app_state`
- `click`
- `perform_secondary_action`
- `set_value`
- `select_text`
- `scroll`
- `drag`
- `press_key`
- `type_text`

This is the main evidence that the same broad capability surface is exposed over
MCP. It is not, by itself, proof that every tool works outside Codex.

## Agent skill and instruction files

Codex does ship a skill file for agents:

```text
/Users/yourname/.codex/plugins/cache/openai-bundled/computer-use/1.0.799/skills/computer-use/SKILL.md
```

The skill metadata says:

```yaml
name: computer-use
description: Control local Mac apps through Computer Use. Use for tasks that require reading or operating app UI by clicking, typing, scrolling, dragging, pressing keys, or setting values.
```

The body of the skill is mostly a confirmation and safety policy. It does not
teach much tool-by-tool usage beyond the general instruction to use Computer Use
for local app UI interactions not exposed by a more specific plugin.

The app bundle also includes app-specific instruction files:

```text
/Users/yourname/.codex/plugins/cache/openai-bundled/computer-use/1.0.799/Codex Computer Use.app/Contents/Resources/Package_ComputerUseClient.bundle/Contents/Resources/AppInstructions
```

Files observed:

- `AppleMusic.md`
- `Clock.md`
- `iPhone Mirroring.md`
- `Notion.md`
- `Numbers.md`
- `Spotify.md`

These should be considered supplemental runtime/app guidance, not a replacement
for harness-level safety handling.

## Elicitation behavior

Calling `get_app_state` for an app that is not already approved caused the MCP
server to send a server-to-client request:

```json
{
  "method": "elicitation/create",
  "params": {
    "_meta": {
      "persist": ["always"]
    },
    "message": "Allow Codex to use Finder?",
    "requestedSchema": {
      "properties": {},
      "type": "object"
    }
  }
}
```

A manual decline response worked:

```json
{
  "action": "decline"
}
```

The tool then returned an error like:

```text
Computer Use approval denied via MCP elicitation for app 'com.apple.finder'.
```

This means a non-Codex harness must implement MCP elicitation, not just ordinary
client-to-server `tools/call`.

## Direct raw-MCP probe status

Read-only service-backed probes were first attempted against
`SkyComputerUseClient mcp` directly with:

1. A minimal raw JSON-RPC stdio client.
2. The official `@modelcontextprotocol/sdk` `Client` and `StdioClientTransport`.
3. The committed repository harness in `tools/probe-codex-computer-use-mcp.mjs`.
4. The installed Computer Use copy under `~/.codex/computer-use`.
5. The host-app bundled copy under `/Applications/Codex.app/Contents/Resources`.
6. Plain MCP `tools/call` parameters, `_meta.threadId`, and a Codex-like
   `_meta.x-codex-turn-metadata` payload.

These direct raw-MCP clients successfully:

- launched and initialized the MCP server,
- listed tools through `tools/list`,
- received `elicitation/create` for app-approval prompts,
- returned both decline and accept elicitation responses, and
- proved the decline path returns a normal MCP tool error.

The accepted direct raw-MCP service-backed calls still did **not** complete:

- `get_app_state` for Calculator timed out after 120 seconds with no tool result.
- `list_apps` as an MCP tool also hung, so the failure was not Calculator-specific.
- Adding Codex-style turn metadata under `params._meta["x-codex-turn-metadata"]`
  did not make `list_apps` return.
- Adding `_meta.threadId` did not make `list_apps` return.
- Starting Codex app-server, creating a real ephemeral thread, keeping app-server
  running, and then calling direct raw-MCP `list_apps` with `_meta.threadId` set
  to that real thread ID still timed out after 45 seconds.
- Launching the host-app bundled executable/cwd did not change behavior.

Fresh macOS unified-log evidence shows at least one host-app security gate, but
also shows that satisfying that gate is not the whole missing raw-MCP contract:

- During service-backed calls, `SkyComputerUseClient` sends an Apple Event to
  `SkyComputerUseService` (`AESendMessage(SkCu,XpcB ...)`).
- macOS TCC evaluates the **responsible host application**, not only the OpenAI
  helper binaries. In this pi session one responsible app was Repo Prompt:
  `kTCCCodeIdentityIdentifier = "com.pvncher.repoprompt"`.
- A Repo Prompt-hosted attempt logged an Apple Events rejection:
  `TCC RESULT:SkCu/XpcB = rejected, so storing this auditToken ... permanently`.
- Later iTerm-hosted attempts logged `TCC RESULT:SkCu/XpcB = accepted` and still
  timed out for direct raw-MCP `list_apps` after 30 seconds.
- Short process samples during a direct raw-MCP hang showed the client blocked in
  `xpc_pipe_receive`, while the service was idle aside from its Codex app-server
  thread-event observer and network/telemetry threads.
- Service logs also showed `Starting Codex appserver thread event observer` and
  `Connected to Codex appserver IPC socket`, followed by network requests with
  HTTP `200`/`202` summaries, but no direct raw-MCP tool result returned to the
  external client.

Interpretation:

- The MCP server surface is real.
- App approval elicitation is real and separate from macOS Automation/TCC approval.
- A non-Codex host may need explicit macOS Automation permission to control
  `Codex Computer Use.app`, and may also need Screen Recording/Accessibility
  permissions depending on the host and target app.
- Mac Automation/TCC permission is **not sufficient by itself** for direct raw
  MCP in the observed iTerm-hosted path; some Codex thread/session/lifecycle
  wrapper still appears to be missing.

## Working app-server bridge status

The successful path is to use Codex app-server as the compatibility shim around
Computer Use MCP:

```bash
/Applications/ChatGPT.app/Contents/Resources/codex app-server \
  --enable computer_use \
  --enable plugins \
  --enable tool_call_mcp_elicitation
```

The host client must then:

1. Send app-server `initialize` with current camelCase capability fields, for example `capabilities: { experimentalApi: true, requestAttestation: false }`.
2. Send `notifications/initialized`.
3. Send `thread/start` to create an ephemeral thread with `approvalPolicy: "on-request"` and explicit `config.mcp_servers` entries for `computer-use` (`mcp`), `event-stream` (`event-stream mcp`), and `skysight` (`skysight mcp`) using the bundled client under `/Applications/ChatGPT.app`.
4. Follow `nextCursor` across thread-scoped `mcpServerStatus/list` pages with `detail: "toolsAndAuthOnly"` to verify all 18 expected tools.
5. Send `mcpServer/tool/call` with `threadId`, the matching `server`, tool name,
   and tool arguments. Recording starts and exclusion changes require the local
   guards documented in the safety policy.
6. Answer any app-server `mcpServer/elicitation/request` server-to-client
   requests with an explicit `accept`, `decline`, or `cancel` response.

Validated app-server calls from this repo:

```bash
node tools/codex-computer-use-appserver.mjs status --quiet --pretty
node tools/codex-computer-use-appserver.mjs list-apps --quiet --max-text-chars 1000 --pretty
node tools/codex-computer-use-appserver.mjs get-state --app Calculator --quiet --max-text-chars 1200 --pretty
node tools/codex-computer-use-appserver.mjs get-state --app Finder --approval deny --quiet --max-text-chars 500 --pretty
node tools/codex-computer-use-appserver.mjs get-state --app Calculator --include-image --save-image /tmp/macuse-calculator.jpg --quiet --max-text-chars 200 --pretty
node tools/validate-macuse.mjs mutating
node tools/validate-macuse.mjs focus
```

Observed results:

- `status` printed compact inventories for `computer-use`, `event-stream`, and
  `skysight`, finding all 18 expected tools. Use `status --full` when every
  configured app-server MCP server is needed for diagnostics.
- `list-apps` returned a normal text result with running/recent apps and no
  elicitation.
- `get-state --app Calculator` returned a normal text
  result containing Calculator's accessibility tree plus one omitted image block
  when `--include-image` was not passed.
- `get-state --app Finder --approval deny` received one app-server
  `mcpServer/elicitation/request`, declined it, and returned the expected normal
  Computer Use denial text with `isError: true` instead of hanging.
- `get-state --include-image --save-image /tmp/macuse-calculator.jpg` returned a
  text block plus one JPEG image block and saved the screenshot to disk.
- `node tools/validate-macuse.mjs mutating` ran a guarded Activity Monitor
  sequence that filtered search for `Codex`, cleared search after name drift,
  switched to Memory, restored CPU, and verified final search/tab state.
- `node tools/validate-macuse.mjs focus` repeated the Activity Monitor probe and
  failed closed if native frontmost focus changed.

This proves a pi/Cursor-style integration can work today by wrapping Codex
app-server. Mutating actions should still stay inside the guarded sequence path
with before/after state checks and hard stop boundaries from the safety policy.

## Codex source cross-check

A local Codex source checkout exists at:

```text
/Users/yourname/Projects/AI/codex
```

Treat this as supporting evidence only; it may not exactly match the installed
Codex app build.

Notable source findings:

- `codex-rs/features/src/lib.rs` defines a `ComputerUse` feature flag described
  as "Allow Codex Computer Use" and marks it as requirements-only.
- `codex-rs/core/src/tools/handlers/tool_search.rs` special-cases the MCP server
  name `computer-use` with a larger search result bucket limit of `20`, which
  suggests Codex's internal agent flow treats Computer Use as a discoverable MCP
  tool family rather than only a hardcoded native tool.
- `codex-rs/app-server-protocol/src/protocol/v2/mcp.rs` models MCP
  `elicitation/create` as app-server protocol data with `thread_id`, optional
  `turn_id`, `server_name`, and the raw request. That is evidence that Codex adds
  app/thread/turn correlation around generic MCP elicitation.

Refresh command used for this cross-check:

```bash
rg -n "elicitation/create|turn-ended|computer-use|Computer Use|SkyComputerUse|CUAService|persist.*always|Allow Codex to use" \
  /Users/yourname/Projects/AI/codex -S
```

These source findings strengthen the caution: Codex likely exposes Computer Use
through MCP internally, but its host app also wraps MCP with discovery,
elicitation, and thread/turn correlation layers that a generic external harness
must replace or emulate.

## Committed tools and pi extension

This repository includes a standalone direct raw-MCP probe harness:

```text
tools/probe-codex-computer-use-mcp.mjs
```

It is intentionally lightweight: Node ESM, no external npm dependencies, no
package install step, and no `package.json` required. By default it launches the
currently observed installed client:

```text
/Users/yourname/.codex/computer-use/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient
```

with this plugin cache as `cwd`:

```text
/Users/yourname/.codex/plugins/cache/openai-bundled/computer-use/1.0.799
```

The harness implements bidirectional stdio JSON-RPC. It sends ordinary MCP
client requests, keeps pending requests alive while tool calls are active, and
answers server-to-client requests such as `elicitation/create`. Unknown
server-to-client requests are logged and receive JSON-RPC method-not-found
errors instead of hanging silently.

Supported safe probe commands:

```bash
node tools/probe-codex-computer-use-mcp.mjs --help
node tools/probe-codex-computer-use-mcp.mjs discover
node tools/probe-codex-computer-use-mcp.mjs apps --tool-timeout-ms 90000
node tools/probe-codex-computer-use-mcp.mjs deny --app Finder
node tools/probe-codex-computer-use-mcp.mjs state --app Calculator --approval interactive
node tools/probe-codex-computer-use-mcp.mjs state --app Calculator --tool-timeout-ms 90000
node tools/probe-codex-computer-use-mcp.mjs state --app Calculator --with-turn-metadata
node tools/probe-codex-computer-use-mcp.mjs logs --since 5m
```

Mode summary:

- `discover`: runs `initialize`, sends `notifications/initialized`, runs
  `tools/list`, and prints `serverInfo` plus a compact tool/schema summary.
- `apps`: calls the read-only service-backed `list_apps` tool. This is useful
  because it does not require app-specific approval yet still exercises the path
  that currently hangs from the pi/Repo Prompt host.
- `deny --app <app>`: calls `get_app_state` and automatically declines every
  `elicitation/create`. This is the preferred non-destructive regression check
  because it proves the safe app-approval denial path.
- `state --app <app> --approval interactive|accept-once|deny`: calls
  `get_app_state` with explicit approval handling. `interactive` prompts on the
  local terminal. `accept-once` accepts exactly one elicitation and declines any
  later elicitation. `deny` declines all elicitations. Add `--with-turn-metadata`
  to include a Codex-like `_meta.x-codex-turn-metadata` payload in the
  `tools/call` request.
- `logs --since <duration>`: runs filtered macOS unified-log collection for
  `SkyComputerUseClient` and `SkyComputerUseService`.

The harness logs JSON-RPC event boundaries to stderr in a structured but readable
format: client requests, server requests, responses, notifications, elicitation
decisions, unknown methods, timeouts, and child process exit. Tool-result content
is summarized rather than dumped so screenshots/accessibility text are not
written verbatim to logs.

The direct raw-MCP script only lists tools and calls read-only `list_apps` /
`get_app_state`. It does **not** perform click/type/drag/scroll probes. Keep it
as the discovery, elicitation, denial-path, and raw-MCP regression harness.

## Upstream native capability map

The installed `SkyComputerUseClient` exposes one public `computer-use` MCP server with 10 tools: `list_apps`, `get_app_state`, `click`, `perform_secondary_action`, `set_value`, `select_text`, `scroll`, `drag`, `press_key`, and `type_text`. Reuse these primitives; do not rebuild screenshot capture, AX capture, app sessions, pointer dispatch, keyboard dispatch, text selection, or app approval.

The same binary also exposes separate subcommands:

```bash
SkyComputerUseClient event-stream mcp
SkyComputerUseClient skysight mcp
SkyComputerUseClient turn-ended <payload>
```

`event-stream mcp` exposes `event_stream_start`, `event_stream_status`, and `event_stream_stop` for Record & Replay. `skysight mcp` exposes `skysight_start`, `skysight_stop`, `skysight_status`, `skysight_update_exclusion`, and `skysight_list_exclusions` for recent-activity context and exclusions. These are native upstream features, but they are separate privacy-sensitive recording surfaces and are not part of the default app-server `computer-use` server.

Binary-string evidence shows private upstream internals such as `virtualCursor`, `focusEnforcer`, `focusRestoreTarget`, `ComputerUseIPCFrontmostWindow`, `ComputerUseIPCScreenshot`, `ComputerUseIPCSkyshot`, `ActivateCodingKeys`, and `DeactivateCodingKeys`. Treat those as upstream-owned implementation details unless OpenAI exposes stable MCP/app-server schemas.

Wrapper-owned value should stay narrow: Codex app-server lifecycle, app approval bridging, safety gates, stable target ergonomics over raw indexes, sequencing, optional evidence readbacks, waits, output shaping, screenshot artifact saving, and focus/mouse evidence. Prefer deleting wrapper behavior when upstream exposes the same stable capability.

This repository also includes an app-server-backed standard MCP wrapper for
Cursor or other MCP-capable clients:

```text
tools/codex-computer-use-appserver-mcp.mjs
```

Example MCP config:

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

The wrapper exposes the Computer Use tool family over MCP while routing execution
through Codex app-server. It proxies MCP `elicitation/create` app-approval
prompts when the client advertises elicitation support; otherwise approval mode
`ask` falls back to decline. It is stateful: call `get_app_state` for an app
before mutating that app. Pointer `click` / `drag` require `allowPointer: true`
and restore mouse position after the call. Non-pointer AX actions do not need cursor restoration.

This repository also includes a validation wrapper for repeated checks:

```text
tools/validate-macuse.mjs
```

Use it before shipping bridge or extension changes:

```bash
node tools/validate-macuse.mjs quick
node tools/validate-macuse.mjs read-only
node tools/validate-macuse.mjs mutating
node tools/validate-macuse.mjs focus
node tools/validate-macuse.mjs mcp
```

The working app-server bridge is:

```text
tools/codex-computer-use-appserver.mjs
```

It launches Codex app-server with the required feature flags, initializes the
app-server protocol, starts an ephemeral thread, and calls Computer Use through
`mcpServer/tool/call`. It blocks non-read-only tools unless `--allow-mutating` is
explicitly passed.

Useful commands:

```bash
node tools/codex-computer-use-appserver.mjs --help
node tools/codex-computer-use-appserver.mjs status --quiet --pretty
node tools/codex-computer-use-appserver.mjs list-apps --quiet --pretty
node tools/codex-computer-use-appserver.mjs get-state --app Calculator --quiet --pretty
```

The installable pi extension source is:

```text
extensions/codex-computer-use.ts
```

It is declared through `package.json#pi.extensions` and registers one `macuse` pi tool with six actions:

- `action: "list_apps"`
- `action: "get_app_state"`
- `action: "sequence"`
- `action: "event_stream"`
- `action: "skysight"`
- `action: "restart_computer_use"`

The pi extension keeps a persistent Codex app-server process and thread for the
session instead of shelling out to the CLI bridge for every tool call. Normal
`session_shutdown` stops that process, `/macuse-stop` stops only app-server while
leaving lazy restart available. Read-only app state plus Record & Replay/Skysight status/list calls recover
stopped-session or transport-closed failures once by restarting only the
macuse-owned app-server session. `/macuse-restart` / `restart_computer_use`
explicitly restart Computer Use helper processes plus app-server when that
broader reset is intended. On macOS the extension writes a PID record under
`/tmp/macuse-appserver`, starts a small watchdog that monitors the originating pi
process, and reaps only matching macuse-owned orphaned `codex app-server`
processes on startup.
`macuse` actions `get_app_state` and `sequence` default to
`approval: "inherit"`, which auto-accepts Computer Use app-approval elicitations
to match Codex's Any App setting. For mutating `macuse` sequence steps, the
extension requires `allowMutating: true` and a concrete `safetyNote`. Sequence
steps can include `expectText`, `expectAbsentText`, `expectVisibleText`, and
`allowError` so the extension can stop on unexpected state or tool errors.
Sequence output defaults
to `detail: "compact"`; use `detail: "full"` when every raw tree is needed.
`macuse` sequence also accepts a sequence-level `app` default, which is
applied to steps whose `arguments` omit `app`. Element-targeted tools accept
`element_index` as a string or number, `element` as an alias, `elementId` /
`element_id` resolved from the latest `get_app_state` tree, exact
`elementDescription` / `element_description` matches for descriptions such as
Calculator `Add`, role/name selectors such as `{ "role": "button", "name":
"Add" }`, or `arguments.targets` fallback objects such as
`[{"elementId":"AllClear"},{"elementDescription":"Clear"},{"role":"button","name":"Clear"}]`.
The extension refreshes app state before element-targeted sequence steps so
stale numeric indices are easier to diagnose, but ID/description/role-name
targeting remains safer. Raw `element_index` targets can include
`expectedRole`, `expectedName`, `expectedDescription`, `expectedId`, or
`expectedValue`; mismatches fail before mutation with a stale-target diagnostic.
Failed target lookups return available `element_index` lines so the agent can
fall back without a separate state call. If a sequence fails after it starts, the
result includes all completed steps plus a failed-step diagnostic and resume hint
instead of discarding partial evidence. Per-step `allowError: true` also covers
element resolution errors, so optional/fallback steps can fail and the sequence
can continue.
Pointer-based `click` steps additionally require
`allowPointerClick: true`; pointer-based `drag` steps require
`allowPointerDrag: true` and use extension-level mouse restoration.
Prefer `perform_secondary_action` with `action: "Press"`, `press_key`,
`set_value`, or element-targeted `scroll` when possible to preserve the user's
mouse/system focus. `press_key` uses xdotool-style key names, such as `5`,
`Return`, `Escape`, `plus`, `minus`, `equal`, `ctrl+c`, and `super+comma`
for Command-,; `key:",", modifiers:["COMMAND"]` normalizes to `super+comma`.
Prefer `type_text` for literal text entry. `select_text` selects by matching a text string; upstream
Computer Use does not currently support start/end offset selection. `set_value`
accepts `value` inside `arguments`, and pi sequences also normalize top-level
step `value` into `arguments.value`. Search fields normalize
`role:"search text field"` to the parsed `role:"search"`; settable/search
fields expose semantic `tags` and stable names even when the accessible value is
folded into the raw line. Empty `set_value` uses a conservative clear-control
fallback when exactly one non-risky clear/cancel button is available. Non-empty
`set_value` is verified with a post-action state read only when evidence is requested
(`requireStateChange`, assertions, or image artifacts), so simple upstream successes stay fast. Per-step `expectText` /
`expectAbsentText` assertions strip invisible bidi marks before substring
matching, which makes accessibility text assertions such as `text 1` reliable;
`expectVisibleText` checks parsed visible text values directly, such as `0` or
`1`, so agents do not need to copy accessibility line formats for display
assertions. `macuse` action `get_app_state` supports `detail: "minimal"` for app/window,
visible text, and concise target hints, `detail: "compact"` for grouped
interactive elements, and `detail: "full"` for raw trees. `targetScope: "main"`
suppresses likely browser/app chrome and OS window controls in transformed
output where possible. Sequence `detail: "minimal"` suppresses successful action
and state bodies for lower-token action logs while still showing assertion pass
snippets, target resolution, stale-index warnings, changed-state summaries, and
failure evidence; `compact` remains the default and `full` keeps raw trees.
Sequence wait helper pseudo-tools (`waitForText` for parsed visible text or raw
text-entry values, `waitForElement`, `waitUntilElementEnabled`,
`waitUntilElementDisabled`, and best-effort `waitForURL` / `waitForTitle`) poll
`get_app_state` and reduce manual sleep / resnapshot loops. They separate
predicate `timeoutMs` from per-poll `toolTimeoutMs`, avoid issuing final
sub-1000ms transport calls, and `waitForText` can be scoped with `visibleOnly`,
`title`, and `url`. `get_app_state` and
sequence output include focus summaries (`before`, `after`, `frontmostChanged`,
and target-app frontmost checks) so background-control runs can prove whether the
target app stole focus. `get_app_state` and sequence `get_app_state` step details
include machine-readable parsed element metadata with target hints, `visibleText`,
`targets`, semantic `tags`, `changed`, `warnings`, and `nextActions` where
available. Mutating sequence steps perform a post-action state readback when
evidence is requested and report `actionDispatchedButNoStateChange` when an AX action reports success but
no observable title, URL, visible-text, or target change appears; per-step
`requireStateChange: true` makes that condition fail closed and captures a
pre-action baseline for non-element actions such as `press_key`; if the first
readback shows no change, a short delayed readback is attempted before failing
to better catch transient popovers/editors.
`includeImage` is model/host dependent; use `saveImagePath` when screenshot
artifacts must be reliable. In sequences, `saveImagePath` defaults to the first
step for compatibility; use `screenshotStep: "final"` to save the final visual
state. When upstream Computer Use returns its “application session stopped” sentinel
or a transport-closed error, macuse restarts only its app-server session and
retries read-only calls once automatically; the sentinel is sanitized into a
normal tool error instead of passing through an agent-stop instruction. Use
`restart_computer_use` or `/macuse-restart` for an explicit Computer Use helper
restart. When upstream Computer Use returns timeout errors such as `-10005
timeoutReached`, macuse annotates the result with a clear blocker: filtering
modes only reduce output after upstream responds and cannot make a hung browser
accessibility snapshot safe. For Chrome/web tasks, use
`agent_browser` when browser automation is acceptable, or retry Computer Use
after `/macuse-restart`, increasing `toolTimeoutMs`, or reducing heavy browser
windows/tabs.

### Rerun after Codex or Computer Use updates

First refresh the volatile install/cache paths if needed:

```bash
find /Users/yourname/.codex/plugins/cache/openai-bundled/computer-use -maxdepth 3 -name .mcp.json -print
find /Users/yourname/.codex/computer-use -iname SkyComputerUseClient -type f -print
```

Then rerun both the direct raw-MCP regression probes and the app-server positive
read-only probes:

```bash
# Direct raw-MCP discovery / denial-path checks.
node tools/probe-codex-computer-use-mcp.mjs discover
node tools/probe-codex-computer-use-mcp.mjs deny --app Finder
node tools/probe-codex-computer-use-mcp.mjs logs --since 5m

# App-server-backed positive read-only checks.
node tools/codex-computer-use-appserver.mjs status --quiet --pretty
node tools/codex-computer-use-appserver.mjs list-apps --quiet --pretty
node tools/codex-computer-use-appserver.mjs get-state --app Calculator --quiet --pretty
```

Keep direct raw-MCP `apps` / accepted `state` timeout probes available when
investigating raw-MCP parity, but do not require them to pass for the pi
app-server bridge:

```bash
node tools/probe-codex-computer-use-mcp.mjs apps --tool-timeout-ms 90000
node tools/probe-codex-computer-use-mcp.mjs state --app Calculator --tool-timeout-ms 90000
```

A live app-server thread ID alone is not enough for raw-MCP parity. A one-off
probe started app-server with Computer Use features, created an ephemeral thread,
kept app-server running, then called direct raw-MCP `list_apps` with
`_meta.threadId` set to that real thread ID; it still timed out after 45 seconds.

If the paths changed, pass the updated executable and plugin cwd explicitly:

```bash
node tools/probe-codex-computer-use-mcp.mjs discover \
  --client '/path/to/SkyComputerUseClient' \
  --cwd '/path/to/openai-bundled/computer-use/<version>'

node tools/probe-codex-computer-use-mcp.mjs deny --app Finder \
  --client '/path/to/SkyComputerUseClient' \
  --cwd '/path/to/openai-bundled/computer-use/<version>'
```

or set environment variables for repeated probes:

```bash
CODEX_CU_CLIENT='/path/to/SkyComputerUseClient' \
CODEX_CU_CWD='/path/to/openai-bundled/computer-use/<version>' \
node tools/probe-codex-computer-use-mcp.mjs discover
```

On a timeout, immediately collect recent logs and rerun with a larger timeout:

```bash
node tools/probe-codex-computer-use-mcp.mjs logs --since 5m
node tools/probe-codex-computer-use-mcp.mjs state --app Calculator --approval interactive --tool-timeout-ms 90000
```

If the timeout happens from a non-Codex host, also check for Automation/TCC
rejections tied to the responsible host app:

```bash
log show --style compact --last 10m \
  --predicate '(process == "SkyComputerUseService" OR process == "SkyComputerUseClient") AND (eventMessage CONTAINS[c] "AESendMessage" OR eventMessage CONTAINS[c] "TCCAccessRequestIndirect" OR eventMessage CONTAINS[c] "TCC RESULT" OR eventMessage CONTAINS[c] "Sender process")' \
  --info --debug 2>/dev/null
```

Useful signatures from external-host probes:

```text
AESendMessage(SkCu,XpcB ... target='kpid'[pid=<SkyComputerUseService> ...
kTCCCodeIdentityIdentifier = "com.pvncher.repoprompt"
TCC RESULT:SkCu/XpcB = rejected, so storing this auditToken ... permanently
TCC RESULT:SkCu/XpcB = accepted, so storing this auditToken ... permanently
Starting Codex appserver thread event observer
Connected to Codex appserver IPC socket at <private>
```

An accepted `TCC RESULT` only proves the Apple Events gate passed; it did not
make `list_apps` return in the observed iTerm-hosted probe.

June 26, 2026 repair note: a RepoPrompt-hosted pi session hit the same external-host AppleEvents gate while Codex.app Computer Use still worked. Raw `list_apps` returned `NSOSStatusErrorDomain Code=-609 "connectionInvalid"`; app-server `list_apps` returned `Computer Use server error -1743`; `get_app_state` returned `NSOSStatusErrorDomain Code=-1712 "errAETimeout"`. macOS logs showed `kTCCServiceAppleEvents` evaluating the responsible host `/Applications/CustomHost.app/Contents/MacOS/RepoPrompt` (`com.example.customhost`), not Codex.app. That proves this class of failure is host Automation/TCC, not a Computer Use tool inventory or parser change.

June 12, 2026 repair note: a pi session running under SSH/tmux hit a lower-level
AppleEvents gate where service-backed calls hung while raw MCP discovery still
worked. Logs showed `kTCCServiceAppleEvents` denials with the responsible
identity `/usr/libexec/sshd-keygen-wrapper`; the correct TCC row direction is
**responsible launcher -> `com.openai.sky.CUAService`**, not the inverse. After
adding that user-TCC AppleEvents grant and restarting `tccd`, `list_apps`
returned again. A later `cgWindowNotFound` was caused by the console being at
loginwindow/screensaver; `list_apps` reported `frontmost=<none>`, and unlocking
made `get_app_state` work again.

Use the repair tool for this class of failure. It is dry-run by default:

```bash
node tools/macuse-repair.mjs
node tools/macuse-repair.mjs --apply
node tools/macuse-repair.mjs --apply --restart-appserver
node tools/macuse-repair.mjs --apply --restart-service
node tools/macuse-repair.mjs --apply --unlock-with-env MACUSE_UNLOCK_PASSWORD
node tools/macuse-repair.mjs --apply --repair-tcc --responsible auto --restart-tccd --sudo-password-env MACUSE_SUDO_PASSWORD
```

`--repair-tcc --responsible auto` resolves the responsible launcher from
the current process tree. `--repair-tcc`
backs up the current user's TCC DB before writing and inserts only the
responsible launcher / `com.openai.sky.CUAService.cli` AppleEvents rows that
target `com.openai.sky.CUAService`. The applying host needs Full Disk Access to
read and back up the user TCC DB. `--unlock-with-env` uses a temporary local
Swift HID-event helper and does not install or download third-party code.

The important regression signals are:

1. Direct raw-MCP `discover` still initializes and lists the same expected tool
   family.
2. Direct raw-MCP `deny --app Finder` still receives `elicitation/create`, sends
   `{ "action": "decline" }`, and receives a normal MCP tool error instead of
   hanging.
3. App-server `status` still discovers `computer-use`, `event-stream`, and
   `skysight` with all 18 expected tools.
4. App-server filtered/running `list-apps --running-only --filter Calculator`
   still returns a normal read-only tool result. If only broad unfiltered
   `list_apps` reports `procNotFound`, treat that as degraded enumeration and
   prefer filtered lists while investigating.
5. App-server `get-state --app Calculator` still returns
   a normal read-only accessibility tree and, when requested, an image block.
6. `node tools/validate-macuse.mjs mutating` still completes the guarded
   Activity Monitor search/filter/clear and CPU/Memory restore smoke test.
7. `node tools/validate-macuse.mjs focus` still fails if the Activity Monitor
   mutating probe changes native frontmost focus.
8. Any direct raw-MCP accepted `state` probe either completes or produces enough
   JSON-RPC and macOS-log evidence to decide whether raw-MCP parity improved or
   still needs the app-server thread/session wrapper.

## Dogfood findings status

Recent multi-app trip-planning QA runs covered Calculator, TextEdit, Calendar,
Finder, and Brave using only macuse/Codex Computer Use. Current status:

- Calculator arithmetic, stable target fallback, `requireStateChange`, and final
  screenshot capture work well.
- Browser `waitForText` with `visibleOnly`, `title`, and `url` scoping now uses a
  broader visible corpus while keeping `title` as a strict window-title guard to
  avoid stale/page-text matches. `waitForURL` recognizes non-HTTP browser URLs
  such as `brave://newtab/` and `about:blank`. Browser address/search fields
  remain tagged `navigation-field`; treat `set_value` and `type_text` as
  potentially changing URL/title state or navigating/submitting. `type_text`
  goes to current keyboard focus, which may be page content rather than the
  omnibox. macuse warns when browser text input changes URL/title state.
- `expectVisibleText` now matches substrings across parsed visible text, window
  titles, visible control labels, and exposed text-field/search/edit values.
  Multiline field values are split into visible assertion lines when upstream
  exposes them.
- `requireStateChange` now takes baselines for non-element actions, performs a
  short delayed readback for transient UI, and can recover when an upstream
  action reports an error but post-action state proves the UI changed.
- TextEdit multiline editing remains partly upstream-dependent: macuse now groups
  multiline settable/value continuations into parsed visible assertions when
  upstream exposes the raw value, but some TextEdit states may still accept only
  the first line via `set_value` or expose only a summary. Prefer verifying
  individual visible lines; if a text area has no `Press` action, use
  `set_value`, carefully focused `type_text`, or stop.
- Calendar transient editors/popovers are inconsistent: `transient-editor` tags
  now make quick-event/popover targets rank higher in minimal/compact summaries,
  but transient contents may still be hidden or delayed. Escaping/closing a
  transient editor can be a no-op in state terms; verify final absence of
  draft/event text.
- Finder search/sidebar remains a weak surface: `cmd+f` can change UI while the
  upstream action reports `remoteConnection`, search text entry may not be
  targetable without pointer fallback, rows can have duplicate names, and many
  file rows appear as settable/navigation fields that should not be mutated.
  When a failed step has no app-state readback, macuse suppresses changed-state
  summaries to avoid false deltas from error text; re-read state before deciding
  whether Finder actually changed. Summaries now include a concise
  risk-sensitive-control note when controls such as Save/Delete/Add/Remove are
  visible.
- `Raise`/frontmost restoration is not reliable across apps and offscreen
  windows. Treat focus summaries as evidence, not a guarantee; report focus
  change/drift rather than hiding it.
- Upstream state collection can still be slow or time out for heavy Calendar,
  Finder, and browser windows. Detail/targetScope reduce output after upstream
  returns; they cannot make a hung snapshot safe.

## Implications for pi and Cursor agents

Reusable now for broad pi operation:

- The low-level macOS app-control implementation already exists in OpenAI's
  Computer Use install.
- The Computer Use tool contract is discoverable through direct raw MCP and
  app-server MCP status.
- Codex app-server supplies the thread/session/lifecycle wrapper that direct raw
  MCP was missing in these probes.
- The Codex skill and app-specific instruction files are available locally.
- pi can load `extensions/codex-computer-use.ts` through the package manifest and expose the single `macuse` tool with app control plus guarded Record & Replay and Skysight actions backed by one live Codex app-server thread.
- A harmless Activity Monitor search/filter/clear and CPU/Memory restore smoke
  test has passed through the app-server sequence path.

Still needed before broad mutating GUI operation:

1. Keep enforcing
   [`codex-computer-use-safety-policy.md`](./codex-computer-use-safety-policy.md),
   including explicit stop boundaries for purchases, account/security/privacy
   settings, credentials, destructive actions, and wrong-window detection.
2. Validate additional mutating tool shapes, such as scroll and text input, only
   in controlled apps/states with before/after `get_app_state` evidence.
3. Decide whether standalone mutating pi tools are ever worthwhile; the current
   default is one `macuse` tool with a guarded sequence action rather than many standalone mutating tools.
4. A host-app permission setup story for macOS Automation/TCC. Current evidence
   shows the service checks the responsible host app, such as Repo Prompt or a
   terminal, when the MCP client sends Apple Events to `Codex Computer Use.app`.
   App-server made read-only calls work from iTerm, but other hosts may still
   need explicit permission.
5. Popover/menu capture remains an upstream limitation to dogfood: after some
   model-picker/menu button actions, the next app state may not include the
   transient popover contents. A future extension/API shape could add
   `targetScope:"all-windows"` or `includePopovers:true` if upstream exposes
   those windows reliably.
6. Browser address/search fields are tagged `navigation-field` where detectable.
   Treat `set_value` on those controls as potentially navigating/submitting,
   not merely staging text.
7. Continued refresh checks after Codex app updates, because app-server protocol
   and feature flags may change.
8. Further investigation of whether direct raw MCP can ever be made to work
   without app-server, or whether app-server should be treated as the required
   compatibility layer.

## Commands to refresh volatile facts

Run these after ChatGPT or Computer Use updates.

### Find ChatGPT host app version

```bash
for app in '/Applications/ChatGPT.app'; do
  echo "--- $app"
  if [ -d "$app" ]; then
    /usr/libexec/PlistBuddy \
      -c 'Print :CFBundleName' \
      -c 'Print :CFBundleIdentifier' \
      -c 'Print :CFBundleExecutable' \
      -c 'Print :CFBundleShortVersionString' \
      -c 'Print :CFBundleVersion' \
      "$app/Contents/Info.plist" 2>/dev/null || true
    stat -f '%Sm %z %N' "$app" "$app/Contents/Info.plist" 2>/dev/null || true
  fi
done
```

### Find Computer Use installs and caches

```bash
find /Users/yourname/.codex -maxdepth 5 \
  \( -iname '*computer*use*' -o -iname '*cua*' -o -iname '*skycomputeruse*' -o -iname '*appshot*' \) \
  -print 2>/dev/null | sort

find '/Applications/ChatGPT.app/Contents/Resources/plugins/openai-bundled/plugins' -maxdepth 2 \
  -iname '*computer*use*' -print 2>/dev/null | sort
```

### Inspect plugin manifests

```bash
python3 - <<'PY'
import json, pathlib
paths = [
  pathlib.Path('/Users/yourname/.codex/plugins/cache/openai-bundled/computer-use/1.0.799/.codex-plugin/plugin.json'),
  pathlib.Path('/Applications/ChatGPT.app/Contents/Resources/plugins/openai-bundled/plugins/computer-use/.codex-plugin/plugin.json'),
]
for path in paths:
    if path.exists():
        print(f'--- {path}')
        print(json.dumps(json.loads(path.read_text()), indent=2))
PY
```

If the versioned cache path changes, discover it first:

```bash
find /Users/yourname/.codex/plugins/cache/openai-bundled/computer-use -maxdepth 2 -name plugin.json -print
```

### Inspect bundle IDs and build numbers

```bash
for plist in \
'/Users/yourname/.codex/computer-use/Codex Computer Use.app/Contents/Info.plist' \
'/Users/yourname/.codex/computer-use/Codex Computer Use.app/Contents/SharedSupport/Codex Computer Use Installer.app/Contents/Info.plist' \
'/Users/yourname/.codex/computer-use/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/Info.plist' \
'/Users/yourname/.codex/computer-use/Codex Computer Use.app/Contents/SharedSupport/CUALockScreenGuardian.app/Contents/Info.plist'; do
  echo "--- $plist"
  /usr/libexec/PlistBuddy \
    -c 'Print :CFBundleName' \
    -c 'Print :CFBundleIdentifier' \
    -c 'Print :CFBundleExecutable' \
    -c 'Print :CFBundleShortVersionString' \
    -c 'Print :CFBundleVersion' \
    "$plist" 2>/dev/null || true
done
```

### Verify code signing and notarization

```bash
codesign -dv --verbose=4 '/Users/yourname/.codex/computer-use/Codex Computer Use.app' 2>&1 | \
  grep -E 'Identifier=|CDHash=|Authority=|Timestamp=|TeamIdentifier=|Notarization|Runtime Version|VersionPlatform|VersionSDK|VersionMin' || true

spctl --assess --type execute --verbose=4 '/Users/yourname/.codex/computer-use/Codex Computer Use.app' 2>&1 || true
```

### Compare installed/cache/host-bundled executable hashes

```bash
shasum -a 256 \
'/Users/yourname/.codex/computer-use/Codex Computer Use.app/Contents/MacOS/SkyComputerUseService' \
'/Users/yourname/.codex/plugins/cache/openai-bundled/computer-use/1.0.799/Codex Computer Use.app/Contents/MacOS/SkyComputerUseService' \
'/Applications/ChatGPT.app/Contents/Resources/plugins/openai-bundled/plugins/computer-use/Codex Computer Use.app/Contents/MacOS/SkyComputerUseService' \
'/Users/yourname/.codex/computer-use/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient' \
'/Users/yourname/.codex/plugins/cache/openai-bundled/computer-use/1.0.799/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient' \
'/Applications/ChatGPT.app/Contents/Resources/plugins/openai-bundled/plugins/computer-use/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient'
```

### Locate skills and app instructions

```bash
grep -RIl 'Control local Mac apps through Computer Use\|Computer Use Confirmations Policy' \
  /Users/yourname/.codex/plugins/cache/openai-bundled \
  '/Applications/ChatGPT.app/Contents/Resources/plugins/openai-bundled/plugins' \
  2>/dev/null | sort

find '/Users/yourname/.codex/plugins/cache/openai-bundled/computer-use/1.0.799/Codex Computer Use.app/Contents/Resources/Package_ComputerUseClient.bundle/Contents/Resources/AppInstructions' \
  -maxdepth 1 -type f -name '*.md' -print | sort
```

### Probe Codex app-server auth plumbing

Computer Use binaries contain `CodexAppServerJSONRPCConnection` and
`X-OpenAI-Authorization` strings; the current Codex binary is bundled at
`/Applications/ChatGPT.app/Contents/Resources/codex`. The direct app-server can be probed safely over stdio. Use camelCase
parameter names; snake_case fields are silently ignored by this protocol layer.

```bash
python3 - <<'PY'
import json, subprocess, select, time
cmd = ['/Applications/ChatGPT.app/Contents/Resources/codex', 'app-server']
proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
def send(obj):
    proc.stdin.write(json.dumps(obj, separators=(',', ':')) + '\n')
    proc.stdin.flush()
def wait(request_id, timeout=30):
    end = time.time() + timeout
    while time.time() < end:
        readable, _, _ = select.select([proc.stdout, proc.stderr], [], [], 0.2)
        for stream in readable:
            line = stream.readline()
            if stream is proc.stdout:
                msg = json.loads(line)
                if msg.get('id') == request_id:
                    return msg
    return None
send({'jsonrpc':'2.0','id':1,'method':'initialize','params':{'clientInfo':{'name':'auth-probe','version':'0.1.0'},'capabilities':{'experimentalApi':True,'requestAttestation':False}}})
wait(1)
send({'jsonrpc':'2.0','method':'notifications/initialized','params':{}})
send({'jsonrpc':'2.0','id':2,'method':'getAuthStatus','params':{'includeToken':True,'refreshToken':False}})
result = wait(2)
if result and isinstance(result.get('result', {}).get('authToken'), str):
    result['result']['authToken'] = f"<redacted token len {len(result['result']['authToken'])}>"
print(json.dumps(result, indent=2))
proc.terminate()
PY
```

Observed result shape at refresh time included `authMethod: "chatgpt"`, a
redacted non-empty `authToken` when `includeToken` was spelled correctly, and
`requiresOpenaiAuth: true`. This confirms local app-server auth access exists;
the working app-server bridge probes above separately prove read-only Computer
Use tool execution.

The managed daemon path was not available on this machine at refresh time:

```bash
/Applications/ChatGPT.app/Contents/Resources/codex app-server daemon version
```

returned a missing control socket, and `app-server daemon start` reported that a
standalone Codex install was not present at
`/Users/yourname/.codex/packages/standalone/current/codex`. Direct stdio
`codex app-server` still worked for the auth-status probe above.

### Probe MCP help and tool listing

```bash
CLIENT='/Users/yourname/.codex/computer-use/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient'
"$CLIENT" --help
"$CLIENT" help mcp
"$CLIENT" help turn-ended
```

Use the committed harness for MCP discovery instead of the older ad hoc
Python snippets:

```bash
node tools/probe-codex-computer-use-mcp.mjs discover
```

### Probe app approval elicitation safely

This declines the app-use prompt, so it should not grant new app access:

```bash
node tools/probe-codex-computer-use-mcp.mjs deny --app Finder
```

For troubleshooting, collect recent filtered macOS logs:

```bash
node tools/probe-codex-computer-use-mcp.mjs logs --since 5m
```

### Probe full operation with the MCP SDK

This is the current failing/inconclusive probe. Keep it around as a regression
probe when trying to make non-Codex use work:

```js
import { Client } from 'file:///opt/homebrew/lib/node_modules/openclaw/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from 'file:///opt/homebrew/lib/node_modules/openclaw/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
import { ElicitRequestSchema } from 'file:///opt/homebrew/lib/node_modules/openclaw/node_modules/@modelcontextprotocol/sdk/dist/esm/types.js';

const command = '/Users/yourname/.codex/computer-use/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient';
const cwd = '/Users/yourname/.codex/plugins/cache/openai-bundled/computer-use/1.0.799';
const client = new Client(
  { name: 'codex-computer-use-sdk-probe', version: '0.0.0' },
  { capabilities: { elicitation: { form: {} } } },
);
client.setRequestHandler(ElicitRequestSchema, async (request) => {
  console.log('ELICITATION', JSON.stringify(request.params));
  return { action: 'accept', content: {} };
});
const transport = new StdioClientTransport({ command, args: ['mcp'], cwd });
await client.connect(transport);
console.log('CONNECTED');
const tools = await client.listTools();
console.log('TOOLS', tools.tools.map((t) => t.name).join(','));
const timeout = new Promise((_, reject) =>
  setTimeout(() => reject(new Error('get_app_state timeout after 45s')), 45000),
);
const result = await Promise.race([
  client.callTool({ name: 'get_app_state', arguments: { app: 'Calculator' } }),
  timeout,
]);
console.log(result);
await client.close();
```

## Staleness risks

These facts are likely to change with Codex updates:

- `/Applications/ChatGPT.app` version and bundled Codex/Computer Use contents.
- Versioned plugin-cache path under
  `/Users/yourname/.codex/plugins/cache/openai-bundled/computer-use/`.
- MCP server version hash returned by `initialize`.
- Tool schemas returned by `tools/list`.
- Skill text and app-specific instruction files.
- App-approval behavior and elicitation metadata.

Use the commands above instead of copying this document as static truth.
