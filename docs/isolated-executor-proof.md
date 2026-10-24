# Independent executor proof

`IsolatedExecutor` is an opt-in research primitive, not a replacement backend or a
new Pi, CLI, or MCP tool. Production macuse still uses the vendor runtime. This
proof has no built-in app-control capability and never starts ChatGPT, Codex, Sky,
recording, or history.

## What it proves

On macOS with `xcrun swiftc`, a source-hash-cached native child uses the system
JavaScriptCore framework. No Node runtime, vendor kernel, JavaScript dependency,
general Objective-C bridge, module loader, file, network, or process API is exposed
to guest code. Persistent declarations survive successive evaluations in one
child. Standard Promise expressions work; top-level `await` and the vendor's
`cua` convenience API are not implemented.

Before admitting code, the child installs a deny-default Seatbelt sandbox and
actually checks denial of reading a parent-created sentinel, creating a file,
connecting to a loopback socket, and executing `/usr/bin/true`. A failed or
unavailable sandbox/probe prevents startup. Seatbelt's initialization API is
deprecated: this proof does not establish its future availability or substitute
for a production signed/sandboxed deployment design.

Guest code can call only `macuse.call(method, params)`. Registered trusted parent
capabilities explicitly declare whether they mutate. Mutation dispatch requires
the parent-supplied `allowMutating`, exact app scope, and safety note; guest
parameters cannot supply that envelope. These flags are not user permission.
Each real capability must also enforce its own schema, fresh observation,
document/element identity, and exact operation authorization. There is no
production actuator integration in this proof.

```js
import { IsolatedExecutor } from "../lib/isolated-executor.mjs";

const executor = new IsolatedExecutor({ capabilities: {
  inspect: { mutating: false, invoke: async params => ({ requested: params.app }) },
} });
try {
  const result = await executor.execute({
    code: "var state = macuse.call('inspect', {app:'example.exact'}); state",
  });
  console.log(result);
} finally {
  await executor.stop();
}
```

The RPC transport is synchronous inside JavaScript, but the parent capability
can be asynchronous. Results are JSON data, never callable host objects. Native
framing and parent-side run/call identity checks prevent guest text from
impersonating protocol messages. A run permits at most 100 calls and each
protocol message is limited to 65,536 bytes. Execution is serialized.

## Interruption and resource limits

Wall deadlines (50–30,000 ms), abort, protocol violations, and memory-monitor
failures terminate only the owned child. Stop awaits that child's exit and
invalidates queued work. It does **not** undo or prove cancellation of a
previously dispatched host capability. Host callbacks receive an abort signal;
unknown/throwing dispatches retain partial evidence and permanently block this
instance's mutation capabilities. While a host callback remains pending, all
new executions are refused. A stopped child is not replayed automatically.
`stop()` reports `workerStopped`, `settled`, and `hostCallsPending` rather than
falsely claiming pending callbacks have settled; real actuator owners must
separately settle their owned native work. Calls admitted while stop is in
progress are refused. After a settled stop, fresh execution creates a new worker.

The parent monitors child RSS approximately every 50 ms (default budget 256 MiB,
configurable down to 32 MiB). This is **not a hard heap/memory guarantee**:
allocation can overshoot between samples. Polling, process startup, and compiler
resource use are not hard bounded. Resource-denial resistance remains a
production qualification gate, not a passed security claim.

Run the real process-boundary proof:

```sh
node --test tools/tests/isolated-executor.test.mjs
```

Non-macOS hosts skip these native checks explicitly. The suite exercises actual
JSC/Seatbelt startup, persistence, asynchronous RPC, ambient-host escapes,
authorization refusal, deadlines, protocol/output bounds, RSS interruption,
unknown pending dispatch, and owned-process cleanup. It does not touch app UI.

## Still required before production

Independent native actuator integration; structured observation/target guards;
safe API parity and documentation; fresh-process Pi/CLI/MCP lifecycle and focus
qualification; signed helper/TCC deployment; stronger resource isolation;
independent review of this engine/bridge/sandbox boundary; and separate handling
of recording/history. Passing this proof alone is not full macuse independence.
