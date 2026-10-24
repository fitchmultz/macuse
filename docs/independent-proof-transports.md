# Opt-in independent fixture transports

These research entrypoints exercise the independent proof session through Pi,
CLI, and MCP. They are not the production macuse backend, a fallback, general-app
support, or full ChatGPT independence. Installing macuse does not load the proof
extension or change the existing CLI/MCP servers.

All entrypoints share two tools:

- `macuse_independent_proof`: execute persistent sandboxed JavaScript. Input has
  required `code` and optional `apps`, `allowMutating`, `safetyNote`, `timeoutMs`
  (50–30,000 ms). Native calls require the exact operator-pinned app scope.
- `macuse_independent_proof_reset`: input `{}`. Stop owned workers and clear
  bindings/observations without undoing effects or erasing prior unknown evidence.

The guest has only `macuse.call('observe'|'screenshot'|'act', params)`. Parent-side
native receipts remain distinct from successful RPC delivery. Screenshots travel
as bounded parent-owned image blocks; guest code receives handles/metadata, not
image bytes or file authority. The session's documented safety and qualification
limits still apply. Flags are not user permission; never replay dispatched or
unknown-outcome calls.

Code runs as JavaScriptCore scripts or expressions. Promise expressions, including
an async function expression, are supported. **Top-level `await` and the vendor
`cua` API are not implemented.** `macuse.call` is synchronous inside the guest
even when its parent-side native operation is asynchronous.

## Trusted target

The operator supplies `MACUSE_INDEPENDENT_PROOF_TARGET` as JSON containing
`bundleId`, `pid`, `path`, and optional `windowTitle`, captured from the owned
fixture launcher. It is not a tool parameter and guest code cannot select or
replace it. Without a pinned target, only pure JavaScript is available; native
reads as well as mutations are refused. Use the owned-fixture qualification
runner for live checks rather than substituting a user app or document.

## CLI

```bash
node tools/independent-proof-cli.mjs tools
node tools/independent-proof-cli.mjs call macuse_independent_proof '{"code":"var retained=41; retained"}'
node tools/independent-proof-cli.mjs session
```

Session input is one LF-delimited `{ "tool": "macuse_independent_proof",
"input": { "code": "++retained" } }` object per line. Each response is the
session's `{content,isError,details}` result. Bindings live only in that process.
JSONL framing preserves embedded Unicode separators and rejects input lines over
128 KiB. `--pretty` is available for single calls, not JSONL sessions. Ctrl-C
aborts owned work and attempts settled shutdown; it cannot prove GUI cancellation.

## MCP

Run `node tools/independent-proof-mcp.mjs` as a separate stdio server, passing the
trusted target through its launcher environment for live fixture checks. It
exposes only the two proof tools, not recording/history or production aliases.
It preserves `isError`, content/image blocks, and session details in `_meta`.
No global MCP configuration is installed or changed by these sources.

## Pi

Load only the explicit proof extension when qualifying it:

```bash
pi -ne -e ./extensions/independent-proof.ts
```

The package manifest still loads only `extensions/macuse.ts` normally. The proof
extension lazily creates its session on a tool call; factory loading starts no
workers or services. Session startup, tree navigation, and shutdown stop the
owned workers and discard bindings. An unsettled shutdown retains the blocked
instance rather than silently allowing a new one. A tool-result hook preserves
partial failures as errors on both supported Pi hosts.

For credential-free automated qualification through an exact host:

```bash
node tools/independent-proof-pi-worker.mjs /absolute/path/to/pi-coding-agent
```

This worker accepts the same JSONL requests as CLI session mode. It copies the
unchanged extension/session sources into a disposable consumer, binds the
selected host's actual public SDK, scripts only model-generated tool calls,
and returns actual correlated Pi tool results. It does **not** replace the tool,
executor, native actuator, screenshots, or native receipts with mocks. Unexpected
global fetch requests are rejected and model/auth stores are in memory. Only the isolated
qualification profile disables image resizing to permit exact parent-image hash
checks; the user's settings are unchanged. Normal Pi hosts may transform images.

Use a new worker process for each official/fork qualification. Close stdin to
stop its session and dispose the scratch consumer. Native UI qualification still
requires authorized fixture setup and cleanup; scripted provider calls alone do
not demonstrate native behavior. Passing these transport slices does not qualify
focus, selected-range insertion, arbitrary apps, system-engine pinning, or
recording/history independence.
