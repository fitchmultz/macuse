# Codex Computer Use safety policy for non-Codex harnesses

Source: Local policy for this `macuse` investigation, based on the installed Codex Computer Use skill, OpenAI's Computer Use docs snapshot, and local bridge behavior.
Author: Local investigation notes
Created: May 22, 2026
Installed-version baseline: August 17, 2026, ChatGPT 26.810.52044 / plugin 1.0.1000717; guardrails follow current macuse source
Status: Active guardrails for the packaged pi extension, CLI bridge, and standard MCP wrapper; all 18 configured upstream tools are guarded

## Current allowed scope

Allowed today:

- `list_apps`
- `get_app_state`
- app-approval denial probes
- app-server status/discovery probes for all 18 public tools
- read-only `event_stream_status`, `computer_history_status`, and `computer_history_get_settings` (these expose activity/artifact/privacy metadata)
- guarded Record & Replay stop and Computer History pause operations
- Record & Replay start only when the user requested up to 30 minutes of click, typed-text, and interacted-window recording, with explicit `allowRecording: true` and a non-empty safety note; an already-active session is returned rather than restarted
- Computer History resume only when the user requested local activity history, with explicit `allowRecording: true` and a non-empty safety note
- `computer_history_update_settings` only with fresh exact user approval, explicit `allowPrivacyChange: true`, a non-empty safety note, and the complete `observation`, copied from an immediately preceding `computer_history_get_settings` result with only the approved fields changed
- direct `perform_secondary_action`, `press_key`, `type_text`, `set_value`, `select_text`, `scroll`, `click`, and `drag` only with explicit `allowMutating: true`, a concrete `safetyNote`, and an immediate pre-dispatch `get_app_state`; direct pointer tools also require `allowPointer: true`
- `macuse_sequence` with the same mutation guard, dedicated top-level `allowRecording` / `allowPrivacyChange` gates for auxiliary steps, ordered evidence, and `allowPointerClick` / `allowPointerDrag` for pointer steps

The packaged pi extension registers all 18 tools in its three configured MCP families, plus `macuse_sequence`, `macuse_tools`, and `macuse_restart`. Only `list_apps`, `get_app_state`, `macuse_sequence`, and `macuse_tools` start active; the loader enables exact additional tools additively until startup, new-session, resume, fork, or reload resets activation. The separate Messages MCP is intentionally excluded because sends cross a hard safety boundary. The current app-server's `node_repl` MCP (`js`, `js_add_node_module_dir`, `js_reset`) is excluded because it permits unrestricted JavaScript and module access outside these guards. `turn-ended` remains excluded because no payload contract is published.

App-server startup reads effective config, disables inherited MCP servers/plugins for the thread, and disables the `apps` feature. Only the three configured families start; their plugin launchers retain `CODEX_HOME`. This is scope isolation, not an OS sandbox.

## Native capabilities and limits

The async native helper lazily compiles with the installed Swift compiler (`xcrun swiftc`), caches by source hash under `~/Library/Caches/macuse/native`, and requires Accessibility access for AX window/text operations. It does not install tooling, activate apps, post keyboard input, or write the clipboard. Upstream Screen Recording/Automation permissions remain separate.

For supported already-focused controls, `type_text` uses `AXSelectedText` to replace the current selection, checking window/document/element identity and selection/value before writing and verifying exact text afterward. Unsupported Unicode fails before mutation; unsupported ASCII may use upstream typing. An attempted edit with an unverified result or timeout must never fall back or replay. AX checks are not transactional and cannot exclude concurrent user edits.

macuse never warps the cursor. Pointer authorization is still required because upstream pointer input may interrupt the user. Native activation and focused-window events are observations, not keyboard/mouse input attribution. Inspect coverage, AX errors, and truncation; unavailable capture is unknown, not evidence of non-interruption. No app-independent isolation guarantee is made.

## Preconditions before any mutating action

A mutating Computer Use action may be enabled only when all of these are true:

1. The user explicitly authorizes mutating Computer Use for the specific task.
2. The target app, window, and intended flow are named.
3. `get_app_state` has just run for the target app in the same flow.
4. The target app state matches the requested task and is not a wrong-window state.
5. The next action is described in plain language before execution.
6. The action is reversible or harmless, or the user has explicitly accepted the risk.
7. The agent has a clear stop boundary for the task.

If any condition fails, do not run the mutating action. Run another read-only
state probe or stop and request explicit user direction.

## Hard stop boundaries

Always hand control back to the user instead of executing credential or authentication changes, attempts to bypass browser or security warnings, consequential financial transactions, or high-impact medical, legal, financial, hiring, identity, or government decisions based on sensitive data. Tool flags never authorize those operations.

Never perform these other actions without fresh, explicit user approval for the exact operation:

