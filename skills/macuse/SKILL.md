---
name: macuse
description: "Use for the macuse pi tool: inspect, QA, dogfood, or safely control local macOS native apps through Codex Computer Use while preserving focus. Do not use for browser DOM automation, generic pi extension work, raw MCP probes, or sends/deletes/purchases/account/security/privacy changes without exact approval."
compatibility: macOS with the macuse pi package/extension loaded and Codex Computer Use available.
metadata:
  version: "0.2.0"
  owner: "macuse"
---

# macuse

## Goal

Use macuse's Codex Computer Use tools to inspect and safely operate local macOS apps while preserving the user's focus and producing evidence that is easy to audit.

## Sources of truth

- Tool schemas and runtime behavior: `extensions/codex-computer-use.ts` and `extensions/codex-computer-use-modules/`.
- Hard-stop safety policy: `docs/reference/codex-computer-use-safety-policy.md`.
- Package validation (load only when changing or dogfooding this package): `node tools/validate-macuse.mjs --help`; pick the smallest mode for the touched path.

## Use when

- The task needs local macOS app state, native app QA, low-risk UI control, or macuse dogfood.
- The user asks for Computer Use through the `macuse` pi tool.
- A flow needs focus-preserving accessibility actions rather than pointer-first automation.

## Do not use when

- The task is ordinary website automation that `agent_browser` can do without native browser chrome.
- The task is generic pi extension development rather than using macuse tools.
- The task only needs raw MCP/app-server protocol investigation.
- The next action would send, delete, purchase, install, terminate processes, change credentials/account/security/privacy settings, or act in an ambiguous window without fresh explicit approval.

## Default workflow

1. Start read-only: call `macuse({ action: "list_apps", listApps: { runningOnly: true } })` or a filtered list when the target app name is uncertain.
2. Inspect before acting: call `macuse({ action: "get_app_state", getAppState: { app, detail: "minimal", targetScope: "main" } })`; use `detail: "compact"` only when you need more target context. Focus capture on `get_app_state` is opt-in (`trackFocus: true`). Mutating sequences capture native frontmost focus before/after and report whether it changed; they do not auto-restore frontmost focus. If Computer Use reports a stopped app session or transport-closed state, read-only calls auto-restart only the macuse app-server session once; call `macuse({ action: "restart_computer_use", restartComputerUse: { reason } })` before retrying when an explicit Computer Use helper restart is needed.
3. Prefer stable targets in this order:
   - `elementId`
   - exact `elementDescription`
   - unique `role`/`name`
   - `arguments.targets` fallback objects
   - raw `element_index` only with `expectedRole`/`expectedName` guards.
4. For dynamic controls, prefer `arguments.targets` fallback objects that include both stable IDs and visible descriptions when available.
5. Prefer non-pointer actions: `perform_secondary_action`, `set_value`, `press_key`, `type_text`, `select_text`, and wait helpers. For text entry, prefer `set_value` only on a verified settable target; use `type_text` only after verified focus. `select_text` selects by text string, not offsets. Use pointer `click`/`drag` only when necessary and only with the explicit pointer allow flag.
6. Use `action:"event_stream"` for Record & Replay and `action:"computer_history"` with `computerHistory` for Computer History. Record & Replay starts and Computer History start/resume require `allowRecording:true` and a non-empty `safetyNote`; `update_settings` requires `allowPrivacyChange:true`, a safety note, and the complete `observation` object; call `get_settings` immediately first and preserve every unchanged field because the update replaces all settings. Stop/pause need no allow flag. Status/get_settings are read-only but expose activity/privacy metadata. Never use these calls as a prerequisite for ordinary app control.
7. For mutations, use `macuse({ action: "sequence", sequence: ... })` with:
   - `allowMutating: true`
   - a narrow `safetyNote`
   - before/after `get_app_state`
   - assertions such as `expectText`, `expectAbsentText`, or `expectVisibleText`
   - `requireStateChange: true` on steps where a no-op should fail closed
   - cleanup/restore steps when practical.
