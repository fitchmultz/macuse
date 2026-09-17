# macuse

> [!WARNING]
> **Experimental and unsupported.** macuse uses Codex app-server's [documented experimental MCP bridge](https://learn.chatgpt.com/docs/app-server) with proprietary Computer Use schemas that may change without notice. Review the [safety policy](docs/reference/codex-computer-use-safety-policy.md) before granting macOS permissions or running mutating or repair commands.

Local tooling and notes for testing whether OpenAI Codex Computer Use can be reused from non-Codex agents such as pi.

## One-command wow path

Run a full live demo with receipts:

```bash
node tools/macuse-demo.mjs --out .scratch/macuse-demo
```

The demo writes:

- `report.md` — human-readable proof
- `index.html` — visual dashboard with before/during/after screenshots
- `transcript.json` — exact command/result evidence
- `cursor-mcp.json` — ready-to-copy MCP config

Run a health audit without the demo artifacts:

```bash
node tools/macuse-doctor.mjs --out .scratch/doctor
node tools/macuse-doctor.mjs --out .scratch/doctor-full --full
```

Preview optional local repair actions:

```bash
node tools/macuse-repair.mjs
```

Apply safe local repairs only after opting in:

```bash
node tools/macuse-repair.mjs --apply
```

Generate client config for the current checkout:

```bash
node tools/macuse-config.mjs cursor --pretty
```

## Validation

macuse requires macOS, the installed Codex Computer Use runtime, and Pi 0.84.0 or later for the extension. Pi runtime packages remain peer dependencies supplied by the host. Native observation and selected-text editing use an async helper lazily compiled by the installed Swift compiler (`xcrun swiftc`) and cached under `~/Library/Caches/macuse/native`. Accessibility permission is required for AX window/text access; upstream Screen Recording and Automation requirements still apply. macuse does not install a compiler or bypass permission gates. `macuse-doctor` checks the compiler and native helper's Accessibility access under the current launcher.

Run the reusable smoke suite (add `--json` to `validate-macuse.mjs` for machine-readable pass/warn/fail summaries):

```bash
node tools/validate-macuse.mjs quick
node tools/validate-macuse.mjs read-only
node tools/validate-macuse.mjs mutating
node tools/validate-macuse.mjs focus
node tools/validate-macuse.mjs mcp
node tools/validate-macuse.mjs quick --json
```

Or via npm scripts:

```bash
npm run doctor
npm run repair
npm run repair:apply
npm run demo
npm run validate:focus
npm run validate:mcp
```

## Working path

Use the Codex app-server bundled inside `/Applications/ChatGPT.app` as the compatibility bridge for Computer Use calls. macuse mirrors the three current plugin manifests, including each plugin's `computer-use-client-launcher`, working directory, arguments, and `CODEX_HOME`, so stale or disabled global config cannot shadow them. Startup reads effective config, disables inherited MCP servers/plugins for the thread, and launches with `--disable apps`: only these three families are started, while plugin `CODEX_HOME` remains available. It sends the current app-server `initialized` notification and waits for asynchronous MCP startup before dispatch. `status` prints compact inventories for `computer-use`, `event-stream`, and `computer-history`; pass `--full` when you need every configured app-server MCP server:

```bash
node tools/codex-computer-use-appserver.mjs status --quiet --pretty
node tools/codex-computer-use-appserver.mjs list-apps --running-only --filter "Activity Monitor" --quiet --pretty
node tools/codex-computer-use-appserver.mjs get-state --app "Activity Monitor" --quiet --pretty
```

The packaged pi extension keeps one persistent Codex app-server thread and registers all 18 tools in macuse's configured Computer Use scope:

- Computer Use: `list_apps`, `get_app_state`, `perform_secondary_action`, `press_key`, `type_text`, `set_value`, `select_text`, `scroll`, `click`, and `drag`.
- Record & Replay: `event_stream_start`, `event_stream_status`, and `event_stream_stop`.
- Computer History: `computer_history_pause`, `computer_history_resume`, `computer_history_status`, `computer_history_get_settings`, and `computer_history_update_settings`.
- Pi helpers: `macuse_sequence` for ordered flows/waits/assertions, `macuse_tools` for additive on-demand activation, and `macuse_restart` for an explicit Computer Use helper plus app-server restart.

Pi startup, new-session, resume, fork, and reload boundaries reset activation to `list_apps`, `get_app_state`, `macuse_sequence`, and `macuse_tools`. Call `macuse_tools` again for the exact direct, recording, history, or recovery tools needed; macuse adds one hidden transcript note after an unacknowledged earlier activation so stale claims are not mistaken for current state.

Direct mutating Computer Use tools require `allowMutating:true`, a `safetyNote` naming the target/effect/stop boundary, and a recent `get_app_state`. Every mutation now refreshes that app state immediately before dispatch, including keyboard and other non-element actions, and blocks dispatch if the refresh fails. Element-targeted calls accept `element_index`/`element`, stable `elementId`, exact `elementDescription`, role/name selectors, ordered `targets` fallbacks, and raw-index `expected*` stale guards. Mutations reject document drift since the last observed state; optional `expectedTitle` / `expectedUrl` pin the intended window/document at preflight. Title guards use the full standard-window title when available, not the abbreviated `Window:` header. Direct `click`/`drag` also require `allowPointer:true`. macuse never warps the cursor; upstream input may still interrupt the user. Prefer `perform_secondary_action` with `action:"Press"`, `press_key`, `set_value`, or `scroll` over pointer actions. `press_key` accepts xdotool-style combos such as `super+comma`, and `key:",", modifiers:["COMMAND"]` normalizes to that form.

