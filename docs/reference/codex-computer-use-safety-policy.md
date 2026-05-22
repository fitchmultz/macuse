# Codex Computer Use safety policy for non-Codex harnesses

Source: Local policy for this `macuse` investigation, based on the installed Codex Computer Use skill, OpenAI's Computer Use docs snapshot, and local bridge behavior.
Author: Local investigation notes
Created: May 22, 2026
Status: Active guardrails for the project-local pi extension; read-only tools and a guarded sequence tool are enabled

## Current allowed scope

Allowed today:

- `list_apps`
- `get_app_state`
- app-approval denial probes
- app-server status/discovery probes
- guarded `codex_cu_sequence` calls with explicit `allowMutating: true`, a
  concrete `safetyNote`, and UI confirmation for mutating steps

Not allowed as always-on standalone tools:

- `click`
- `type_text`
- `press_key`
- `drag`
- `scroll`
- `set_value`
- `select_text`
- `perform_secondary_action`

The project-local pi extension exposes standalone read-only tools plus one
guarded sequence tool. It does not expose standalone mutating tools.

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

Never perform these actions without fresh, explicit user approval for the exact
operation:

- purchases, orders, payments, trades, or financial transfers
- account deletion, subscription changes, or plan changes
- credential, key, token, password, recovery-code, or MFA changes
- privacy, security, firewall, device-management, or remote-access settings
- sending messages, emails, comments, posts, invitations, or notifications
- deleting files, records, conversations, data, or cloud resources
- installing/uninstalling software or browser extensions
- accepting legal terms, consent prompts, data-sharing prompts, or policy prompts
- actions in medical, legal, financial, hiring, identity, or government systems
- actions in the wrong app, wrong account, wrong workspace, or ambiguous window

## Browser and signed-in app handling

Treat visible signed-in content as sensitive context. Prefer structured APIs,
local files, or `agent_browser` for web workflows when available.

For browser/app Computer Use:

- Keep the task narrow.
- Do not navigate to sensitive account pages unless required.
- Do not submit forms that create external side effects without explicit approval.
- Stop before final submit/order/post/send/pay/delete actions unless the user has
  explicitly authorized that exact final action.

## App approval prompts

Computer Use app approval is separate from macOS Screen Recording,
Accessibility, and Automation permissions.

A non-Codex harness must:

- surface the app name and approval prompt clearly,
- offer decline/cancel paths,
- avoid auto-accepting new app approvals except in controlled validation probes,
- not use "always allow" semantics unless the user explicitly requests a durable
  app approval change.

The current bridge uses `accept-once` or `deny`; the pi extension defaults to an
interactive confirmation for `get_app_state`.

## Mutating regression probe

The first mutating validation was approved and run on May 22, 2026. It is a
harmless Calculator-only probe:

1. Run `get_app_state` for `Calculator`.
2. Activate `All Clear` at element index `6` using `perform_secondary_action` with `action: "Press"`.
3. Run `get_app_state` and verify display `0`.
4. Activate digit `1` at element index `17` using `perform_secondary_action` with `action: "Press"`.
5. Run `get_app_state` and verify display `1`.
6. Activate `All Clear` at element index `6` using `perform_secondary_action` with `action: "Press"`.
7. Run `get_app_state` and verify display `0`.
8. Press key `2`.
9. Run `get_app_state` and verify display `2`.
10. Activate `All Clear` at element index `6` using `perform_secondary_action` with `action: "Press"`.
11. Run `get_app_state` and verify display restored to `0`.

Reusable commands:

```bash
node tools/validate-macuse.mjs mutating
node tools/validate-macuse.mjs focus
```

The focus validation records the frontmost app before/after the mutating probe
and fails if Calculator is left frontmost when it was not frontmost at the start.
Mouse coordinates are reported for operator review, not used as a hard failure,
because the user may move the mouse during the run.

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

Prefer one guarded mutating tool surface over many always-on tools. The current
`codex_cu_sequence` wrapper requires or enforces:

- ordered `steps`, preferably starting and ending with `get_app_state`
- optional per-step `expectText` and `expectAbsentText` assertions to stop the
  sequence when state evidence does not match expectations
- `allowMutating: true` when any step is not read-only
- `allowPointerClick: true` for pointer-based `click` steps and
  `allowPointerDrag: true` for pointer-based `drag` steps; prefer
  `perform_secondary_action` with `action: "Press"`, `press_key`, `set_value`,
  or element-targeted `scroll` when possible to preserve mouse/system focus.
  Pointer drag/click sequences use bridge-level `--preserve-mouse` restoration.
- a `safetyNote` that states target app, intended effect, and stop boundary
- UI confirmation for mutating sequences
- bridge-level refusal of mutating calls unless `--allow-mutating` is passed

The wrapper should continue to refuse mutating calls unless the prompt and
parameters make the risk boundary explicit. It should return before/after
`get_app_state` evidence for every mutating action when practical.
