# macuse

Native macOS Computer Use for Pi and MCP clients, with persistent JavaScript, guarded app actions, and selected-text insertion.

> [!WARNING]
> **Experimental, unsupported integration.** macuse reuses the proprietary Computer Use runtime installed with ChatGPT. OpenAI can change its private interfaces without notice. Review the [safety policy](docs/reference/codex-computer-use-safety-policy.md) before granting macOS permissions or operating apps.

## Install in Pi

The v0.5.0 distribution is an experimental GitHub prerelease, installed in Pi from Git rather than npm. The package is marked `private: true` to prevent npm publication.

```bash
pi install git:github.com/fitchmultz/macuse@v0.5.0
```

Quit Pi and start a **new process** after installation or updates; `/reload` does not replace loaded extension code. Restart CLI/MCP processes after updates too.

macuse targets both the latest stable official Pi and `fitchmultz/pi` 0.87.0 through shared public extension APIs. It needs macOS, the installed ChatGPT Computer Use runtime, and its existing authentication and permissions. Native focus observations and selected-text insertion also need Accessibility access and an installed Swift compiler (`xcrun swiftc`). Nothing installs a compiler or grants privacy permissions automatically. See [local setup](docs/reference/codex-computer-use-local-install.md).

## Start with an observation

Call `macuse` to discover apps and read the runtime's emitted documentation:

```json
{ "code": "await cua.getState()" }
```

Or bind a known app and receive its first state:

```json
{ "code": "var app = await cua.getApp(\"Activity Monitor\")", "apps": ["Activity Monitor"] }
```

Bindings persist in that session. The next call can use them:

```json
{ "code": "await app.getAXStateAndScreenshot()", "apps": ["Activity Monitor"] }
```

`getAXState()`, `getScreenshot()`, and `getAXStateAndScreenshot()` emit their results automatically. Do not print or emit them again. Use short adaptive programs, await every action, and inspect the resulting state before deciding the next action. Prefer purpose-built APIs and `agent_browser` for ordinary web-page work.

## Tools

| Tool | Purpose |
| --- | --- |
| `macuse` | Run code against the installed `cua` computer API in a persistent sandboxed session. |
| `macuse_insert_text` | Replace only the current selection in an already-focused field through native Accessibility, preserving unselected text. |
| `macuse_reset` | Clear JavaScript bindings and app observations; it does not undo GUI actions. |
| `macuse_tools` | Pi-only activation of the eight recording/history tools below. It starts no recording. |

These four tools start active in Pi. Eight auxiliary tools are registered but inactive until requested through `macuse_tools`: `event_stream_start`, `event_stream_status`, `event_stream_stop`, `computer_history_pause`, `computer_history_resume`, `computer_history_status`, `computer_history_get_settings`, and `computer_history_update_settings`. Activation resets at session boundaries. The MCP server exposes eleven tools: the three primary tools plus all eight auxiliary tools.

For example, in Pi enable a status read, then call `event_stream_status` with `{}`:

```json
{ "tools": ["event_stream_status"] }
```

Record & Replay start and Computer History resume require exact user intent, `allowRecording:true`, and a non-empty `safetyNote`. Settings changes require exact approval, `allowPrivacyChange:true`, a safety note, and the complete `observation` copied from a fresh settings read with every unchanged field preserved. Stop/pause need no allow flag. Status/settings reads can reveal activity, artifact, and privacy metadata.

## Act within the approved task

`macuse` accepts `code`, optional `apps`, `allowMutating`, `safetyNote`, `timeoutMs`, `trackFocus`, and `saveImagePath`. A mutation requires an exact `apps` scope matching the identifiers used in code, `allowMutating:true`, a concrete safety note, and a prior same-app observation. A safety note names the target, intended effect, and stop boundary; mutation notes must be nonempty. Flags record authorization; they do not create user permission.

For an approved dismissal of Activity Monitor's current transient UI, after inspecting it:

```json
{
  "code": "await app.pressKey(\"Escape\"); await app.getAXState()",
  "apps": ["Activity Monitor"],
  "allowMutating": true,
  "safetyNote": "Activity Monitor only: dismiss the inspected transient UI; do not stop or modify processes."
}
```

Use native element indexes from the latest observation and the methods documented by the runtime. The guard refreshes full app state before each action, checks the document and target, and rebinds indexes internally. It tracks only app identities resolved by the native service, so a binding's native app path still matches the original exact `apps` identifier. It does not add fuzzy aliases or a selector API. Prefer accessibility `Press`, listed secondary actions, intended full-field `setValue`, keys, and element-targeted scroll. Primary `Press` may be omitted from Sky's secondary-action list; that omission alone does not require pointer fallback. Pointer clicks/drags and coordinate scrolling use the same scoped mutation authorization; coordinates use the returned screenshot's pixel space, without an inferred Retina or OS-point conversion.

