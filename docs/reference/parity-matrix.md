# Computer Use parity matrix

Source: Local `macuse` probes against Codex app-server, the project-local pi extension, and the app-server-backed MCP wrapper.
Created: May 22, 2026
Status: Current working parity tracker; refresh after Codex or Computer Use updates.

## Summary

The non-Codex path now uses Codex app-server as the required compatibility layer.
It does not rely on direct raw `SkyComputerUseClient mcp` for positive tool
execution, because raw accepted service-backed calls still hang in local probes.

The app-server-backed path provides:

- pi extension tools for read-only state/listing and guarded sequences
- a standard MCP wrapper for Cursor or other MCP-capable clients
- focus-preserving defaults that prefer accessibility actions, keys, values, and
  element scroll over pointer movement
- pointer click/drag guards plus mouse-position restoration when pointer actions
  are explicitly allowed
- reusable validation modes for read-only, mutating, focus, and MCP wrapper flows

## Tool/functionality coverage

| Capability | Codex native Computer Use | pi extension | standard MCP wrapper | Local validation |
| --- | --- | --- | --- | --- |
| App listing | `list_apps` | `codex_cu_list_apps` | `list_apps` | `validate-macuse read-only`, `validate-macuse mcp` |
| App state + screenshot | `get_app_state` | `codex_cu_get_app_state`, sequence step | `get_app_state` | Calculator get-state; image save/include probes |
| Accessibility press/action | `perform_secondary_action` | `codex_cu_sequence` | `perform_secondary_action` | Calculator `Press` on digit/all-clear |
| Keyboard | `press_key` | `codex_cu_sequence` | `press_key` | Calculator key `2`; TextEdit save/select-all |
| Literal typing | `type_text` | `codex_cu_sequence` | `type_text` | TextEdit `/tmp/macuse-type-test.txt` |
| Set accessibility value | `set_value` | `codex_cu_sequence` | `set_value` | TextEdit `/tmp/macuse-set-value-test.txt` |
| Text selection | `select_text` | `codex_cu_sequence` | `select_text` | TextEdit `/tmp/macuse-select-test.txt` |
| Element scrolling | `scroll` | `codex_cu_sequence` | `scroll` | TextEdit `/tmp/macuse-scroll-test.txt` |
| Pointer click | `click` | guarded sequence only; `allowPointerClick` required | guarded; `allowPointer` required | Pointer guard validated; prefer `perform_secondary_action` |
| Pointer drag | `drag` | guarded sequence only; `allowPointerDrag` required | guarded; `allowPointer` required | TextEdit drag returned success; mouse restore validated |
| App approval prompt | Codex UI | pi UI confirmation or explicit approval arg | MCP `elicitation/create` proxy when supported, explicit `approval` arg otherwise | accept-once, deny, and MCP elicitation proxy probes |
| Direct raw MCP positive execution | internal/unknown | not used | not used | still times out, even with a live app-server thread ID |

## User-experience coverage

| UX property | Status | Evidence / behavior |
| --- | --- | --- |
| Does not leave target app frontmost | Passing for Calculator focus probe | `node tools/validate-macuse.mjs focus` |
| Avoids actual mouse movement by default | Implemented | pi guidance prefers secondary actions/keys/set-value/scroll; pointer click/drag require explicit flags |
| Restores mouse after pointer actions | Implemented | bridge `--preserve-mouse`; MCP wrapper restores after pointer click/drag |
| Before/after state evidence | Implemented | sequence steps can include `get_app_state`; validation uses before/after checks |
| State assertions | Implemented | sequence steps support `expectText`, `expectAbsentText`, and `allowError` |
| Screenshots available to agent | Implemented | `includeImage` and `saveImagePath` in bridge/pi flow; MCP wrapper returns image blocks from app-server |
| Non-Codex MCP client support | Implemented | `tools/codex-computer-use-appserver-mcp.mjs` |
| Durable refresh commands/docs | Implemented | `docs/reference/codex-computer-use-external-harness.md` and local install doc |

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