8. Read the run summary first. Check apps touched, actions, target method, safety tags, final visible text, focus, and anomaly hints before inspecting verbose step details.
9. If a sequence fails, use `failedStepIndex`, `completedStepCount`, and `resumeFromStepIndex`; do not blindly replay prior mutating steps. If a failed step has no app-state readback, macuse suppresses changed-state summaries to avoid false deltas; re-read state before concluding the UI changed.

## Safety rules

- Keep the user's frontmost app and mouse focus intact when possible. Treat focus changes as evidence to report.
- Treat `risk-sensitive-control` tags and the “Risk-sensitive controls visible” note as stop-and-review signals, even when the requested action seems small. Prefer summaries that surface `transient-editor` tags when working with popovers/editors.
- Use `expectVisibleText` for UI-visible assertions; it matches substrings within parsed visible text nodes, window titles, visible control labels, and exposed field/search/edit values, including multiline continuations when upstream exposes them. Use `expectText` only for app content text/value checks; it intentionally ignores macuse/upstream metadata such as CUA version headers.
- Do not clear text, select files, open files, submit forms, or press destructive controls unless that exact operation is low-risk and covered by the safety note or user approval. Treat browser address/search fields tagged `navigation-field` as submitting/navigation controls: `set_value` or `type_text` may change URL/title state or send a search, not merely stage text. `type_text` goes to current keyboard focus, which may be page content, not the omnibox.
- If Computer Use times out or state looks stale, stop mutation and report the blocker. For stopped-session or transport-closed states, use `macuse` action `restart_computer_use` or `/macuse-restart`; for timeouts, try a larger `toolTimeoutMs` or a read-only re-snapshot before considering another action.
- Treat `actionDispatchedButNoStateChange` as a failed intended open/navigation unless the action was expected to be a no-op. Retry from a fresh state read; use pointer fallback only with `allowPointerClick` and an unambiguous target/window. For transient popovers/editors, a delayed readback is attempted automatically, but upstream may still miss very short-lived or hidden UI.
- Scope waits when possible. `waitForText` accepts `visibleOnly: true` plus optional `title` or `url` guards to avoid matching stale/recent-list text. `title` is a strict window-title guard; if browser chrome reports a stale/non-intuitive title, omit the title guard and rely on a specific visible/url assertion instead.
- Do not use `Raise` to restore focus. If focus matters, verify the native focus summary and report any change honestly.
- Finder sidebar/file rows and Calendar toolbar/popover controls are known to have sparse or unstable AX actions. If `Press` is invalid, switch target strategy or stop before pointer fallback unless explicitly approved.
- For repeated `cgWindowNotFound`, `frontmost=<none>`, service timeouts, `connectionInvalid`, `errAETimeout`, `Computer Use server error -1743`, or suspected macOS TCC/Automation failures, run `node tools/macuse-doctor.mjs --out .scratch/doctor` when you are in this repo. Use `node tools/macuse-repair.mjs --repair-tcc --responsible auto` for a dry-run responsible-launcher preview. Apply repairs only with explicit user approval because `--apply`, `--unlock-with-env`, and `--repair-tcc` mutate broader local GUI/process/privacy state; applying TCC repair requires a host with Full Disk Access. Restarting Computer Use for the current session is allowed through `macuse` action `restart_computer_use`.

Do not expose or attempt `turn-ended` (no published payload contract) or the private `@oai/sky` Node REPL adapter (not MCP).

## Evidence to report

Include only the facts needed for audit:

- tools used and target app/window
- resolved target method and safety tags
- assertions and final visible state
- focus before/after
- saved screenshot artifact path if used; for sequences use `screenshotStep: "final"` when the final visual state matters
- failures, anomaly hints, and whether cleanup restored the app state
