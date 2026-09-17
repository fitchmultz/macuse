# Computer Use parity matrix

Source: Local `macuse` probes against Codex app-server, the packaged pi extension, and the app-server-backed MCP wrapper.
Created: May 22, 2026
Installed-version baseline: August 17, 2026, ChatGPT 26.810.52044, Codex CLI 0.148.0-alpha.9, plugins 1.0.1000717, and Computer Use client 26.727.1000550; wrapper behavior follows current source
Status: Current working parity tracker; refresh after ChatGPT, Codex, or Computer Use updates.

## Summary

The non-Codex path now uses Codex app-server as the required compatibility layer.
It does not rely on direct raw `SkyComputerUseClient mcp` for positive tool
execution, because raw accepted service-backed calls still hang in local probes.

The app-server-backed path provides:

- one-command doctor/demo/config entrypoints for operator-grade proof artifacts
- all 18 configured upstream tools registered in pi, with four initially active tools and additive on-demand activation
- current per-plugin launchers/working directories/arguments and the app-server `initialized` handshake; inherited MCP servers/plugins and the `apps` feature disabled, with plugin `CODEX_HOME` preserved
- asynchronous MCP startup waits before the extension, CLI, or standard MCP wrapper dispatches
- a guarded standard MCP wrapper for Cursor or other MCP-capable clients
- background-oriented defaults that prefer accessibility actions, keys, values, and
  element scroll over pointer movement, without guaranteeing non-interruption
- explicit pointer click/drag guards; no macuse cursor warp
- reusable validation modes for read-only, mutating, focus, and MCP wrapper flows

## Tool/functionality coverage

| Capability | Codex native Computer Use | pi extension | standard MCP wrapper | Local validation |
| --- | --- | --- | --- | --- |
| App listing | `list_apps` | direct `list_apps` | `list_apps` | `validate-macuse read-only`, `validate-macuse mcp` |
| App state + screenshot | `get_app_state` | direct `get_app_state`; `macuse_sequence` step | `get_app_state` | Activity Monitor get-state; image save/include probes |
| Accessibility press/action | `perform_secondary_action` | direct guarded tool; sequence step | `perform_secondary_action` | direct Activity Monitor CPU/Memory tab actions |
| Keyboard | `press_key` | direct guarded tool; sequence step | `press_key`; mutation guard + fresh state | TextEdit save/select-all |
| Literal typing | `type_text` | native selected-text replacement where supported; guarded upstream ASCII fallback | shared native text path with mutation guard + fresh state | controlled TextEdit Unicode/selection readback; unsupported Unicode fails before mutation |
| Set accessibility value | `set_value` | direct guarded tool; sequence step | `set_value`; mutation guard + fresh state | controlled TextEdit probe; prior Activity Monitor filter/clear probe |
| Text selection | `select_text` | direct guarded tool; sequence step | `select_text` | TextEdit `/tmp/macuse-select-test.txt` |
| Element scrolling | `scroll` | direct guarded tool; sequence step | `scroll` | TextEdit `/tmp/macuse-scroll-test.txt` |
| Pointer click | `click` | direct `allowPointer`; sequence `allowPointerClick` | guarded `allowPointer` | Pointer guard validated; prefer `perform_secondary_action` |
| Pointer drag | `drag` | direct `allowPointer`; sequence `allowPointerDrag` | guarded `allowPointer` | historical low-stakes TextEdit drag returned success; not a general isolation proof |
| App approval behavior | app-server elicitation | pi defaults to `approval: "inherit"` under macuse's standing app-access policy; explicit `deny` remains available for tests | MCP wrapper also defaults to `inherit`; `ask` remains available for client prompts | inherit/default, deny, and conditional elicitation proxy probes |
| Record & Replay | `event-stream` MCP: up to 30-minute start/status/stop | 3 direct `event_stream_*` tools; start guarded | 3 tools; start guarded | inventory, schemas, guards; direct and sequence status routing |
| Computer History | `computer-history` MCP: pause/resume/status/get_settings/update_settings | 5 direct `computer_history_*` tools; recording/privacy guards | 5 tools with equivalent guards | inventory, schemas, guards; status/get_settings allowed |
| Direct raw MCP positive execution | internal/unknown | not used | not used | still times out, even with a live app-server thread ID |

## User-experience coverage

