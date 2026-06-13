---
name: macuse
description: Use this skill when the user asks to use macuse/Codex Computer Use from pi to inspect, dogfood, QA, or safely control local macOS apps with codex_cu_list_apps, codex_cu_get_app_state, or codex_cu_sequence. Applies to native app automation, focus-preserving GUI checks, and macuse extension dogfood. Do not use for ordinary web-page automation where agent_browser is sufficient, generic pi extension development, raw MCP probing, or risky sends/deletes/purchases/account/security/privacy actions without explicit approval.
compatibility: macOS with the macuse pi package/extension loaded and Codex Computer Use available.
metadata:
  version: "0.1.0"
  owner: "macuse"
---

# macuse

## Goal

Use macuse's Codex Computer Use tools to inspect and safely operate local macOS apps while preserving the user's focus and producing evidence that is easy to audit.

## Use when

- The task needs local macOS app state, native app QA, low-risk UI control, or macuse dogfood.
- The user asks for Computer Use through macuse or the `codex_cu_*` pi tools.
- A flow needs focus-preserving accessibility actions rather than pointer-first automation.

## Do not use when

- The task is ordinary website automation that `agent_browser` can do without native browser chrome.
- The task is generic pi extension development rather than using macuse tools.
- The task only needs raw MCP/app-server protocol investigation.
- The next action would send, delete, purchase, install, terminate processes, change credentials/account/security/privacy settings, or act in an ambiguous window without fresh explicit approval.

## Default workflow

1. Start read-only: call `codex_cu_list_apps({ runningOnly: true })` or a filtered list when the target app name is uncertain.
2. Inspect before acting: call `codex_cu_get_app_state` with `detail: "minimal"` and `targetScope: "main"`; use `detail: "compact"` only when you need more target context.
3. Prefer stable targets in this order:
   - `elementId`
   - exact `elementDescription`
   - unique `role`/`name`
   - `arguments.targets` fallback objects
   - raw `element_index` only with `expectedRole`/`expectedName` guards.
4. For dynamic controls such as Calculator clear/all-clear buttons, prefer `arguments.targets` fallback objects that include both the stable ID and visible description, for example `[{ "elementId": "AllClear" }, { "elementDescription": "Clear" }, { "elementDescription": "All Clear" }]`.
5. Prefer non-pointer actions: `perform_secondary_action`, `set_value`, `press_key`, `type_text`, `select_text`, and wait helpers. Use pointer `click`/`drag` only when necessary and only with the explicit pointer allow flag.
6. For mutations, use `codex_cu_sequence` with:
   - `allowMutating: true`
   - a narrow `safetyNote`
   - before/after `get_app_state`
   - assertions such as `expectText`, `expectAbsentText`, or `expectVisibleText`
   - cleanup/restore steps when practical.
7. Read the run summary first. Check apps touched, actions, target method, safety tags, final visible text, focus, and anomaly hints before inspecting verbose step details.
8. If a sequence fails, use `failedStepIndex`, `completedStepCount`, and `resumeFromStepIndex`; do not blindly replay prior mutating steps.

## Safety rules

- Keep the user's frontmost app and mouse focus intact when possible. Treat focus changes as evidence to report.
- Treat `risk-sensitive-control` tags as a stop-and-review signal, even when the requested action seems small.
- Use `expectVisibleText` for UI-visible assertions. Use `expectText` only for app content text/value checks; it intentionally ignores macuse/upstream metadata such as CUA version headers.
- Do not clear text, select files, open files, submit forms, or press destructive controls unless that exact operation is low-risk and covered by the safety note or user approval.
- If Computer Use times out or state looks stale, stop mutation and report the blocker. Try `/macuse-restart`, a larger `toolTimeoutMs`, or a read-only re-snapshot before considering another action.
- For repeated `cgWindowNotFound`, `frontmost=<none>`, service timeouts, or suspected macOS TCC/Automation failures, run `node tools/macuse-doctor.mjs --out .scratch/doctor` when you are in this repo. Use `node tools/macuse-repair.mjs` for a dry-run repair preview. Apply repairs only with explicit user approval because `--apply`, `--restart-appserver`, `--restart-service`, `--unlock-with-env`, and `--repair-tcc` mutate local GUI/process/privacy state.

## Evidence to report

Include only the facts needed for audit:

- tools used and target app/window
- resolved target method and safety tags
- assertions and final visible state
- focus before/after
- saved screenshot artifact path if used
- failures, anomaly hints, and whether cleanup restored the app state

## Local validation commands

When changing or dogfooding this package, prefer:

```bash
node tools/validate-macuse.mjs quick
node tools/validate-macuse.mjs mcp
node tools/macuse-doctor.mjs --out .scratch/doctor
node tools/macuse-repair.mjs
node tools/codex-computer-use-appserver.mjs list-apps --running-only --filter Calculator --quiet --pretty
```
