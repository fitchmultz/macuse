---
name: macuse
description: "Use for macuse pi tools: inspect, QA, dogfood, or safely control local macOS native apps through Codex Computer Use while preserving focus. Do not use for browser DOM automation, generic pi extension work, raw MCP probes, or sends/deletes/purchases/account/security/privacy changes without exact approval."
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
- The user asks for Computer Use through the macuse pi extension tools.
- A flow needs focus-preserving accessibility actions rather than pointer-first automation.

## Do not use when

- The task is ordinary website automation that `agent_browser` can do without native browser chrome.
- The task is generic pi extension development rather than using macuse tools.
- The task only needs raw MCP/app-server protocol investigation.
- The next action would send, delete, purchase, install, terminate processes, change credentials/account/security/privacy settings, or act in an ambiguous window without fresh explicit approval.

## Default workflow

1. Start read-only: call `list_apps({ runningOnly: true })` or use `filter` when the target app name is uncertain. `list_apps`, `get_app_state`, `macuse_sequence`, and `macuse_tools` start active; use `macuse_tools({ tools: [...] })` to enable only the exact direct, recording, history, or recovery tools needed. New-session, resume, fork, and reload boundaries reset activation, so enable them again afterward.
2. Inspect before acting: call `get_app_state({ app, detail: "minimal", targetScope: "main" })`; use `detail: "compact"` only when you need more target context. Focus capture is opt-in with `trackFocus: true`. Mutating tools and sequences capture native frontmost focus before/after and report whether it changed; they do not auto-restore frontmost focus. If Computer Use reports a stopped app session or transport-closed state, read-only calls auto-restart only the macuse app-server session once; enable `macuse_restart` with `macuse_tools`, then call it before retrying when an explicit Computer Use helper restart is needed.
3. Prefer stable targets in this order:
   - `elementId`
   - exact `elementDescription`
   - unique `role`/`name`
   - `targets` fallback objects (inside step `arguments` for `macuse_sequence`)
   - raw `element_index` only with `expectedRole`/`expectedName` guards.
4. For dynamic controls, prefer `targets` fallback objects that include both stable IDs and visible descriptions when available.
5. Enable the exact tool with `macuse_tools` before using a direct tool. Prefer direct non-pointer tools: `perform_secondary_action`, `set_value`, `press_key`, `type_text`, `select_text`, and `scroll`. Each direct mutation requires `allowMutating:true`, a narrow `safetyNote`, and a recent `get_app_state`; use `requireStateChange:true` when a no-op should fail closed. Prefer `set_value` only on a verified settable target and `type_text` only after verified focus. `select_text` selects by text string, not offsets. Direct `click`/`drag` additionally require `allowPointer:true`.
6. Use the direct `event_stream_*` and `computer_history_*` tools only when requested. Record & Replay start and Computer History resume require `allowRecording:true` plus `safetyNote`; `computer_history_update_settings` requires `allowPrivacyChange:true`, a safety note, the complete `observation`, and the current `showMenuBarIcon` value when present; call `computer_history_get_settings` immediately first and preserve every unchanged field. Stop/pause need no allow flag. Status/settings calls are read-only but expose activity/privacy metadata.
7. Use `macuse_sequence` when the flow needs ordered actions, waits, assertions, or shared cleanup. Pass:
   - `allowMutating: true` and a narrow `safetyNote` for mutating steps
   - before/after `get_app_state`
   - assertions such as `expectText`, `expectAbsentText`, or `expectVisibleText`
   - `requireStateChange: true` where a no-op should fail closed
   - `allowPointerClick` / `allowPointerDrag` only for required pointer steps
   - cleanup/restore steps when practical.
8. Read the run summary first. Check apps touched, actions, target method, safety tags, final visible text, focus, and anomaly hints before inspecting verbose step details.
9. If a sequence fails, use `failedStepIndex`, `completedStepCount`, and `resumeFromStepIndex`; do not blindly replay prior mutating steps. If a failed step has no app-state readback, macuse suppresses changed-state summaries to avoid false deltas; re-read state before concluding the UI changed.

## Safety rules

- Keep the user's frontmost app and mouse focus intact when possible. Treat focus changes as evidence to report.
- Treat `risk-sensitive-control` tags and the “Risk-sensitive controls visible” note as stop-and-review signals, even when the requested action seems small. Prefer summaries that surface `transient-editor` tags when working with popovers/editors.
- Use `expectVisibleText` for UI-visible assertions; it matches substrings within parsed visible text nodes, window titles, visible control labels, and exposed field/search/edit values, including multiline continuations when upstream exposes them. Use `expectText` only for app content text/value checks; it intentionally ignores macuse/upstream metadata such as CUA version headers.
- Do not clear text, select files, open files, submit forms, or press destructive controls unless that exact operation is low-risk and covered by the safety note or user approval. Treat browser address/search fields tagged `navigation-field` as submitting/navigation controls: `set_value` or `type_text` may change URL/title state or send a search, not merely stage text. `type_text` goes to current keyboard focus, which may be page content, not the omnibox.
- If Computer Use times out or state looks stale, stop mutation and report the blocker. For stopped-session or transport-closed states, enable and use `macuse_restart`, or use `/macuse-restart`; for timeouts, try a larger `toolTimeoutMs` or a read-only re-snapshot before considering another action.
- Treat `actionDispatchedButNoStateChange` as a failed intended open/navigation unless the action was expected to be a no-op. Retry from a fresh state read; direct pointer fallback requires `allowPointer:true`, while sequence pointer fallback requires `allowPointerClick`/`allowPointerDrag`, always with an unambiguous target/window. For transient popovers/editors, a delayed readback is attempted automatically, but upstream may still miss very short-lived or hidden UI.
- Scope waits when possible. `waitForText` accepts `visibleOnly: true` plus optional `title` or `url` guards to avoid matching stale/recent-list text. `title` is a strict window-title guard; if browser chrome reports a stale/non-intuitive title, omit the title guard and rely on a specific visible/url assertion instead.
- Do not use `Raise` to restore focus. If focus matters, verify the native focus summary and report any change honestly.
- Finder sidebar/file rows and Calendar toolbar/popover controls are known to have sparse or unstable AX actions. If `Press` is invalid, switch target strategy or stop before pointer fallback unless explicitly approved.
- For repeated `cgWindowNotFound`, `frontmost=<none>`, service timeouts, `connectionInvalid`, `errAETimeout`, `Computer Use server error -1743`, or suspected macOS TCC/Automation failures, run `node tools/macuse-doctor.mjs --out .scratch/doctor` when you are in this repo. Use `node tools/macuse-repair.mjs --repair-tcc --responsible auto` for a dry-run responsible-launcher preview. Apply repairs only with explicit user approval because `--apply`, `--unlock-with-env`, and `--repair-tcc` mutate broader local GUI/process/privacy state; applying TCC repair requires a host with Full Disk Access. Restarting Computer Use for the current session is allowed through `macuse_restart`.

Do not expose or attempt the separate Messages MCP, `turn-ended` (no published payload contract), or the private `@oai/sky` Node REPL adapter (not MCP).

## Evidence to report

Include only the facts needed for audit:

- tools used and target app/window
- resolved target method and safety tags
- assertions and final visible state
- focus before/after
- saved screenshot artifact path if used; for sequences use `screenshotStep: "final"` when the final visual state matters
- failures, anomaly hints, and whether cleanup restored the app state
