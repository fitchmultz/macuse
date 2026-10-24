# Qualifying ChatGPT independence

The production macuse backend still uses the installed vendor runtime. Experimental native and execution proofs are not an automatic fallback, a supported replacement, or evidence of feature parity. Keep the current backend selected until the relevant gates below have passed and the public interfaces, safety policy, and installation procedure are updated together.

## What independence means

There are three different claims:

1. **No ChatGPT window or foreground process required.** This does not imply independence: ChatGPT can still supply the runtime files, helper, authentication, and updates.
2. **A controlled vendor cohort.** Record the exact JavaScript packages, Node/kernel, signed native helper, IPC contract, auxiliary plugins, and authentication requirements. Selecting a different resources directory alone does not prove which already-running helper the client uses.
3. **An independently acquired or source-owned implementation.** Neither the native actuator nor its persistent JavaScript execution environment may depend on ChatGPT-provided components. A native helper alone cannot establish this claim.

A full macuse independence claim must also account for Record & Replay and Computer History. Keeping those vendor-backed can be an explicit transitional product boundary, but is not 100% independence. Do not silently remove them or treat their absence as a passing test.

## Gate 1: native actuator

Use a source-owned helper and public macOS APIs without starting the vendor runtime. A compile-only API probe establishes availability, not working permissions or app behavior.

The opt-in Activity Monitor runner exercises only a **partial native slice**:

```bash
node tools/qualify-native-actuator.mjs --help
node tools/qualify-native-actuator.mjs --live
node tools/qualify-native-actuator.mjs --live --fixture
```

Without `--live`, the runner does not access the desktop. The live command requires the experimental `tools/native-actuator.mjs` backend, native permissions, and authorization for the controlled tab change/restoration. It captures the actual original tab, checks window-bound PNG headers and reported metadata, checks missing-authorization refusal, presses one alternate tab, and verifies restoration. It does not upload the screenshot or include its image bytes in the JSON report.

`--fixture` launches a uniquely identified, task-owned real AppKit app with native radio controls instead of using Activity Monitor. The runner pins the owned process and window, exercises the same native helper, and restores the original selection. A second helper changes the fixture context to check that the first helper refuses a stale field edit. A fresh observation then authorizes a Unicode **whole-field** replacement, with exact independent readback and restoration of the original field and radio state. This is not selected-range insertion proof. Both helpers and the test app are disposed in `finally`.

This is a native integration fixture, not a mock AX tree or screenshot. It demonstrates only the fixture slice, not compatibility with Activity Monitor or other real-world apps. When invoking the exported fixture qualifier without a second helper, the text/context checks remain explicitly unattempted.

Large or dynamic apps can exceed the experimental helper's complete-snapshot limits or change during preflight. Those cases must fail without admitting a partial observation; do not widen the limits or omit context just to turn a real-app failure into a pass. A passing fixture does not supersede a failed real-app probe.

A successful `ok` means only those named checks passed. The report keeps `fullNativeQualification` and `chatgptIndependenceQualified` false and lists unattempted gates. PNG metadata is not visual content verification or a proven coordinate-action mapping.

| Contract | Required evidence |
| --- | --- |
| Exact target | Resolve one exact running app identity; retain PID, window, document, and element identity. Reject ambiguity, replacement windows, stale targets, and changed field values before dispatch. |
| Complete observations | Inspect the actual app/window tree before choosing an action. A truncated tree must not authorize mutation of an unidentified target. |
| Native action | Perform a bounded accessibility action and independently observe its actual result. An AX return code alone does not prove the UI outcome. |
| Screenshot | Capture the intended window, decode the actual image, verify dimensions and content, and report the pixel-to-window mapping. Do not assume Retina scaling or OS-point coordinates. |
| Unicode | Replace a known selected range in a disposable already-focused text field; verify exact value and preservation of unselected text. No clipboard/keyboard fallback or replay. |
| Focus and pointer | Capture native activation/window transitions and pointer endpoints for the controlled operation. Equal endpoints do not exclude transient changes; absence of input attribution is not non-interruption proof. |
| Refusal | Missing mutation authorization, app mismatch, stale observation, and unsupported target/action must fail without dispatch. Exercise each refusal at its owning boundary. |
| Uncertain effects | Timeout, native error after dispatch, or failed readback must retain attempted/unknown evidence. Never automatically replay an attempted action. |
| Cleanup | Capture original state before the first mutation, restore it in `finally`, and independently verify restoration. Cleanup failure fails the run even when the main action succeeded. |

