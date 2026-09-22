# Native runtime and migration

## Current architecture: v0.5.0

macuse uses the installed vendor `@oai/cua-repl` for persistent JavaScript app control. Pi, CLI, and MCP route through `MacuseSession` and share guards, native selected-text insertion, focus observations, and action evidence.

```text
Pi extension / CLI / MCP
          |
     MacuseSession
          |
          +-- installed @oai/cua-repl (computer-only, normal sandbox)
          |       +-- trusted macuse guard service --> native Sky service
          |
          +-- native AX helper (focus observations and selected-text insertion)
          |
          +-- lazy auxiliary app-server --> event-stream / computer-history
```

The primary GUI path has no app-server dependency. The vendor supplies JavaScript execution, computer API documentation, app binding, screenshots, and input primitives. macuse configures only the computer surface and trusted Sky service, validates native calls, and keeps the normal sandbox. It adds no separate evaluator, module-loader tool, Messages tools, or QuickJS replacement, and enables no browser/audio service. JavaScript remains governed by the vendor sandbox.

The auxiliary app-server starts only for Record & Replay or Computer History. It disables inherited unrelated MCP servers/plugins and the `apps` feature, mirrors the two installed plugin launchers, preserves `CODEX_HOME` and existing authentication, and waits for their tool inventories. It supplies no authentication bypass.

## Public interface

| Surface | Tools |
| --- | --- |
| Pi defaults | `macuse`, `macuse_insert_text`, `macuse_reset`, `macuse_tools` |
| Pi lazy tools | Three `event_stream_*` tools and five `computer_history_*` tools |
| Standard MCP | Eleven tools: code, insert, reset, and eight auxiliary tools; no activation loader |
| CLI | The same eleven tools through `call` or persistent JSONL `session` |

Bootstrap with `await cua.getState()` or `var app = await cua.getApp("Exact App")`. Documentation and initial state are emitted automatically. Bindings persist until reset or a session boundary. `app.getAXState()`, `app.getScreenshot()`, and `app.getAXStateAndScreenshot()` also auto-emit. Use normal JavaScript conditions, bounded loops, assertions, and `try/finally` instead of a separate workflow language; await every action and keep programs short enough to adapt to observed UI state.

The guard requests full snapshots, validates current document/target identity before every action, and internally rebinds observed native indexes. It does not invent selectors or interpret diff text as a complete state. Full-field `setValue` requires exact target readback. Parent-native selected-text insertion preserves unselected text with no keyboard/clipboard fallback. See the [safety policy](codex-computer-use-safety-policy.md).

Timeout/abort interrupts JavaScript through `js_reset` and awaits settlement. A GUI effect may already have occurred; reset is never an undo or replay permission. Partial action evidence survives tool errors. Stopping/resetting drains owned work without killing global Computer Use helpers.

## Output and screenshots

App observation methods emit text/images directly. Presentation caps apply only after full state has reached the guard; use JavaScript to return task-relevant summaries rather than duplicating entire trees. The tool retains full clipped output in its details.

`saveImagePath` on `macuse` saves the first emitted screenshot to that exact path, resolving relative paths against the session working directory and expanding `~`. It never overwrites an existing file. The result reports `savedImage` evidence: path, byte count, SHA-256, actual MIME type, and available dimensions. Call a single screenshot observation when the intended saved frame matters.

Screenshot coordinates refer to the native returned image, with no assumed Retina/OS-point conversion. For GPT-6-Astra, `auto` already means original resolution. The Pi `before_provider_request` hook restores original macuse image bytes only when Pi resized a matching retained tool output. It respects filtering/compaction and does not change other models or unrelated images. Both official Pi and `fitchmultz/pi` use shared public APIs; no host patches or current settings edits are required.

## Source map

| Responsibility | Path |
| --- | --- |
| Pi tools/lifecycle | `extensions/macuse.ts` |
| Public tool schemas | `lib/tools.mjs` |
| Shared session/serialization | `lib/macuse-session.mjs` |
| Vendor launch/execution/reset | `lib/cua-runtime.mjs` |
| Trusted Sky dispatch guard | `lib/cua-guard-service.mjs` |
| Full AX state parsing/identity | `lib/app-state.mjs` |
| Selected-text insertion | `lib/native-input.mjs` |
| Native focus/AX helper | `tools/macos-native.mjs`, `tools/macos-native.swift` |
| Recording/history transport | `lib/auxiliary-runtime.mjs` |
| Astra screenshot hook | `lib/pi-images.mjs` |
| CLI/MCP/config | `tools/macuse.mjs`, `tools/macuse-mcp.mjs`, `tools/macuse-config.mjs` |

`/macuse-status` reports owned-runtime status without starting services. `/macuse-stop` stops only the session's processes; the next call can start a fresh session. `/macuse-reset` clears JavaScript bindings/observations without undoing application state.

## Breaking migration from 0.4.x

- Replace the old individual GUI tools and `macuse_sequence` JSON workflow with `macuse` JavaScript against the emitted native API. Old selector aliases, wait/assertion pseudo-tools, and sequence arguments are removed.
- Use `macuse_insert_text` for selected-range Unicode insertion. Raw `typeText` is ASCII-only; paste is disabled. Do not substitute whole-field `setValue` for an insertion request.
- Replace `macuse_restart` with `macuse_reset` when bindings/observations need clearing. Reset does not restart global services.
- Replace the old extension/module tree with `extensions/macuse.ts` and `lib/`. Replace the old GUI CLI/MCP bridges with `tools/macuse.mjs` and `tools/macuse-mcp.mjs`. There are no backwards-compatible aliases.
- Regenerate MCP configuration: server `macuse`, environment variable `MACUSE_CWD`. See [MCP setup](cursor-mcp-setup.md).
- Restart the full Pi/CLI/MCP process after updating. Activation resets at session boundaries; Pi's loader now enables only auxiliary recording/history tools.

## Historical findings

These facts describe earlier app-server/MCP investigations, not v0.5.0 certification:

- **May–August 2026, macuse 0.2–0.4:** raw `SkyComputerUseClient mcp` discovery worked, while accepted app reads could hang from external hosts. App-server-mediated reads and controlled Activity Monitor/TextEdit actions succeeded in those probes. Those results do not establish present runtime behavior or universal focus isolation.
- **June 12 and June 26, 2026:** AppleEvents/TCC evaluated the responsible launcher, including terminal/SSH/embedded hosts, separately from the OpenAI helper. Errors included `-609` (`connectionInvalid`), `-1712` (`errAETimeout`), and `-1743`. A grant for one host did not cover another. Historical direct TCC database repair is not recommended setup guidance; use supported permission prompts/settings and explicit user involvement.
- **August 17, 2026:** the recorded installation was ChatGPT `26.810.52044`, Codex CLI `0.148.0-alpha.9`, plugins `1.0.1000717`, and Computer Use client `26.727.1000550`. These are dated observations, not current minimum versions.

`tools/probe-codex-computer-use-mcp.mjs` remains a non-mutating discovery/denial diagnostic. Its raw protocol behavior is not the primary GUI path and must not be used as proof of current native-runtime health or non-interruption. Use [doctor and validation](demo-and-doctor.md) for current evidence after vendor updates.
