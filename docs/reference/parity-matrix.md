# Computer Use parity matrix

Source: Local `macuse` probes against Codex app-server, the packaged pi extension, and the app-server-backed MCP wrapper.
Created: May 22, 2026
Status: Current working parity tracker; refresh after Codex or Computer Use updates.

## Summary

The non-Codex path now uses Codex app-server as the required compatibility layer.
It does not rely on direct raw `SkyComputerUseClient mcp` for positive tool
execution, because raw accepted service-backed calls still hang in local probes.

The app-server-backed path provides:

- one-command doctor/demo/config entrypoints for operator-grade proof artifacts
- all 18 live upstream tools registered directly in pi, plus persistent-session sequence/restart helpers
- a standard MCP wrapper for Cursor or other MCP-capable clients
- focus-preserving defaults that prefer accessibility actions, keys, values, and
  element scroll over pointer movement
- pointer click/drag guards plus mouse-position restoration when pointer actions
  are explicitly allowed
- reusable validation modes for read-only, mutating, focus, and MCP wrapper flows

## Tool/functionality coverage

| Capability | Codex native Computer Use | pi extension | standard MCP wrapper | Local validation |
| --- | --- | --- | --- | --- |
| App listing | `list_apps` | direct `list_apps` | `list_apps` | `validate-macuse read-only`, `validate-macuse mcp` |
| App state + screenshot | `get_app_state` | direct `get_app_state`; `macuse_sequence` step | `get_app_state` | Activity Monitor get-state; image save/include probes |
| Accessibility press/action | `perform_secondary_action` | direct guarded tool; sequence step | `perform_secondary_action` | direct Activity Monitor CPU/Memory tab actions |
| Keyboard | `press_key` | direct guarded tool; sequence step | `press_key` | TextEdit save/select-all |
| Literal typing | `type_text` | direct guarded tool; sequence step | `type_text` | TextEdit `/tmp/macuse-type-test.txt` |
| Set accessibility value | `set_value` | direct guarded tool; sequence step | `set_value` | direct Activity Monitor filter/clear plus TextEdit probe |
| Text selection | `select_text` | direct guarded tool; sequence step | `select_text` | TextEdit `/tmp/macuse-select-test.txt` |
| Element scrolling | `scroll` | direct guarded tool; sequence step | `scroll` | TextEdit `/tmp/macuse-scroll-test.txt` |
| Pointer click | `click` | direct `allowPointer`; sequence `allowPointerClick` | guarded `allowPointer` | Pointer guard validated; prefer `perform_secondary_action` |
| Pointer drag | `drag` | direct `allowPointer`; sequence `allowPointerDrag` | guarded `allowPointer` | TextEdit drag returned success; mouse restore validated |
| App approval behavior | Codex Any App setting | pi defaults to `approval: "inherit"`, auto-accepting app approvals; explicit `deny` remains available for tests | MCP wrapper also defaults to `inherit`; `ask` remains available for clients that want elicitation prompts | inherit/default, deny, and MCP elicitation proxy probes |
| Record & Replay | `event-stream` MCP: start/status/stop | 3 direct `event_stream_*` tools; start guarded | 3 tools; start guarded | inventory, schemas, guards; status allowed |
| Computer History | `computer-history` MCP: pause/resume/status/get_settings/update_settings | 5 direct `computer_history_*` tools; recording/privacy guards | 5 tools with equivalent guards | inventory, schemas, guards; status/get_settings allowed |
| Direct raw MCP positive execution | internal/unknown | not used | not used | still times out, even with a live app-server thread ID |

## User-experience coverage

