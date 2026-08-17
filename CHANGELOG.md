# Changelog

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