- purchases, orders, payments, trades, or financial transfers
- account deletion, subscription changes, or plan changes
- privacy, security, firewall, device-management, or remote-access settings that are not already covered by the handoff rule
- sending messages, emails, comments, posts, invitations, or notifications
- deleting files, records, conversations, data, or cloud resources
- installing/uninstalling software or browser extensions
- accepting legal terms, consent prompts, data-sharing prompts, or policy prompts
- non-decisional actions in medical, legal, financial, hiring, identity, or government systems
- actions in the wrong app, wrong account, wrong workspace, or ambiguous window

## Browser and signed-in app handling

Treat visible signed-in content as sensitive context. Prefer structured APIs,
local files, or `agent_browser` for web workflows when available.

For browser/app Computer Use:

- Keep the task narrow.
- Do not navigate to sensitive account pages unless required.
- Do not submit forms that create external side effects without explicit approval.
- Stop before final submit/order/post/send/pay/delete actions unless the user has explicitly authorized that exact final action; hand off rather than executing when the action falls under the stricter handoff rule.
- Never bypass or dismiss browser security, privacy, certificate, or download warnings for the user.

## App approval prompts

Computer Use app approval is separate from macOS Screen Recording,
Accessibility, and Automation permissions.

The user has explicitly requested that the pi bridge not add a second per-app confirmation layer. The current bridge therefore defaults to `approval: "inherit"`, which auto-accepts Computer Use app-approval elicitations under macuse's standing app-access policy. Explicit `approval: "deny"` remains available for denial-path tests, and the standard MCP wrapper offers `approval: "ask"` for clients that want elicitation prompts.

This only removes the redundant app-approval prompt layer. macOS TCC permissions
and hard stop boundaries still apply.

## Mutating regression probe

The mutating validation now uses a non-destructive Activity Monitor probe:

1. Read `Activity Monitor` state and capture its original selected tab before mutation.
2. Press `Escape` to exercise non-element fresh-state preflight.
3. Exercise a harmless tab change with `perform_secondary_action`.
4. Restore the captured original tab in `finally`, including failure paths, and verify cleanup. Do not assume the original tab was CPU.

Reusable commands:

```bash
node tools/validate-macuse.mjs mutating
node tools/validate-macuse.mjs focus
node tools/validate-macuse.mjs mcp
```

Focus validation uses native activation/window observations and endpoint snapshots. Report observed target activation, drift, and capture gaps without asserting who caused them. Equal endpoints alone cannot exclude a transient focus change; this probe is not a keyboard/mouse non-interruption proof.

Historical May 2026 controlled TextEdit probes (not a guarantee for every app/control):

- `/tmp/macuse-scroll-test.txt`: `scroll down` and `scroll up` on scroll area
  `element_index: "1"` returned successful results and changed screenshot
  hashes.
- `/tmp/macuse-type-test.txt`: `click`, `press_key super+a`, `type_text`,
  `get_app_state`, and `press_key super+s` produced and saved
  `macuse typed text ok`.
- `/tmp/macuse-set-value-test.txt`: `set_value` on text entry element `2`,
  `get_app_state`, and `press_key super+s` produced and saved
  `macuse set value ok`.
- `/tmp/macuse-select-test.txt`: `select_text` with prefix/suffix
  disambiguation selected the intended text and left file contents unchanged.

## Implementation guidance

Pi direct mutating tools and `macuse_sequence` share the same persistent executor, immediate pre-dispatch app-state refresh for every mutation, focus evidence, and fail-closed guards. A failed refresh or document drift since the last observation blocks mutation. Optional `expectedTitle` / `expectedUrl` pin the intended document; put them in step `arguments` for sequences. The whole flow's arguments and safety gates are validated before first dispatch. `set_value` always reads back and verifies the resolved field's requested value, not text elsewhere; other actions read back when requested by `requireStateChange`, assertions, or image capture. Use a direct tool for one action and `macuse_sequence` for ordered multi-step workflows. `macuse_sequence` requires or enforces:

- ordered `steps`, preferably starting and ending with `get_app_state`
- optional sequence-level `app` to apply a default target app to steps that omit
  `arguments.app`; this reduces repeated arguments without weakening the
  app/window specificity requirement in the `safetyNote`
- element-targeted tools accept `element_index` as a string or number, `element`
  as an alias, `elementId` / `element_id`, exact `elementDescription` /
  `element_description` matches, role/name selectors, or `arguments.targets`
  fallback objects such as
  `[{"elementId":"AllClear"},{"elementDescription":"Clear"},{"role":"button","name":"Clear"}]`;
  prefer stable IDs/descriptions/role-name selectors when available because
  numeric indices can shift. Raw `element_index` targets can pass
  `expectedRole`, `expectedName`, `expectedDescription`, `expectedId`, or
  `expectedValue`; mismatches fail before mutation with a stale-target diagnostic
