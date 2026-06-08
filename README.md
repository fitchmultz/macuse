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

Run the reusable smoke suite:

```bash
node tools/validate-macuse.mjs quick
node tools/validate-macuse.mjs read-only
node tools/validate-macuse.mjs mutating
node tools/validate-macuse.mjs focus
node tools/validate-macuse.mjs mcp
```

Or via npm scripts:

```bash
npm run doctor
npm run demo
npm run validate:focus
npm run validate:mcp
```

## Working path

Use Codex app-server as the compatibility bridge for Computer Use calls:

```bash
node tools/codex-computer-use-appserver.mjs status --quiet --pretty
node tools/codex-computer-use-appserver.mjs list-apps --quiet --pretty
node tools/codex-computer-use-appserver.mjs get-state --app Calculator --quiet --pretty
```

The project-local pi extension keeps a persistent Codex app-server thread for the session and registers:

- `codex_cu_list_apps`
- `codex_cu_get_app_state`
- `codex_cu_sequence` for multi-step flows, including mutating steps with `allowMutating: true`, a `safetyNote`, and optional per-step `expectText` / `expectAbsentText` assertions. App approval defaults to `inherit`, which auto-accepts Computer Use app approvals to match Codex's Any App setting. Pointer `click` steps also require `allowPointerClick: true`; pointer `drag` steps require `allowPointerDrag: true` and automatically restore mouse position. Prefer accessibility actions/keys/values to preserve mouse focus. Element targets accept `element_index` as a string or number, `element` as an alias, or stable `elementId` values from the latest `get_app_state` tree; failed `elementId` lookups include index fallback hints. Sequence output defaults to `detail: "compact"`; pass `detail: "full"` for complete trees. Failed sequences return completed step results plus a failed-step diagnostic instead of discarding partial evidence.

The persistent session avoids spawning the bridge for every pi tool call. Use `/macuse-status` to inspect it and `/macuse-restart` to stop it; it restarts lazily on the next Computer Use tool call. Use `codex_cu_list_apps({ runningOnly: true })` for a short currently-running app list.

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

The wrapper exposes the Computer Use tool family over MCP while routing execution through Codex app-server. It defaults to `approval: "inherit"`, auto-accepting app approvals to match Codex's Any App setting; `approval: "ask"` is still available for clients that want MCP elicitation prompts. Pointer `click` / `drag` require `allowPointer: true` and restore mouse position afterward.

## Probe path

Use the direct raw-MCP harness for discovery, app-approval denial-path checks, and raw-MCP parity investigation:

```bash
node tools/probe-codex-computer-use-mcp.mjs discover
node tools/probe-codex-computer-use-mcp.mjs deny --app Finder
```

Direct raw-MCP accepted `list_apps` / `get_app_state` still hangs in tested external hosts. Use the app-server bridge for positive read-only operation.

## Docs

Start at [`docs/README.md`](docs/README.md), then see [`docs/reference/parity-matrix.md`](docs/reference/parity-matrix.md) and [`docs/reference/codex-computer-use-external-harness.md`](docs/reference/codex-computer-use-external-harness.md) for the latest findings and refresh commands.
