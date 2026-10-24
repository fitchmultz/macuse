import assert from "node:assert/strict";
import { test } from "node:test";
import { IndependentProofSession } from "../../lib/independent-proof-session.mjs";

const mac = { skip: process.platform !== "darwin", timeout: 30_000 };
const value = result => result.details.independent.execution.value;

test("proof adapter preserves isolated expressions and returns authoritative mirrored refusal without native target", mac, async () => {
  const previous = process.env.MACUSE_INDEPENDENT_PROOF_TARGET;
  delete process.env.MACUSE_INDEPENDENT_PROOF_TARGET;
  const session = new IndependentProofSession();
  if (previous !== undefined) process.env.MACUSE_INDEPENDENT_PROOF_TARGET = previous;
  try {
    assert.equal(value(await session.execute({ code: "var retained = 40; retained + 2" })), 42);
    const denied = await session.execute({ code: "macuse.call('observe', {app:'unrelated.app'}); 42", apps: ["unrelated.app"] });
    assert.equal(denied.isError, true);
    assert.equal(denied.details.independent.isError, true);
    assert.equal(denied.details.independent.nativeActions[0].mutationAttempted, false);
    assert.match(denied.details.independent.nativeActions[0].error, /operator-configured/);
    assert.equal(denied.details.independent.priorUnknown, false);
    assert.equal(value(denied), 42, "guest completion cannot certify a refused native request");
    const visible = JSON.parse(denied.content.find(block => block.type === "text").text);
    assert.ok(Array.isArray(visible.nativeEvidence), "model-facing content must retain trusted native evidence even when guest ignores it");
    assert.match(visible.nativeEvidence[0].error, /operator-configured/);
    assert.equal(visible.nativeEvidence[0].mutationAttempted, false);
    const reset = await session.reset();
    assert.equal(reset.isError, false);
    assert.equal(reset.details.independent.settlement.settled, true);
    assert.equal(value(await session.execute({ code: "typeof retained" })), "undefined");
  } finally {
    const stopped = await session.stop();
    assert.equal(stopped.workerStopped, true);
    assert.equal(stopped.nativeStopped, true);
    assert.equal(stopped.hostCallsPending, 0);
    assert.equal(stopped.settled, true);
  }
});

test("trusted proof target scopes reads and rejects guest authorization/identity fields before native access", mac, async () => {
  const target = { bundleId: "com.macuse.actuator-fixture.00000000-0000-0000-0000-000000000000", pid: 12345, path: "/not/a/real/ActuatorFixture.app" };
  const session = new IndependentProofSession({ target });
  target.bundleId = "mutated.after.construction";
  try {
    for (const [params, apps, pattern] of [
      [{ app: "unrelated.app" }, ["unrelated.app"], /exact trusted target/],
      [{ app: "com.macuse.actuator-fixture.00000000-0000-0000-0000-000000000000" }, ["com.macuse.actuator-fixture.00000000-0000-0000-0000-000000000000", "unrelated.app"], /exact trusted target/],
      [{ app: "com.macuse.actuator-fixture.00000000-0000-0000-0000-000000000000", allowMutating: true }, ["com.macuse.actuator-fixture.00000000-0000-0000-0000-000000000000"], /Unsupported guest fields/],
      [{ app: "com.macuse.actuator-fixture.00000000-0000-0000-0000-000000000000", expectedPid: 12345 }, ["com.macuse.actuator-fixture.00000000-0000-0000-0000-000000000000"], /Unsupported guest fields/],
    ]) {
      const result = await session.execute({ code: `macuse.call('observe', ${JSON.stringify(params)})`, apps });
      assert.equal(result.isError, true);
      assert.equal(result.details.independent.isError, true);
      const refusal = result.details.independent.nativeActions[0];
      assert.equal(refusal.mutationAttempted, false);
      assert.match(refusal.error, pattern);
    }
  } finally { await session.stop(); }
});

test("proof reset refuses concurrent admission, invalidates queued execution and drains actual owned worker", mac, async () => {
  const session = new IndependentProofSession();
  try {
    await session.execute({ code: "var retained = 1" });
    const loop = session.execute({ code: "while(true){}" });
    const queued = session.execute({ code: "retained = 99" });
    const reset = session.reset();
    assert.throws(() => session.execute({ code: "1" }), /stopping\/resetting/);
    const [first, second, cleared] = await Promise.all([loop, queued, reset]);
    assert.equal(first.isError, true);
    assert.equal(second.isError, true);
    assert.equal(cleared.details.independent.settlement.settled, true);
    assert.equal(value(await session.execute({ code: "typeof retained" })), "undefined");
  } finally { await session.stop(); }
});

test("proof operator target configuration rejects malformed identities without starting native services", () => {
  const valid = { bundleId: "com.macuse.actuator-fixture.00000000-0000-0000-0000-000000000000", pid: 12345, path: "/not/a/real/ActuatorFixture.app" };
  for (const target of [{}, { ...valid, bundleId: "com.apple.TextEdit" }, { ...valid, pid: -1 },
    { ...valid, path: "ActuatorFixture.app" }, { ...valid, path: "/not/a/real/Other.app" },
    { ...valid, windowTitle: "unrelated window" }, { ...valid, allowMutating: true }]) {
    assert.throws(() => new IndependentProofSession({ target }), /trusted proof target/);
  }
});
