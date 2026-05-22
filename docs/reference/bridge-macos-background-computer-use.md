# macOS Background Computer Use - Bridge X Article

Source: [Bridge on X](https://x.com/bridge_surf/status/2057416247319618039)
Author: [@bridge_surf](https://x.com/bridge_surf)
Posted: 5:00 AM · May 21, 2026
Scraped: May 22, 2026
Observed engagement at scrape time: 8 replies, 43 reposts, 553 likes, 750 bookmarks, 59.2K views

Bridge describes a macOS computer-use stack where an AI agent can click, type,
and read background windows without taking over the user's active cursor or
frontmost app. The key claim is that the second cursor shown in demos is mostly
visual theater; the useful mechanism is background window interaction.

The article frames the problem as three layers:

1. Use the macOS Accessibility API as the primary interface where it is reliable.
2. Fall back to `CGEvent.postToPid` for direct mouse and keyboard event delivery.
3. Make a background window internally believe it is active while preventing the
   visible frontmost-app switch.

Bridge also notes that the technique depends on low-level macOS window-system
behavior, may rely on bugs, and works unevenly across apps.

## Links from the article

- [OpenAI Codex computer use release](https://openai.com/zh-Hans-CN/index/codex-for-almost-everything/)
- [cua driver article](https://github.com/trycua/cua/blob/main/blog/inside-macos-window-internals.md)
- [kwwk-computer-use-core](https://github.com/EYHN/kwwk-computer-use-core)
- [`BackgroundInputDispatcher.swift`](https://github.com/EYHN/kwwk-computer-use-core/blob/main/Sources/KWWKComputerUseCore/BackgroundInputDispatcher.swift)
- [`BackgroundActivationSession.swift`](https://github.com/EYHN/kwwk-computer-use-core/blob/main/Sources/KWWKComputerUseCore/BackgroundActivationSession.swift)
- [`ComputerUseSession.swift`](https://github.com/EYHN/kwwk-computer-use-core/blob/main/Sources/KWWKComputerUseCore/ComputerUseSession.swift)
- [Bridge waiting list](https://bridge.surf/)

## Accessibility API first

Bridge treats Accessibility, usually called AX, as the primary mechanism for
computer use on macOS. With permission, AX can read UI state and invoke actions
without moving the real cursor or making the target window frontmost.

The article lists these AX capabilities:

- Read windows and traverse the AX tree.
- Read properties such as role, title, frame, and value.
- Press native AppKit buttons with `AXPress`.
- Set native text-field values with `setValue`.
- Move scrollbars with `AXIncrement` and `AXDecrement`.

For native apps such as TextEdit, Finder, and System Settings, this can be enough
for a whole task chain: read the AX tree, find the element, and invoke the
relevant action.

AX is not enough for every app:

- Chrome and Electron background windows can expose incomplete AX trees.
- `AXPress` can be unreliable in those apps.
- Character-by-character keyboard input still needs event delivery through
  `postToPid`.

## Direct events with `CGEvent.postToPid`

When AX is not enough, Bridge sends events directly to the target process with
`CGEvent.postToPid`. The article says the private `SLEventPostToPid` path from
the cua article is not the important part; `CGEvent.postToPid` was sufficient in
Bridge's testing.

The high-level flow is:

1. Find the target process ID, window number, and control coordinates.
2. Create mouse or keyboard `CGEvent`s.
3. Fill target-process and window-addressing fields so macOS can deliver the
   event to the intended window.
4. Send the event with `postToPid`.

A left click is modeled as a down/up event pair with roughly these fields:

```text
leftMouseDown:
  location = screenPoint
  button = left
  clickState = 1
  pressure = 1
  targetPID = pid
  windowUnderMouse = windowNumber
  windowThatCanHandle = windowNumber
  private field 51 = windowNumber
  private field 58 = 1
  CGEventSetWindowLocation = quartz window-local point
  postToPid(pid)

30ms delay

leftMouseUp:
  same target/window/location fields
  pressure = 0
  postToPid(pid)
```

The concrete implementation is linked as `BackgroundInputDispatcher.swift`.

## Background window activation

Direct event delivery alone does not guarantee that the target app will process
the click. Many apps first check whether their window is key, main, or focused.
Background windows do not satisfy those checks by default, so events may be
dropped.

Bridge's solution is to make the target process enter an internal activated
state without visually bringing that app forward. The user-facing app remains
frontmost, but the target app behaves as if it can receive clicks, typing, and
AX reads.

The article describes this as two separate concerns:

- Let the target app receive an activation path.
- Suppress the normal deactivation/focus-switch messages that would disturb the
  app the user is actively using.

### Center-primer click

Bridge sends a `postToPid` click to the center of the target window. This is
intended to trigger the app/window activation path without triggering a real UI
action.

Important details:

- The center of the window is used to avoid controls such as traffic-light
  buttons.
- The first click into an inactive window usually activates the window before
  running a control-specific action.
- Top-left traffic-light buttons should be avoided because they may respond even
  when the window is inactive.

### Focus-message interception

Before the activation click, Bridge installs per-process event taps with
`CGEvent.tapCreateForPid`.

Two taps are installed:

- `previous`: the current frontmost app, which the user is actively using.
- `target`: the background app the agent wants to control.

The taps listen broadly, then filter focus messages inside the callback. The
article says focus messages do not have stable public `CGEventType` names, so
Bridge identifies them by raw values: `13`, `19`, and `20`.

The filter rule is:

```text
if isFocusMessage(type) && event is headed to previous app:
  return nil          // suppress deactivation
return event          // allow target activation
```

This allows the target's activation to proceed while preventing the user's
frontmost app from seeing the deactivation path.

## `appKitDefined` primer

Bridge also sends an `NSEvent.otherEvent` to the target process before the
center-primer click:

- Type: `appKitDefined`
- Subtype: `1`, which public headers map to `applicationActivated`
- Delivery: directly into the target process queue via `postToPid`
- Window addressing: includes the `windowNumber` and private field writes `51`
  and `58`

The article describes this as telling the target app ahead of time that it
should enter the activated state. At the end, subtype `2`
(`applicationDeactivated`) is sent to return the target to a background state.
Bridge notes that the exact internal handler path is not publicly documented and
was validated through testing.

## Complete operation flow

The operation described by Bridge is:

1. Create a `BackgroundActivationSession`.
2. Install event taps for the previous frontmost app and the target app.
3. Activate the target window using the `appKitDefined` primer plus center
   primer.
4. Perform real clicks, typing, or scrolling.
5. Keep taps running until the session ends so later operations do not steal
   focus.
6. Skip the activation flow if the target app is already frontmost or was already
   activated by the agent.

Bridge mentions `FrontmostApplicationMonitor` as the component that keeps state
in sync when the user manually switches apps or the agent operates in the
background.

## Contrast with the cua article

Bridge says the earlier cua driver article reproduced a Codex-like background
computer-use system soon after Codex computer use launched, but also says it
omitted some key implementation details and leaned heavily on private
`SkyLight.framework` APIs.

Bridge's reported alternative is:

- Use AX when possible.
- Use `CGEvent.postToPid` for event delivery.
- Use a combination of `appKitDefined` primer, center-primer click, and
  per-process focus-message event taps for background activation.

Bridge claims this approach was simpler and more stable in its testing than the
private SkyLight-based path, and worked across every app it tested.

## Caveats

- This is based on low-level macOS window-system behavior.
- Some behavior may be undocumented or bug-dependent.
- The approach may work in some apps and fail in others.
- The exact AppKit activation/deactivation handler path is not publicly
  documented.
- Raw focus event type values may vary across macOS versions.
