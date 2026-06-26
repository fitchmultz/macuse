# macuse

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

Use Codex app-server as the compatibility bridge for Computer Use calls. `status` now prints a compact Computer Use-only projection; pass `--full` when you need every app-server MCP server:

```bash
node tools/codex-computer-use-appserver.mjs status --quiet --pretty
node tools/codex-computer-use-appserver.mjs list-apps --running-only --filter "Activity Monitor" --quiet --pretty
node tools/codex-computer-use-appserver.mjs get-state --app "Activity Monitor" --quiet --pretty
```

The packaged pi extension keeps a persistent Codex app-server thread for the session and registers:

- `codex_cu_list_apps`
- `codex_cu_get_app_state`
- `codex_cu_sequence` for multi-step flows, including mutating steps with `allowMutating: true`, a `safetyNote`, and optional per-step `expectText` / `expectAbsentText` / `expectVisibleText` assertions. App approval defaults to `inherit`, which auto-accepts Computer Use app approvals to match Codex's Any App setting. Pointer `click` steps also require `allowPointerClick: true`; pointer `drag` steps require `allowPointerDrag: true` and automatically restore mouse position. Prefer accessibility actions/keys/values to preserve mouse focus. Use sequence-level `app` to avoid repeating the same app in every step, or per-step `app` for multi-app sequences. Element targets accept `element_index` as a string or number, `element` as an alias, stable `elementId` values, exact `elementDescription` matches such as `CPU`, role/name selectors such as `{ "role": "search", "name": "search" }`, or `arguments.targets` fallback objects such as `[{"elementDescription":"Memory"},{"role":"button","name":"Memory"}]`; raw index targets can pass `expectedRole` / `expectedName` / `expectedValue` stale guards. Search fields normalize `role:"search text field"` to `role:"search"`; settable/search/transient fields expose `tags` such as `settable-field`, `search-field`, `transient-editor`, `clear-control`, and `risk-sensitive-control`, keep stable names when values change, prioritize transient editor targets in summaries, warn when risk-sensitive controls are visible, and support a conservative empty-`set_value` clear-button fallback when one clear control is available. Compact trees and failed lookups include preferred target syntax plus index fallbacks. `get_app_state` supports `detail: "minimal"` for app/window, visible text, and concise target hints, `detail: "compact"` for grouped interactive elements, and `detail: "full"` for raw trees; `targetScope: "main"` suppresses likely chrome/window controls where possible. Sequence output defaults to `detail: "compact"`; pass `detail: "minimal"` for assertion-focused low-token summaries or `detail: "full"` for complete trees. `get_app_state` and sequence details include parsed `visibleText`, `targets`/`elements`, target-stability diagnostics showing elementId/elementDescription/unique-role-name/raw-index coverage plus duplicate-ID/name warnings, focus before/after summaries, a concise sequence run summary, target warnings, changed-state summaries, resolved-target safety tags, and next-action hints. Mutating sequence steps now perform a post-action `get_app_state` readback; if upstream reports success but no title, URL, visible-text, or target change is observed, output includes `actionDispatchedButNoStateChange`, and per-step `requireStateChange: true` turns that warning into a sequence failure. `requireStateChange` takes a pre-action state baseline even for non-element actions such as `press_key`, so keyboard shortcuts can be verified without a prior manual `get_app_state`; if the first readback shows no change, it performs one short delayed readback before failing to better catch transient popovers/editors. Failed sequences return completed step results plus a failed-step diagnostic with `failedStepIndex`, `completedStepCount`, and `resumeFromStepIndex`; per-step `allowError: true` lets the sequence continue through resolution or tool errors. If a failed step has no app-state readback, changed-state summaries are suppressed to avoid false deltas from error text; re-read app state before deciding whether the UI changed. Sequence wait helpers (`waitForText` for parsed visible text or raw text-entry values, `waitForElement`, `waitUntilElementEnabled`, `waitUntilElementDisabled`, plus best-effort `waitForURL` / `waitForTitle`) poll `get_app_state` without manual sleeps; waits accept separate predicate `timeoutMs`, per-poll `toolTimeoutMs`, and `waitForText` accepts `visibleOnly`, strict window `title`, and `url` scoping. `waitForURL` recognizes HTTP(S), file, browser-internal URLs such as `brave://newtab/`, and `about:` URLs.

The persistent session avoids spawning the bridge for every pi tool call. On startup it uses app-server `mcpServerStatus/list` with `detail: "toolsAndAuthOnly"` to fail fast if the `computer-use` MCP server or its expected 10-tool inventory is missing; `/macuse-status` reports the cached inventory once running. Use `/macuse-stop` to stop the app-server process while leaving it available for lazy restart on the next tool call, and `/macuse-restart` to stop-and-lazily-restart after a suspected stale Computer Use state. The extension writes a macOS temp PID record under `/tmp/macuse-appserver`, starts a small watchdog, and reaps only matching macuse-owned orphaned `codex app-server` processes on startup; it does not try to own or kill Codex's global `SkyComputerUseService`. Use `codex_cu_list_apps({ runningOnly: true })` for a short currently-running app list.

The package also ships `/skill:macuse`, a small Agent Skill that teaches agents the safe default macuse workflow, target-selection order, mutation guardrails, and evidence to report when using the `codex_cu_*` tools.

## Optional repair / auto-heal

`tools/macuse-repair.mjs` is dry-run by default. It reports what it would do and requires `--apply` before it mutates local state. The safe apply path wakes the display, stops `ScreenSaver.Engine` if present, and reaps stale `/tmp/macuse-appserver` PID records. Extra repairs are explicit opt-ins:

