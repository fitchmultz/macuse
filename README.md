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
npm run demo
npm run validate:focus
npm run validate:mcp
```

## Working path

Use Codex app-server as the compatibility bridge for Computer Use calls. `status` now prints a compact Computer Use-only projection; pass `--full` when you need every app-server MCP server:

```bash
node tools/codex-computer-use-appserver.mjs status --quiet --pretty
node tools/codex-computer-use-appserver.mjs list-apps --quiet --pretty
node tools/codex-computer-use-appserver.mjs get-state --app Calculator --quiet --pretty
```

The project-local pi extension keeps a persistent Codex app-server thread for the session and registers:

- `codex_cu_list_apps`
- `codex_cu_get_app_state`
- `codex_cu_sequence` for multi-step flows, including mutating steps with `allowMutating: true`, a `safetyNote`, and optional per-step `expectText` / `expectAbsentText` / `expectVisibleText` assertions. App approval defaults to `inherit`, which auto-accepts Computer Use app approvals to match Codex's Any App setting. Pointer `click` steps also require `allowPointerClick: true`; pointer `drag` steps require `allowPointerDrag: true` and automatically restore mouse position. Prefer accessibility actions/keys/values to preserve mouse focus. Use sequence-level `app` to avoid repeating the same app in every step, or per-step `app` for multi-app sequences. Element targets accept `element_index` as a string or number, `element` as an alias, stable `elementId` values, exact `elementDescription` matches such as `Add`, role/name selectors such as `{ "role": "button", "name": "Add" }`, or `arguments.targets` fallback objects such as `[{"elementId":"AllClear"},{"elementDescription":"Clear"},{"role":"button","name":"Clear"}]`; raw index targets can pass `expectedRole` / `expectedName` / `expectedValue` stale guards. Search fields normalize `role:"search text field"` to `role:"search"`; settable/search fields expose `tags` such as `settable-field`, `search-field`, `clear-control`, and `risk-sensitive-control`, keep stable names when values change, and support a conservative empty-`set_value` clear-button fallback when one clear control is available. Compact trees and failed lookups include preferred target syntax plus index fallbacks. `get_app_state` supports `detail: "minimal"` for app/window, visible text, and concise target hints, `detail: "compact"` for grouped interactive elements, and `detail: "full"` for raw trees; `targetScope: "main"` suppresses likely chrome/window controls where possible. Sequence output defaults to `detail: "compact"`; pass `detail: "minimal"` for assertion-focused low-token summaries or `detail: "full"` for complete trees. `get_app_state` and sequence details include parsed `visibleText`, `targets`/`elements`, target-stability diagnostics showing elementId/elementDescription/unique-role-name/raw-index coverage, focus before/after summaries, target warnings, changed-state summaries, and next-action hints. Failed sequences return completed step results plus a failed-step diagnostic with `failedStepIndex`, `completedStepCount`, and `resumeFromStepIndex`; per-step `allowError: true` lets the sequence continue through resolution or tool errors. Sequence wait helpers (`waitForText` for parsed visible text or raw text-entry values, `waitForElement`, `waitUntilElementEnabled`, `waitUntilElementDisabled`, plus best-effort `waitForURL` / `waitForTitle`) poll `get_app_state` without manual sleeps.

The persistent session avoids spawning the bridge for every pi tool call. On startup it uses app-server `mcpServerStatus/list` with `detail: "toolsAndAuthOnly"` to fail fast if the `computer-use` MCP server or its expected 10-tool inventory is missing; `/macuse-status` reports the cached inventory once running. Use `/macuse-stop` to stop the app-server process while leaving it available for lazy restart on the next tool call, and `/macuse-restart` to stop-and-lazily-restart after a suspected stale Computer Use state. The extension writes a macOS temp PID record under `/tmp/macuse-appserver`, starts a small watchdog, and reaps only matching macuse-owned orphaned `codex app-server` processes on startup; it does not try to own or kill Codex's global `SkyComputerUseService`. Use `codex_cu_list_apps({ runningOnly: true })` for a short currently-running app list.

## Pi tool cookbook

List running apps:

```json
{ "runningOnly": true }
```

Inspect Calculator with the lowest-token useful state view:

```json
{ "app": "Calculator", "detail": "minimal" }
```

Safe Calculator mutation:

```json
{
  "app": "Calculator",
  "detail": "minimal",
  "steps": [
    { "tool": "get_app_state", "arguments": {} },
    { "tool": "perform_secondary_action", "arguments": { "targets": [{ "elementId": "AllClear" }, { "elementDescription": "Clear" }], "action": "Press" } },
    { "tool": "perform_secondary_action", "arguments": { "role": "button", "name": "1", "action": "Press" } },
    { "tool": "waitForText", "arguments": { "text": "1", "timeoutMs": 5000 } },
    { "tool": "perform_secondary_action", "arguments": { "elementDescription": "Add", "action": "Press" } },
    { "tool": "perform_secondary_action", "arguments": { "elementDescription": "2", "action": "Press" } },
    { "tool": "perform_secondary_action", "arguments": { "elementDescription": "Equals", "action": "Press" } },
    { "tool": "get_app_state", "arguments": {}, "expectVisibleText": "3" }
  ],
  "allowMutating": true,
  "safetyNote": "Calculator-only smoke: clear, compute 1+2, verify result, no sends/deletes/purchases."
}
```

Bad-target recovery: use the diagnostic's closest matches and per-row `target: { elementId: ... }` / `target: { elementDescription: ... }` / `target: { role, name }` hints, then retry from the failed `resumeFromStepIndex`. If you must use `element_index`, pass `expectedRole` and `expectedName` so the extension can fail closed before acting when the index goes stale. If upstream Computer Use returns `-10005 timeoutReached` while reading a browser such as Chrome, macuse cannot safely mutate that app; retry with `/macuse-stop` or `/macuse-restart` / larger `toolTimeoutMs` / fewer heavy browser windows, or use `agent_browser` for web automation when appropriate.

Save a screenshot artifact:

```json
{ "app": "Calculator", "saveImagePath": ".scratch/calculator.jpg", "detail": "compact" }
```

Tool details include saved image path, bytes, SHA-256, width, and height when an image is saved.

The installable extension source lives at `extensions/codex-computer-use.ts` and is declared in `package.json#pi.extensions`. The project-local `.pi/extensions/codex-computer-use.ts` file is only a dogfood shim for checkout development and `/reload`.

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

Use the direct raw-MCP harness for discovery, app-approval denial-path checks, and raw-MCP parity investigation:

```bash
node tools/probe-codex-computer-use-mcp.mjs discover
node tools/probe-codex-computer-use-mcp.mjs deny --app Finder
```

Direct raw-MCP accepted `list_apps` / `get_app_state` still hangs in tested external hosts. Use the app-server bridge for positive read-only operation.

## Docs

Start at [`docs/README.md`](docs/README.md), then see [`docs/reference/parity-matrix.md`](docs/reference/parity-matrix.md) and [`docs/reference/codex-computer-use-external-harness.md`](docs/reference/codex-computer-use-external-harness.md) for the latest findings and refresh commands.
