# Codex Computer Use safety policy for non-Codex harnesses

Source: Local policy for this `macuse` investigation, based on the installed Codex Computer Use skill, OpenAI's Computer Use docs snapshot, and local bridge behavior.
Author: Local investigation notes
Created: May 22, 2026
Status: Draft for future mutating-tool enablement; read-only pi tools are already enabled

## Current allowed scope

Allowed today:

- `list_apps`
- `get_app_state`
- app-approval denial probes
- app-server status/discovery probes

Not allowed by default:

- `click`
- `type_text`
- `press_key`
- `drag`
- `scroll`
- `set_value`
- `select_text`
- `perform_secondary_action`

The project-local pi extension intentionally exposes only read-only tools.

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

## Minimal future mutating regression probe

The first mutating validation should be a harmless Calculator-only probe:

1. Run `codex_cu_get_app_state` for `Calculator`.
2. Verify the display is `0` and the expected keypad buttons are present.
3. Click a single digit such as `1`.
4. Run `get_app_state` again.
5. Verify the display changed to `1`.
6. Click `All Clear` only if needed to restore the original state.

Do not run this probe until the user explicitly approves mutating validation.

## Implementation guidance

Prefer one guarded mutating tool surface over many always-on tools. A future pi
mutating wrapper should require:

- `app`
- `tool`
- `arguments`
- `expectedCurrentState`
- `intendedEffect`
- `riskLevel`
- `userApprovedMutatingAction: true`

The wrapper should refuse mutating calls unless the prompt and parameters make
the risk boundary explicit. It should also return before/after `get_app_state`
evidence for every mutating action.