Activity Monitor checks may select only a named tab. Capture its actual original tab; do not assume CPU. Never interact with Stop, Inspector, process actions, or termination controls. A helper failure must not cause a blind second press. Refresh the exact target and select the original tab only from a known, unambiguous state.

Text checks must use a disposable test document with bounded content and an explicit cleanup plan. They do not authorize edits to existing user documents, unrelated app activation, or closing an unknown window.

## Gate 2: independent execution and transport

The execution environment must be independent as well as the actuator. Preserve the current public scoped-mutation model rather than executing model programs in the Pi host or using an ordinary language context as a claimed security sandbox.

- Use a separately owned process and a reviewed, capability-limited execution boundary. Guest code must not obtain filesystem, process, network, module-loader, native-object, or host-evaluator access.
- Keep run authorization and action evidence in the trusted host. Guest-written output or RPC fields cannot widen app scope, change permissions, or impersonate completed actions.
- Interpret native capability outcomes, not just successful RPC delivery. A callback returning `unverified` or `unknown` cannot become a verified GUI effect merely because execution reports that the callback completed.
- Bound requests, output, execution time, and pending work. Reject malformed or unexpected protocol messages rather than interpreting them as trusted control data.
- Keep screenshots in a separately bounded parent-owned image/handle path. The experimental executor's 65,536-byte JSON protocol does not support arbitrary screenshot payloads; increasing that limit without a reviewed image transport is not integration proof.
- Demonstrate bindings surviving ordinary calls, then demonstrate a clean context after reset/abort/timeout.
- Resetting or killing the executor cannot undo or prove cancellation of an already-dispatched native action. Settle owned host work, retain unknown effects, and require fresh observations before any new mutation.
- Exercise the actual opt-in path in fresh Pi, CLI, and MCP processes. A unit-test fake, direct helper call, or old process using retained vendor bindings is not end-to-end independence evidence.

Native observation, input, and execution each need their own evidence. A transport that faithfully forwards a mock response does not qualify the native implementation or the sandbox.

## Gate 3: release and installation

Before changing the production default:

1. Review and deliberately update the architecture policy, schemas, usage skill, diagnostics, installation instructions, and error/recovery behavior. Preserve the support floor and scoped guards.
2. Run offline compatibility, package checks, both supported Pi host checks, and the authorized live native/focus/transport checks against exact source and runtime identities.
3. Use normal Accessibility, Screen Recording, and applicable Automation flows. A signed helper identity, its permissions, and its upgrade behavior must be reproducible. Never edit TCC databases or bypass vendor authentication to manufacture a pass.
4. Verify fresh-process startup without reading the ChatGPT installation or attaching to its already-running helper. Inspect the actual process/artifact/IPC identities, not just the selected path or environment variable.
5. Preserve a recoverable prior installation. Install deliberately, restart affected Pi/CLI/MCP processes, and verify the installed outcome before claiming delivery.

## Evidence and reporting

Keep local screenshots, text trees, and transcripts private unless sharing their contents is authorized. PR evidence should summarize exact commits, host/runtime identities, commands, and results without uploading unrelated desktop content or credentials.

Report every gate as **passed**, **failed**, or **unattempted**, with its actual scope. An unsupported permission flow, unavailable native capability, incomplete transition coverage, or skipped transport is not a pass. Historical results do not qualify a changed helper, execution environment, launcher, or permission context.