| UX property | Status | Evidence / behavior |
| --- | --- | --- |
| Preserves native frontmost app | Passing for Activity Monitor focus probe | `node tools/validate-macuse.mjs focus` |
| Avoids actual mouse movement by default | Implemented | pi guidance prefers secondary actions/keys/set-value/scroll; pointer click/drag require explicit flags |
| Restores mouse after pointer actions | Implemented | pi extension restores pointer click/drag sequences; CLI bridge has `--preserve-mouse`; MCP wrapper restores pointer click/drag |
| Before/after state evidence | Implemented | sequence steps can include `get_app_state`; validation uses before/after checks |
| State assertions | Implemented | sequence steps support `expectText`, `expectAbsentText`, and `allowError` |
| Screenshots available to agent | Implemented | `includeImage` and `saveImagePath` in bridge/pi flow; MCP wrapper returns image blocks from app-server |
| Non-Codex MCP client support | Implemented | `tools/codex-computer-use-appserver-mcp.mjs` |
| Durable refresh commands/docs | Implemented | `docs/reference/codex-computer-use-external-harness.md`, local install doc, and `docs/reference/demo-and-doctor.md` |
| Optional local auto-heal | Implemented | `node tools/macuse-repair.mjs` dry-runs; `--apply` wakes/stops screensaver/reaps stale records; explicit flags cover macuse app-server restart, global Computer Use service restart, env-password unlock, and user-TCC AppleEvents repair |
| One-command proof artifact | Implemented | `node tools/macuse-demo.mjs --out .scratch/macuse-demo` writes Markdown, HTML, screenshots, transcript, and MCP config |
| Sequence action readback | Implemented | Pi sequence steps read state after actions only when evidence is requested, warn with `actionDispatchedButNoStateChange` on no observable effect, and support per-step `requireStateChange` |
| Scoped waits | Implemented | Wait helpers separate predicate timeout from transport timeout; `waitForText` supports `visibleOnly`, `title`, and `url` guards |
| Final screenshot selection | Implemented | Sequence `saveImagePath` supports `screenshotStep:"final"` to capture the final visual state |
| Persistent pi app-server session | Implemented | `node tools/validate-macuse.mjs quick` verifies two pi extension calls reuse one app-server thread and default approval inheritance auto-accepts Finder |
| Element target normalization | Implemented | pi extension and CLI bridge coerce numeric `element_index` to string; pi extension also accepts `element` aliases, resolves `elementId` from the latest tree, exact-matches `elementDescription`, refreshes before element-targeted steps, reports duplicate ID/name diagnostics, and returns fallback element-index hints when a target is stale or missing |
| Compact sequence output | Implemented | `macuse_sequence` defaults to `detail: "compact"`; full raw trees remain available with `detail: "full"`; TextEdit ruler marker noise is filtered |
| Partial sequence failures | Implemented | failed `macuse_sequence` calls return completed step rows plus the failed-step diagnostic and resume hint; per-step `allowError:true` continues through resolution/tool errors |
| Running app filtering | Implemented | direct `list_apps` supports `runningOnly:true` and substring `filter` |

All 18 verified public tools are configured from the installed SkyComputerUseClient under `$CODEX_HOME/computer-use` and inventory-checked in the persistent app-server thread. Ordinary app control does not call recording or privacy-mutating tools. `turn-ended` is intentionally absent because it has no published payload contract; the private `@oai/sky` Node REPL adapter is not MCP and remains unexposed.

## Known gaps

- Direct raw `SkyComputerUseClient mcp` still hangs for accepted service-backed
  `list_apps` / `get_app_state` calls outside the app-server path.
- The app-server protocol is internal and may change with Codex updates; keep the
  refresh/validation commands current.
- Drag has only a low-stakes TextEdit probe. It is guarded because pointer drag
  can move the user's cursor even when focus is preserved.
- High-stakes workflows remain intentionally gated by the safety policy.
- Browser-specific workflows should still prefer `agent_browser` when possible.

## Validation commands

```bash
node tools/validate-macuse.mjs quick
node tools/validate-macuse.mjs read-only
node tools/validate-macuse.mjs mutating
node tools/validate-macuse.mjs focus
node tools/validate-macuse.mjs mcp
```