`macuse_sequence` uses the same guarded executor and adds ordered steps, a sequence-level default `app`, wait helpers, assertions, resumable partial failures, and `allowPointerClick` / `allowPointerDrag` for pointer steps. Sequence recording starts and Computer History resume require top-level `allowRecording:true`; settings updates require top-level `allowPrivacyChange:true` plus the complete `observation` in that step's arguments. It defaults to `detail:"compact"`; use `minimal` for low-token evidence or `full` for raw trees. The entire sequence's arguments and safety gates are validated before its first dispatch. `set_value` always verifies the resolved field's requested value, not matching text elsewhere. `requireStateChange:true` requests relevant target/document evidence; unrelated clock updates do not prove an element action worked. Empty `set_value` can use one conservative non-risky clear control. Wait helpers (`waitForText`, `waitForElement`, `waitUntilElementEnabled`, `waitUntilElementDisabled`, and best-effort `waitForURL` / `waitForTitle`) poll `get_app_state` without manual sleeps.

`get_app_state` defaults to `detail:"minimal"` and `trackFocus:true`; `maxTextChars` caps presentation, not the complete internal state used for targeting, guards, or assertions. Native activation and focused-window events supplement endpoint snapshots. Observations omit other apps' window titles and document URLs. Coverage gaps, unavailable AX data, and unknown input attribution remain explicit: observations are not a universal non-interruption guarantee.

`type_text` prefers native `AXSelectedText` replacement in the already-focused control, with window/document/element/selection guards and exact readback. The native helper posts no keyboard input and writes no clipboard. Unsupported Unicode fails before mutation; ASCII may use upstream typing when native editing is unsupported. An attempted but unverified edit is never replayed through a fallback.

The persistent session verifies all three live inventories (`computer-use` 10, `event-stream` 3, `computer-history` 5), serializes calls that share its app-server thread/cache, and avoids spawning a bridge per tool call. `/macuse-status` reports its cached inventory; `/macuse-stop` stops the owned app-server and native helper, not the global Computer Use service; `/macuse-restart` restarts Computer Use helpers plus app-server; enable `macuse_restart` with `macuse_tools` before using the tool equivalent. Read-only app-state and status/settings calls auto-recover stopped-session or transport-closed failures once by restarting only the extension-owned app-server session. PID records and the watchdog live under `/tmp/macuse-appserver`.

Record & Replay captures clicks, typed text, and interacted-window content for up to 30 minutes; starting while a session is active returns that session. Record & Replay start and Computer History resume require `allowRecording:true` plus a non-empty `safetyNote`. `computer_history_update_settings` requires `allowPrivacyChange:true`, a safety note, the complete `observation` object, copied from an immediate `computer_history_get_settings` read with unchanged fields preserved. Status/settings reads can expose activity/privacy metadata; stop/pause need no allow flag.

The installed client also exposes a separate Messages MCP with read/search/send tools. Macuse intentionally excludes it because messaging is outside this package's app-control scope and `send_message` crosses a hard safety boundary. The current app-server also advertises a separate `node_repl` MCP with `js`, `js_add_node_module_dir`, and `js_reset`; macuse excludes unrestricted JavaScript/module execution. `turn-ended` remains excluded because it has no published payload contract. The package also ships `/skill:macuse`, which teaches the loader, direct tools, `macuse_sequence`, targeting order, mutation guards, and audit evidence.

## Optional repair / auto-heal

`tools/macuse-repair.mjs` is dry-run by default. It reports what it would do and requires `--apply` before it mutates local state. The safe apply path wakes the display, stops `ScreenSaver.Engine` if present, and reaps stale `/tmp/macuse-appserver` PID records. Extra repairs are explicit opt-ins:

```bash
# Stop macuse-owned app-server processes from registry records; does not kill global SkyComputerUseService.
node tools/macuse-repair.mjs --apply --restart-appserver

# Restart the global Computer Use service/helper stack when upstream service state is stale.
node tools/macuse-repair.mjs --apply --restart-service

# Unlock a screensaver/locked console with a password supplied by env.
node tools/macuse-repair.mjs --apply --unlock-with-env MACUSE_UNLOCK_PASSWORD

# Repair this host's TCC AppleEvents path, back up the user TCC DB, and restart tccd.
# --responsible auto detects the current responsible app/process (RepoPrompt, iTerm, sshd, etc.).
node tools/macuse-repair.mjs --apply --repair-tcc --responsible auto --restart-tccd --sudo-password-env MACUSE_SUDO_PASSWORD
```

Do not commit password env files. Use a dedicated environment variable only for an explicitly approved local repair.

## Pi tool cookbook