```bash
# Stop macuse-owned app-server processes from registry records; does not kill global SkyComputerUseService.
node tools/macuse-repair.mjs --apply --restart-appserver

# Restart the global Computer Use service/helper stack when upstream service state is stale.
node tools/macuse-repair.mjs --apply --restart-service

# Unlock a screensaver/locked console with a password supplied by env.
node tools/macuse-repair.mjs --apply --unlock-with-env MACUSE_UNLOCK_PASSWORD

# Repair this SSH/tmux TCC AppleEvents path, back up the user TCC DB, and restart tccd.
node tools/macuse-repair.mjs --apply --repair-tcc --responsible auto --restart-tccd --sudo-password-env MACUSE_SUDO_PASSWORD
```

Do not commit password env files. Use a dedicated environment variable only for an explicitly approved local repair.

## Pi tool cookbook

List running apps:

```json
{ "runningOnly": true }
```

Inspect Activity Monitor with the lowest-token useful state view:

```json
{ "app": "Activity Monitor", "detail": "minimal" }
```

Safe Activity Monitor mutation:

```json
{
  "app": "Activity Monitor",
  "detail": "minimal",
  "targetScope": "main",
  "steps": [
    { "tool": "get_app_state", "arguments": {}, "expectVisibleText": "CPU" },
    { "tool": "set_value", "arguments": { "role": "search", "name": "search", "value": "Codex" }, "requireStateChange": true },
    { "tool": "get_app_state", "arguments": {}, "expectVisibleText": "Codex" },
    { "tool": "set_value", "arguments": { "role": "search", "name": "search", "value": "" }, "requireStateChange": true },
    { "tool": "perform_secondary_action", "arguments": { "elementDescription": "Memory", "action": "Press" }, "requireStateChange": true },
    { "tool": "perform_secondary_action", "arguments": { "elementDescription": "CPU", "action": "Press" }, "requireStateChange": true }
  ],
  "allowMutating": true,
  "safetyNote": "Activity Monitor only: temporary search text and CPU/Memory tab selection; do not press Stop, Inspector, Actions, or terminate processes."
}
```

Bad-target recovery: use the diagnostic's closest matches and per-row `target: { elementId: ... }` / `target: { elementDescription: ... }` / `target: { role, name }` hints, then retry from the failed `resumeFromStepIndex`. If you must use `element_index`, pass `expectedRole` and `expectedName` so the extension can fail closed before acting when the index goes stale. `expectVisibleText` matches substrings within parsed visible text nodes, window titles, visible control labels, and exposed text-field/search/edit values, including multiline settable/value continuations when upstream exposes them. If a mutating step reports `actionDispatchedButNoStateChange`, treat the intended open/navigation as unproven; retry from a fresh state read, then consider a guarded pointer click with `allowPointerClick` only when the target/window is unambiguous. Treat browser address/search fields tagged `navigation-field` as navigation/submission controls: `set_value` or `type_text` may change URL/title state or send a search rather than merely stage text; macuse warns when browser text input changes URL/title state, and notes that `type_text` goes to current keyboard focus, which may be page content rather than the omnibox. If upstream Computer Use returns `-10005 timeoutReached` while reading a browser such as Chrome, macuse cannot safely mutate that app; retry with `/macuse-stop` or `/macuse-restart` / larger `toolTimeoutMs` / fewer heavy browser windows, or use `agent_browser` for web automation when appropriate.

Save a screenshot artifact:

```json
{ "app": "Activity Monitor", "saveImagePath": ".scratch/activity-monitor.jpg", "detail": "compact" }
```

Tool details include saved image path, bytes, SHA-256, width, and height when an image is saved. In sequences, `saveImagePath` defaults to the first step for compatibility; pass `screenshotStep: "final"` to save the final visual state.

The installable extension entry lives at `extensions/codex-computer-use.ts`, uses modules in `extensions/codex-computer-use-modules/`, and is declared in `package.json#pi.extensions`. This package also declares `skills/` in `package.json#pi.skills`; there is no project-local `.pi/extensions` shim. Shared app-server/MCP helper code lives in `tools/cu-helpers.mjs`.

For local global install testing from this checkout:

```bash
pi install /Users/yourname/Projects/AI/macuse
```

Run `/reload` in pi after changing the extension source.

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

The wrapper exposes the Computer Use tool family over MCP while routing execution through Codex app-server. It defaults to `approval: "inherit"`, auto-accepting app approvals to match Codex's Any App setting; `approval: "ask"` is still available for clients that want MCP elicitation prompts. Element targets accept `element_index`, `element`, stable `elementId` / `element_id`, or exact `elementDescription` / `element_description`; stable targets are resolved against a fresh app state before mutation. Pointer `click` / `drag` require `allowPointer: true` and restore mouse position afterward.

## Probe path

Use the direct raw-MCP harness for discovery, best-effort app-approval denial diagnostics, and raw-MCP parity investigation:

```bash
node tools/probe-codex-computer-use-mcp.mjs discover
node tools/probe-codex-computer-use-mcp.mjs deny --app Finder
```

Direct raw-MCP denial and accepted `list_apps` / `get_app_state` can fail or hang in tested external hosts. Use the app-server bridge for authoritative positive operation; validation reports raw-MCP denial failures as warnings.

## Docs

Start at [`docs/README.md`](docs/README.md), then see [`docs/reference/parity-matrix.md`](docs/reference/parity-matrix.md) and [`docs/reference/codex-computer-use-external-harness.md`](docs/reference/codex-computer-use-external-harness.md) for the latest findings and refresh commands.