For Unicode insertion, observe the intended app and already-focused field, then call `macuse_insert_text`:

```json
{
  "app": "TextEdit",
  "text": "Hello — café",
  "allowMutating": true,
  "safetyNote": "TextEdit only: insert this text at the observed selection in the approved draft; do not save or send."
}
```

Optional `expectedTitle` and `expectedUrl` pin the native insertion target. When Sky omits a focused-field marker, macuse joins fresh native AX evidence only to a unique stable field ID in the same observed document. Missing or ambiguous identity blocks insertion. Insertion uses guarded `AXSelectedText` replacement and exact readback, with no keyboard input, clipboard writes, or fallback replay. Observe again afterward. `app.setValue(index, value)` replaces an entire field and verifies that field exactly; it is not selected-range insertion. Raw `app.typeText` is ASCII-only. Native `await app.paste("Hello — café")` supports Unicode and restores the previous clipboard. Pass `{format:"md"}` or `{format:"html"}` as the second argument for Markdown or HTML; the default is `text`. Paste shortcuts are also supported. Observe afterward to verify the result; native paste does not provide the exact selected-text readback of `macuse_insert_text`.

Text input and keyboard chords check the observed focused field. Standard Command shortcuts for Save, Close, New, Open, Print, Quit, Hide, and Minimize (including Shift/Option variants) do not require that field's text to remain unchanged; document checks still apply. Formatting, link, and submission chords retain focused-field checks.

Never automatically replay a dispatched or unknown-outcome mutation. Timeout/abort interrupts JavaScript through the vendor's reset operation and waits for settlement; it does not undo or prove cancellation of a GUI action. Inspect partial `dispatched`/`outcome` evidence and fresh app state before continuing. Programs are not transactions, and a reset can prevent JavaScript cleanup from running.

Focus tracking defaults on. Native activation/window observations report their coverage honestly; they do not attribute input or guarantee uninterrupted keyboard/mouse use. macuse never warps the user's cursor. On GPT-6-Astra, a scoped Pi hook restores original macuse screenshot bytes only when Pi resized a matching retained tool output. Astra's `auto` already means original; other models, filtered outputs, and compacted-away outputs are left alone. No host patch or settings change is needed.

To save a screenshot from the bound app:

```json
{
  "code": "await app.getScreenshot()",
  "apps": ["Activity Monitor"],
  "saveImagePath": ".scratch/activity-monitor.jpg"
}
```

macuse saves the first emitted image at the exact requested path, resolves relative paths against the session working directory, expands `~`, and refuses to overwrite a file. Check the returned `savedImage` path, bytes, SHA-256, actual MIME type, and available dimensions before claiming an artifact was saved. Text output is capped after full guard state is collected; clipped output remains available in tool details.

## CLI and MCP

```bash
node tools/macuse.mjs tools --pretty
node tools/macuse.mjs call macuse '{"code":"await cua.getState()"}'
node tools/macuse.mjs call macuse '{}' --file script.js
node tools/macuse.mjs session
```

`session` reads one JSON object per line, such as `{"tool":"macuse","input":{"code":"await cua.getState()"}}`. Bindings and observations persist within that process; separate `call` invocations start separate sessions.

Generate configuration for Cursor or another MCP client:

```bash
node tools/macuse-config.mjs cursor --pretty
```

The server is `macuse`, its entrypoint is `tools/macuse-mcp.mjs`, and its working-directory variable is `MACUSE_CWD`. See [MCP setup](docs/reference/cursor-mcp-setup.md).

## Runtime and checks

The primary GUI path uses the installed `@oai/cua-repl`, computer-only and Sky-only, through a configured trusted guard service in the normal vendor sandbox. It has no Codex app-server dependency. A separate lazy app-server hosts only Record & Replay and Computer History, preserving existing authentication and `CODEX_HOME`. macuse adds no separate evaluator or module-loader tool, and enables no browser/audio or Messages service. JavaScript runs inside the vendor runtime's sandbox.

```bash
# Offline extension checks; no live desktop access.
node tools/validate-macuse.mjs extension

# Live checks; review the scope before running.
node tools/macuse-doctor.mjs --out .scratch/doctor
node tools/validate-macuse.mjs read-only
```

Doctor is read-only unless `--full` is explicitly requested. The demo and mutating/focus checks use controlled Activity Monitor tab changes and restore the observed original tab in `finally`. A validation command is not a claim that this host passed it. See [validation and diagnostics](docs/reference/demo-and-doctor.md) for all modes and [the documentation index](docs/README.md) for architecture and migration details.
