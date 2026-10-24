# Owned-fixture session proof

`IndependentProofSession` connects the [isolated executor](isolated-executor-proof.md)
to the source-owned AX actuator. It is a separate, explicitly opt-in research
session, not the backend for `macuse` or a claim of arbitrary-app/API parity.
The production Pi manifest, CLI, MCP tools, recording, and history are unchanged.

This class registers no tools. Optional transports are a separate integration
and must use distinct names without changing production defaults. Loading the
module does not launch a native process. A pure JavaScript expression needs no
configured app target.
System JavaScriptCore follows macOS updates; this does not independently pin
Apple's engine or frameworks.

## Trusted target and guest API

The operator supplies `{bundleId,pid,path,windowTitle?}` to the constructor or as
JSON in `MACUSE_INDEPENDENT_PROOF_TARGET`. The app must use the owned fixture's
`com.macuse.actuator-fixture.<UUID>` namespace. Use the canonical bundle path and
PID returned by `startActuatorFixture()` from `tools/actuator-fixture.mjs`.
The bundle path must end in `ActuatorFixture.app`; the window must have the
fixture's fixed title. An optional `windowTitle` must equal that same title.
This configuration is **not** a guest/tool argument.

Every native read and action must name exactly this target in both its params
and the parent run's sole `apps` entry. Native identity checks happen before
reading AX content. A first valid native observation pins process-birth
identity for subsequent observations, including after reset. No fuzzy app
matching, unrelated app enumeration, or whole-desktop screenshot fallback is
provided. A missing target refuses all native access.

Guest code uses only these registered capabilities:

```js
var state = macuse.call("observe", {app: "com.macuse.actuator-fixture.<UUID>"});
var image = macuse.call("screenshot", {
  app: state.app.bundleId,
  observationId: state.observationId,
  windowToken: state.windows[0].token
});
```

`act` takes `{app,observationId,elementToken,action,value?}`. Only `press` and
intended whole-field `setValue` are implemented; this is not selected-range
insertion or general keyboard/pointer parity. Mutation authorization and the
safety note come only from the trusted run envelope. Extra capability fields,
including guest authorization/expected-identity flags, are refused.
All native mutations invalidate the observation; observe again before acting.
Ordinary JavaScript declarations and Promise expressions work. Top-level
`await` and the vendor `cua` API do not.

## Evidence and images

Tool results preserve `content`, `isError`, and matching
`details.independent.isError`. The machine-readable guest completion is
`details.independent.execution.value`: it is untrusted program output, not
native effect evidence. `nativeActions` separately retains actual attempted,
refused, accepted, verified, or unknown native outcomes.
Trusted `nativeEvidence` summaries also appear in the text content consumed by
models, even when guest code ignores a refusal or returns an unrelated value.
There are at most 100 capability calls; each summarized error is capped at 256
characters. Full native records remain in details, not reclassified by guest
output.

Successful AXPress means native acceptance and requires fresh inspection.
`verified:false` alone does not make an accepted press unknown. An attempted
unverified/unknown mutation latches mutation refusal, stops/drains owned native
work, and remains a tool error even when guest code catches its exception.
Guard refusals remain errors but do not pretend a mutation was attempted.

Screenshot bytes never enter guest JSON or a guest-selected filesystem path.
Guest code gets a random per-run handle and bounded metadata; the trusted
parent appends the actual PNG image block. `details.independent.images` maps
each handle to its content index, SHA-256, dimensions, byte count, native window
ID/frame, capture rectangle, and point/pixel scale. Native mapping metadata,
PNG signature/header dimensions, and operator-observed window identity are
validated before delivery. No universal pointer or focus isolation is inferred.

A run admits at most two capture attempts and retains at most 24,000,000 decoded
image bytes, reserving the full 12,000,000-byte native ceiling before each
capture. Dimensions are at most 8192 per side and 16,000,000 pixels. Session
state retains no screenshot bytes after returning the result; the consuming
host owns tool-result/history retention. Old handles are not retrievable.

## Stop and reset

The session owns both subprocesses and actual capability promises. Interruption
stops the native helper and awaits those promises, not just the executor's
earlier worker-exit receipt. Stop reports final worker/native/pending-call
settlement. Reset blocks admission, invalidates queued work, clears bindings and
observations, and requires a fresh observation before any later action.
`priorUnknown` survives reset: reset never undoes a GUI effect or authorizes
automatic replay.

The offline/native process contract check is:

```sh
node --test tools/tests/independent-proof-session.test.mjs
```

Actual fixture/transport qualification is separate. Hard memory isolation,
deprecated Seatbelt availability, signed deployment/TCC support, broad app
coverage, selected-text/keyboard/pointer parity, and recording/history are
still production gates.