Call `list_apps`:

```json
{ "runningOnly": true }
```

Call `get_app_state`:

```json
{ "app": "Activity Monitor", "detail": "minimal", "targetScope": "main" }
```

Enable direct `set_value` for one guarded mutation:

```json
{ "tools": ["set_value"] }
```

Then call it:

```json
{
  "app": "Activity Monitor",
  "role": "search",
  "name": "search",
  "value": "Codex",
  "allowMutating": true,
  "safetyNote": "Activity Monitor only: temporarily filter search; do not press Stop, Inspector, Actions, or terminate processes.",
  "requireStateChange": true,
  "detail": "minimal"
}
```

Call `macuse_sequence` for an ordered flow:

```json
{
  "app": "Activity Monitor",
  "detail": "minimal",
  "targetScope": "main",
  "steps": [
    { "tool": "get_app_state", "arguments": {} },
    { "tool": "set_value", "arguments": { "role": "search", "name": "search", "value": "Codex" }, "requireStateChange": true },
    { "tool": "set_value", "arguments": { "role": "search", "name": "search", "value": "" }, "requireStateChange": true }
  ],
  "allowMutating": true,
  "safetyNote": "Activity Monitor only, after verifying search is empty: temporarily filter and clear search; do not press Stop, Inspector, Actions, or terminate processes."
}
```

Run the search example only after verifying the original search is empty. Sequences stop on failure; they are not transactions or guaranteed cleanup. Validation captures Activity Monitor's original tab and restores it in `finally`, rather than assuming CPU.

Failure recovery: Pi marks failed tool results `isError:true` while preserving partial step details. Inspect `dispatched` and `outcome`; `resumeFromStepIndex` is supplied only when the failed action was not dispatched. Re-read state before retrying that step. A timeout or abort does not cancel an upstream action: it may still complete, and the persistent transport holds its queue until settlement or owned-process shutdown. Never automatically replay a dispatched or unknown-outcome mutation. Direct pointer fallback requires `allowPointer:true`; sequence pointer steps require `allowPointerClick` / `allowPointerDrag`. Treat `actionDispatchedButNoStateChange` as unproven, and treat browser `navigation-field` inputs as possible navigation/submission controls. Enable `macuse_restart` with `macuse_tools` for an intentional full helper reset; prefer `agent_browser` for ordinary web DOM automation.

Save a screenshot with `get_app_state`:

```json
{ "app": "Activity Monitor", "saveImagePath": ".scratch/activity-monitor.jpg", "detail": "compact" }
```

Tool details include saved image path, bytes, SHA-256, width, and height when an image is saved. In sequences, `saveImagePath` defaults to the first step for compatibility; pass `screenshotStep: "final"` to save the final visual state.

The installable extension entry lives at `extensions/codex-computer-use.ts`, uses modules in `extensions/codex-computer-use-modules/`, and is declared in `package.json#pi.extensions`. This package also declares `skills/` in `package.json#pi.skills`; there is no project-local `.pi/extensions` shim. Shared app-server/MCP helper code lives in `tools/cu-helpers.mjs`.

For local global install testing from this checkout, use Pi 0.84.0 or later:

```bash
pi install /Users/yourname/Projects/AI/macuse
```

Quit and start a new Pi process after changing extension code or dependencies; restart CLI/MCP processes too. A new process also picks up native helper source changes and its source-hash cache. `/reload` reinitializes resources and resets tool activation, but does not load updated extension code.

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

The wrapper exposes all 18 tools in its configured Computer Use, Record & Replay, and Computer History families while routing execution through Codex app-server. It defaults to `approval: "inherit"` under macuse's standing app-access policy; `approval: "ask"` is available for clients that want MCP elicitation prompts. Every Computer Use mutation requires `allowMutating:true`, a `safetyNote`, and an immediate fresh app-state read. Element targets accept `element_index`, `element`, stable `elementId` / `element_id`, or exact `elementDescription` / `element_description`. Pointer `click` / `drag` additionally require `allowPointer: true`; macuse does not warp the cursor. The standalone bridges share startup isolation and native text safety, but do not expose the full Pi sequence executor, waits, or structured evidence surface. Like the pi extension, the wrapper sanitizes stopped-session sentinels and restarts only its app-server session before retrying read-only app/status/settings calls once.

## Probe path

Use the direct raw-MCP harness for discovery, best-effort app-approval denial diagnostics, and raw-MCP parity investigation:

```bash
node tools/probe-codex-computer-use-mcp.mjs discover
node tools/probe-codex-computer-use-mcp.mjs deny --app Finder
```

Direct raw-MCP denial and accepted `list_apps` / `get_app_state` can fail, hang, or disturb focus in tested external hosts; exclude them from non-interruption validation. Use the app-server bridge for authoritative positive operation; validation reports raw-MCP denial failures as warnings.

## Docs

Start at [`docs/README.md`](docs/README.md), then see [`docs/reference/parity-matrix.md`](docs/reference/parity-matrix.md) and [`docs/reference/codex-computer-use-external-harness.md`](docs/reference/codex-computer-use-external-harness.md) for the latest findings and refresh commands.