| UX property | Status | Evidence / behavior |
| --- | --- | --- |
| Focus observation | Best effort, not a non-interruption guarantee | Native activation/window events plus endpoints; coverage gaps and input attribution remain unknown |
| Avoids actual mouse movement by default | Implemented | pi guidance prefers secondary actions/keys/set-value/scroll; pointer click/drag require explicit flags |
| No cursor warp | Implemented | macuse never warps the cursor; authorized upstream pointer input can still interrupt the user |
| Before/after state evidence | Implemented | sequence steps can include `get_app_state`; validation uses before/after checks |
| State assertions | Implemented | sequence steps support `expectText`, `expectAbsentText`, and `allowError` |
| Screenshots available to agent | Implemented | `includeImage` and `saveImagePath` in bridge/pi flow; MCP wrapper returns image blocks from app-server |
| Non-Codex MCP client support | Implemented | `tools/codex-computer-use-appserver-mcp.mjs` |
| Durable refresh commands/docs | Implemented | `docs/reference/codex-computer-use-external-harness.md`, local install doc, and `docs/reference/demo-and-doctor.md` |
| Optional local auto-heal | Implemented | `node tools/macuse-repair.mjs` dry-runs; `--apply` wakes/stops screensaver/reaps stale records; explicit flags cover macuse app-server restart, global Computer Use service restart, env-password unlock, and user-TCC AppleEvents repair |
| One-command proof artifact | Implemented | `node tools/macuse-demo.mjs --out .scratch/macuse-demo` writes Markdown, HTML, transcript, and MCP config |
| Sequence action readback | Implemented in Pi | `set_value` always verifies the resolved field; `requireStateChange` requires relevant target/document evidence, not unrelated clock updates |
| Scoped waits | Implemented | Wait helpers separate predicate timeout from transport timeout; `waitForText` supports `visibleOnly`, `title`, and `url` guards |
| Final screenshot selection | Implemented | Sequence `saveImagePath` supports `screenshotStep:"final"` to capture the final visual state |
| Persistent pi app-server session | Implemented | `node tools/validate-macuse.mjs quick` verifies Computer Use, Record & Replay, and Computer History calls share one ready app-server thread |
| Element target normalization | Implemented | pi extension and CLI bridge coerce numeric `element_index` to string; pi extension also accepts `element` aliases, resolves `elementId` from the latest tree, exact-matches `elementDescription`, refreshes before every mutating step, reports duplicate ID/name diagnostics, and returns fallback element-index hints when a target is stale or missing |
| Bounded presentation, full internal state | Implemented in Pi | `get_app_state` defaults to minimal and focus observation enabled; sequences default to compact. Output caps do not truncate targeting/assertion state |
| Partial sequence failures | Implemented in Pi | Error flag plus preserved partial details and dispatch/outcome; resume index only when the failed action was not dispatched. Timeout/abort is not upstream cancellation; no automatic mutation replay |
| Running app filtering | Implemented | direct `list_apps` supports `runningOnly:true` and substring `filter` |

Pi validates whole-sequence arguments before dispatch and blocks document drift at mutation preflight; `expectedTitle`/`expectedUrl` pin the intended window/document. CLI/MCP have comparable startup isolation and native text safety, but not full Pi executor/wait/evidence parity. Native features require installed `xcrun swiftc` (lazy source-hash compilation) and Accessibility access. The native helper uses no keyboard events or clipboard writes and never replays an attempted unverified edit.

All 18 tools in macuse's configured scope are launched through the three current ChatGPT-bundled plugin launchers, which resolve the installed SkyComputerUseClient under `$CODEX_HOME/computer-use`, and are inventory-checked in the persistent app-server thread. Pi initially activates only `list_apps`, `get_app_state`, `macuse_sequence`, and `macuse_tools`; the loader enables exact additional tools additively. The client's separate Messages MCP is intentionally excluded because messaging is outside macuse's app-control scope and sends cross a hard safety boundary. Ordinary app control does not call recording or privacy-mutating tools. `turn-ended` is intentionally absent because it has no published payload contract. The app-server's separate `node_repl` MCP (`js`, `js_add_node_module_dir`, `js_reset`) remains unexposed because unrestricted JavaScript/module access does not fit macuse's guarded surface.

## Known gaps

- Direct raw `SkyComputerUseClient mcp` still hangs for accepted service-backed
  `list_apps` / `get_app_state` calls outside the app-server path.
- Computer Use MCP schemas remain proprietary and may change with Codex updates; keep the refresh/validation commands current.
- Drag has only a low-stakes TextEdit probe. It is guarded because pointer drag
  can move the user's cursor even when focus is preserved.
- High-stakes workflows remain intentionally gated by the safety policy.
- Settings replacement accepts only the complete `observation` object. Preserve unchanged fields from `computer_history_get_settings`; the current upstream schema does not expose a menu-bar-icon setting.
- Browser-specific workflows should still prefer `agent_browser` when possible.

## Validation commands

```bash
node tools/validate-macuse.mjs quick
node tools/validate-macuse.mjs read-only
node tools/validate-macuse.mjs mutating
node tools/validate-macuse.mjs focus
node tools/validate-macuse.mjs mcp
```
