# Codex Computer Use safety policy for non-Codex harnesses

Source: Local policy for this `macuse` investigation, based on the installed Codex Computer Use skill, OpenAI's Computer Use docs snapshot, and local bridge behavior.
Author: Local investigation notes
Created: May 22, 2026
Updated: August 17, 2026 for the ChatGPT 26.810.52044 / plugin 1.0.1000717 release
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
- `computer_history_update_settings` only with fresh exact user approval, explicit `allowPrivacyChange: true`, a non-empty safety note, and the complete `observation` plus current `showMenuBarIcon` value when present, copied from an immediately preceding `computer_history_get_settings` result with only the approved fields changed
- direct `perform_secondary_action`, `press_key`, `type_text`, `set_value`, `select_text`, `scroll`, `click`, and `drag` only with explicit `allowMutating: true`, a concrete `safetyNote`, and an immediate pre-dispatch `get_app_state`; direct pointer tools also require `allowPointer: true`
- `macuse_sequence` with the same mutation guard, ordered evidence, and `allowPointerClick` / `allowPointerDrag` for pointer steps

The packaged pi extension registers all 18 tools in its three configured MCP families, plus `macuse_sequence`, `macuse_tools`, and `macuse_restart`. Only `list_apps`, `get_app_state`, `macuse_sequence`, and `macuse_tools` start active; the loader enables exact additional tools additively until startup, new-session, resume, fork, or reload resets activation. The separate Messages MCP is intentionally excluded because sends cross a hard safety boundary. The current app-server's `node_repl` MCP (`js`, `js_add_node_module_dir`, `js_reset`) is excluded because it permits unrestricted JavaScript and module access outside these guards. `turn-ended` remains excluded because no payload contract is published.

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

1. Run `get_app_state` for `Activity Monitor`.
2. Normalize to the `CPU` tab with `perform_secondary_action`.
3. Press `Escape` to prove non-element mutations receive an immediate fresh-state preflight.
4. Switch to the `Memory` tab with `perform_secondary_action`.
5. Switch back to the `CPU` tab with `perform_secondary_action`.
6. Verify CPU state. The separate `focus` mode also fails if a mutating action brings Activity Monitor frontmost.

Reusable commands:

```bash
node tools/validate-macuse.mjs mutating
node tools/validate-macuse.mjs focus
node tools/validate-macuse.mjs mcp
```

The focus validation records the frontmost app before/after each mutating probe and fails if Computer Use brings Activity Monitor frontmost. Unrelated user-driven frontmost drift and whole-run mouse coordinate drift are reported rather than misattributed to Computer Use. Pointer
sequences check their own before/restored coordinates separately.

Separate controlled TextEdit probes were also run:

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

Direct mutating tools and `macuse_sequence` share the same persistent executor, immediate pre-dispatch app-state refresh for every mutation, focus evidence, and fail-closed guards. A failed refresh blocks the mutation. Post-action readback runs when evidence is requested with `requireStateChange`, assertions, or image capture. Use a direct tool for one action and `macuse_sequence` for ordered multi-step workflows. `macuse_sequence` requires or enforces:

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
  or element-targeted `scroll` when possible to preserve mouse/system focus.
  Pointer drag/click sequences restore mouse position; non-pointer sequences do not warp the cursor.
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
- focus summaries on read and sequence outputs (`before`, `after`,
  `frontmostChanged`, and target-app frontmost checks), plus pointer mouse
  restoration evidence when pointer tools are used
- machine-readable parsed state and element metadata in tool result `details`,
  including `visibleText`, `targets`/`elements`, target hints, stable IDs,
  descriptions, role/name, value, semantic tags (`settable-field`,
  `search-field`, `clear-control`, `risk-sensitive-control`), disabled state,
  changed-state summaries, warnings, and next-action hints where Computer Use
  exposes enough accessibility evidence. Mutating steps perform post-action
  state readback when requested by `requireStateChange`, assertions, or image
  artifact capture, and report `actionDispatchedButNoStateChange` when upstream
  reports success but no observable title, URL, visible-text, or target change
  appears; per-step `requireStateChange: true` turns that into a failure
  and captures a pre-action baseline for non-element actions such as `press_key`;
  if the first readback shows no change, a short delayed readback is attempted
  before failing to better catch transient popovers/editors
- search-field role normalization, `navigation-field` tagging for browser
  address/search controls where `set_value` may navigate/submit, and
  conservative empty-`set_value` clear fallback when a single non-risky
  clear/cancel control is available
- extension-level refusal of mutating calls unless `allowMutating: true` is passed

Lifecycle safety: the pi extension owns only its spawned `codex app-server` process and descendants. It stops them on normal `session_shutdown`, exposes `/macuse-stop` for manual cleanup, records macOS PID/start-time fingerprints under `/tmp/macuse-appserver`, starts a watchdog for hard-crash cleanup, and reaps only matching macuse-owned orphaned app-server processes at startup. It does not kill Codex's global `SkyComputerUseService` helper.

The app-server-backed standard MCP wrapper at `tools/codex-computer-use-appserver-mcp.mjs` proxies MCP `elicitation/create` app-approval prompts when the client advertises elicitation support. Every Computer Use mutation requires `allowMutating:true`, a safety note naming target/effect/stop boundary, and an immediate `get_app_state`. Pointer `click` / `drag` additionally require `allowPointer:true`, and mouse position is restored after the pointer call.

The CLI bridge enforces the same safety-note requirement through `--safety-note`; pointer calls additionally require `--allow-pointer` and automatically restore the mouse.