- optional per-step `expectText`, `expectAbsentText`, and `expectVisibleText`
  assertions to stop the sequence when state evidence does not match
  expectations; `expectText`/`expectAbsentText` strip invisible bidi marks before
  substring checks, while `expectVisibleText` checks parsed visible text values
  directly so display assertions can use values like `0` or `1`; stopped
  sequences return completed step evidence plus the failed-step diagnostic, and
  per-step `allowError: true` permits recovery from optional resolution/tool
  errors
- `allowMutating: true` when any step is not read-only
- `allowPointerClick: true` for pointer-based `click` steps and
  `allowPointerDrag: true` for pointer-based `drag` steps; prefer
  `perform_secondary_action` with `action: "Press"`, `press_key`, `set_value`,
  or element-targeted `scroll` to minimize interruption. macuse does not warp the cursor.
- a `safetyNote` that states target app, intended effect, and stop boundary
- sequence `detail: "minimal"` for token-efficient action logs that suppress
  successful action and state bodies while preserving target resolution,
  stale-index warnings, changed-state summaries, assertion pass snippets, and
  failure evidence; `detail: "compact"` remains the default and `detail: "full"`
  keeps raw trees. `targetScope: "main"` suppresses likely chrome/window controls
  in transformed output where possible
- sequence wait helper pseudo-tools (`waitForText` for parsed visible text or
  raw text-entry values, `waitForElement`, `waitUntilElementEnabled`,
  `waitUntilElementDisabled`, plus best-effort `waitForURL` / `waitForTitle`)
  that poll `get_app_state` instead of requiring manual sleeps. Wait helpers
  separate predicate `timeoutMs` from per-poll `toolTimeoutMs`; `waitForText`
  supports `visibleOnly`, `title`, and `url` scoping to reduce false positives
- native observation during reads and sequences, including endpoints, activation/window transitions, and capture coverage; `get_app_state` defaults to `detail:"minimal"` and `trackFocus:true`
- machine-readable parsed state and element metadata in tool result `details`,
  including `visibleText`, `targets`/`elements`, target hints, stable IDs,
  descriptions, role/name, value, semantic tags (`settable-field`,
  `search-field`, `clear-control`, `risk-sensitive-control`), disabled state,
  changed-state summaries, warnings, and next-action hints where Computer Use
  exposes enough accessibility evidence. Mutating steps perform post-action
  state readback for text edits and when requested by `requireStateChange`, assertions, or image
  artifact capture, and report `actionDispatchedButNoStateChange` when no relevant
  target/document change appears; unrelated clock updates do not verify an element action.
  Per-step `requireStateChange: true` turns missing evidence into a failure
  and captures a pre-action baseline for non-element actions such as `press_key`;
  if the first readback shows no change, a short delayed readback is attempted
  before failing to better catch transient popovers/editors
- search-field role normalization, `navigation-field` tagging for browser
  address/search controls where `set_value` may navigate/submit, and
  conservative empty-`set_value` clear fallback when a single non-risky
  clear/cancel control is available
- extension-level refusal of mutating calls unless `allowMutating: true` is passed

Presentation caps (`maxTextChars`, detail/scope) do not truncate internal parsing, caches, targeting, or assertions. They cannot speed up an upstream snapshot that has not returned.

Failure safety: Pi sets the tool-result error flag while preserving completed steps and failure details. Inspect `dispatched` and `outcome`; a safe `resumeFromStepIndex` exists only for a failed action that was not dispatched. A dispatched action may already have taken effect even if readback failed. Timeouts/aborts do not cancel upstream execution; pending requests retain queue ownership until settlement or owned-transport shutdown. Never automatically replay a mutation with unknown outcome. Sequences are not transactions, and ordinary trailing cleanup steps do not run after a stopping failure.

Lifecycle safety: the pi extension owns its native helper and spawned `codex app-server` process and descendants. It stops them on normal `session_shutdown`, exposes `/macuse-stop` for manual cleanup, records macOS PID/start-time fingerprints under `/tmp/macuse-appserver`, starts a watchdog for hard-crash cleanup, and reaps only matching macuse-owned orphaned app-server processes at startup. It does not kill Codex's global `SkyComputerUseService` helper.

The app-server-backed standard MCP wrapper at `tools/codex-computer-use-appserver-mcp.mjs` proxies MCP `elicitation/create` app-approval prompts when the client advertises elicitation support. Every Computer Use mutation requires `allowMutating:true`, a safety note naming target/effect/stop boundary, and an immediate `get_app_state`. Pointer `click` / `drag` additionally require `allowPointer:true`; macuse does not warp the cursor.

The CLI bridge enforces the safety-note requirement through `--safety-note`; pointer calls additionally require `--allow-pointer`. CLI/MCP share startup isolation and native text safety, not the full Pi sequence executor, waits, or structured evidence interface. Restart the owning Pi/CLI/MCP process after code or dependency updates; `/reload` resets Pi activation/resources but does not load updated extension code.
