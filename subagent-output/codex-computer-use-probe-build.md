# Codex Computer Use MCP Probe Harness Build

## Status
Completed.

## Files changed
- `tools/probe-codex-computer-use-mcp.mjs` - new standalone Node ESM CLI probe harness.
- `docs/reference/codex-computer-use-external-harness.md` - updated to point at the committed harness and added exact rerun/update commands.
- `subagent-output/codex-computer-use-probe-build.md` - this report.

## What was implemented
- Standalone, executable Node ESM CLI with no external npm dependencies and no new `package.json`.
- Modes:
  - `discover`
  - `deny --app <app>`
  - `state --app <app> --approval interactive|accept-once|deny`
  - `logs --since <duration>`
- Bidirectional stdio JSON-RPC client for `SkyComputerUseClient mcp`.
- Pending request tracking while tool calls are active.
- Server-to-client request handling:
  - `elicitation/create` with `accept`, `decline`, and `cancel` support.
  - `ping` and `roots/list` safe responses.
  - unknown methods receive JSON-RPC method-not-found responses.
- Structured readable event logs for client/server requests, responses, notifications, unknown requests, timeouts, elicitation decisions, stderr, and child exit.
- Timeouts and CLI tuning flags for startup, list, tool call, elicitation prompt, shutdown, and macOS log collection.
- Timeout/failure diagnostics with exact next commands.
- Tool result logging is summarized rather than dumping app state text/screenshots.

## Validation run
- `node --check tools/probe-codex-computer-use-mcp.mjs` - passed.
- `node tools/probe-codex-computer-use-mcp.mjs --help` - passed.
- `node tools/probe-codex-computer-use-mcp.mjs discover` - passed; initialized MCP server and listed 10 tools.
- `node tools/probe-codex-computer-use-mcp.mjs deny --app Finder` - passed; received one `elicitation/create`, sent `{ "action": "decline" }`, and received a normal MCP tool error response.
- `node tools/probe-codex-computer-use-mcp.mjs state --app Finder --approval deny` - passed; state mode exercised the same explicit deny approval path.
- `node tools/probe-codex-computer-use-mcp.mjs logs --since 30s --max-log-lines 20` - passed; printed filtered SkyComputerUse logs with truncation notice.
- `node tools/probe-codex-computer-use-mcp.mjs discover --startup-timeout-ms 1` - passed as a negative check; exited 4 and printed next diagnostic commands.

## Caveats
- I did not run `state --approval accept-once` because validation was requested to avoid auto-accepting app use unless truly needed.
- Full accepted `get_app_state` completion outside Codex remains unproven; this build validates discovery, bidirectional request handling, denial elicitation, logs, and timeout behavior only.
- The repo currently has no tracked files, so these files remain untracked in git until added by the parent/user.
