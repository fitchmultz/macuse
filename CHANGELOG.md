# Changelog

## 0.5.0 — Experimental prerelease

- Replace the app-server GUI bridge and JSON sequence language with persistent JavaScript through installed `@oai/cua-repl`, computer-only and Sky-only in the normal vendor sandbox. Primary GUI control has no app-server dependency.
- Share `macuse`, `macuse_insert_text`, and `macuse_reset` across Pi, CLI, and MCP. Pi's fourth default tool, `macuse_tools`, enables only the eight preserved recording/history tools; MCP exposes all eleven tools directly.
- Keep full-snapshot per-action guards, exact app scope, stale-target checks, and exact field verification. Native selected-text insertion preserves unselected content without keyboard/clipboard fallback; raw typing is ASCII-only and paste is disabled.
- Interrupt timed-out/aborted JavaScript with vendor reset and await settlement, preserving partial action evidence. Reset does not undo UI effects or authorize replay.
- Preserve native focus observations and exact-path screenshot artifacts without cursor warping or universal isolation claims. Restore original macuse screenshot bytes for matching retained Astra outputs only when Pi resized them, respecting filtering/compaction and other models.
- Support latest stable official Pi and `fitchmultz/pi` 0.87.0 through shared public APIs. No host patches or current settings edits are required.
- Keep recording/history in a separate lazy app-server with existing authentication, scoped plugin launchers, and explicit recording/privacy gates.
- **Breaking migration:** use `extensions/macuse.ts`, `tools/macuse.mjs`, and `tools/macuse-mcp.mjs`; regenerate MCP config for server `macuse` and `MACUSE_CWD`. Removed GUI tools, `macuse_sequence`, `macuse_restart`, selector aliases, and old entrypoints have no compatibility shims. Restart the full Pi/CLI/MCP process after updating.
- Distribute as an experimental Git-installed Pi package via GitHub prerelease, with `private: true` preventing npm publication. Install with `pi install git:github.com/fitchmultz/macuse@v0.5.0`.

## 0.4.1 - 2026-09-17

- Remove cursor warping; observe application activation and focused-window events without claiming input isolation.
- Guard document identity before mutation and verify edits against the resolved field, with native selected-text insertion for Unicode-capable controls.
- Preserve full internal state regardless of output limits; reject ambiguous and stale targets and keep minimal output bounded.
- Report partial failures as Pi tool errors, distinguish dispatched actions from safe retries, and recognize independently verified last-window closes.
- Make wait cancellation prompt, retain ownership of outstanding app-server calls after timeout, and isolate startup to the three configured Computer Use families.
- Validate complete sequences before dispatch and restore the original Activity Monitor tab in live checks.
- Match the current upstream Computer History schema by removing its unsupported menu-bar-icon argument.
- Recognize browser display URLs and native search-field values, including empty fields; report native dependency failures accurately and omit unrelated window details from focus observations.

## 0.4.0 - 2026-08-17

- Follow ChatGPT's three current plugin launcher manifests, app-server `initialized` handshake, and asynchronous MCP startup behavior.
- Route mixed Computer Use, Record & Replay, and Computer History sequences to the correct server.
- Require mutation authorization, safety notes, and immediate fresh app state across the pi extension, CLI bridge, and standard MCP wrapper; keep pointer, recording, and privacy gates fail-closed.
- Refresh doctor version/manifest diagnostics, live compatibility checks, current feature/safety guidance, and exclusion rationale for Messages and unrestricted `node_repl`.
- Verify all 18 live schemas against ChatGPT `26.810.52044`, Codex CLI `0.148.0-alpha.9`, plugins `1.0.1000717`, and Computer Use client `26.727.1000550`.

## 0.3.0 - 2026-08-06

- Add lazy activation for mutating, recording, history, and recovery tools, with activation reset across startup, reload, resume, fork, and new-session boundaries.
- Harden the persistent app-server session, strict upstream argument filtering, stable target resolution, and fail-closed safety guards across all 18 Computer Use, Record & Replay, and Computer History tools.
- Require Pi 0.84.0 or later and align extension dependencies with the released 0.84 API and TypeBox package boundary.
- Verify the package manifest, lazy tool activation, session lifecycle, all 18 live tool schemas, and read-only, mutating, focus, and MCP flows against Pi 0.84.0 and ChatGPT `26.730.61639`.

## 0.2.0 - 2026-08-03

- Mark the Computer Use integration experimental and unsupported.
