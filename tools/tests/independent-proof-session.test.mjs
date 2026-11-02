import assert from "node:assert/strict";
import { test as nodeTest } from "node:test";
import { IndependentProofSession } from "../../lib/independent-proof-session.mjs";

const mac = { skip: process.platform !== "darwin", timeout: 30_000 };
/** @typedef {import("../../lib/independent-proof-session.mjs").ProofTarget} ProofTarget */
/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
/** @param {unknown} result @returns {Record<string, unknown>} */
const independentOf = (result) => {
  const record = isRecord(result) ? result : {};
  const details = isRecord(record.details) ? record.details : {};
  return isRecord(details.independent) ? details.independent : {};
};
/** @param {Record<string, unknown>} independent @returns {Record<string, unknown>} */
const executionOf = (independent) => {
  const execution = independent.execution;
  return isRecord(execution) ? execution : {};
};
/** @param {unknown} result @returns {unknown} */
const value = (result) => executionOf(independentOf(result)).value;
/** @param {Record<string, unknown>} independent @returns {Array<Record<string, unknown>>} */
const nativeActionsOf = (independent) => {
  const actions = independent.nativeActions;
  if (!Array.isArray(actions)) {
    return [];
  }
  return actions.filter((action) => isRecord(action));
};
/** @param {Record<string, unknown>} independent @returns {Record<string, unknown>} */
const settlementOf = (independent) => {
  const settlement = independent.settlement;
  return isRecord(settlement) ? settlement : {};
};

nodeTest(
  "proof adapter preserves isolated expressions and returns authoritative mirrored refusal without native target",
  mac,
  async () => {
    const previous = process.env.MACUSE_INDEPENDENT_PROOF_TARGET;
    delete process.env.MACUSE_INDEPENDENT_PROOF_TARGET;
    const session = new IndependentProofSession();
    if (previous !== undefined) {
      process.env.MACUSE_INDEPENDENT_PROOF_TARGET = previous;
    }
    try {
      assert.equal(value(await session.execute({ code: "var retained = 40; retained + 2" })), 42);
      const denied = await session.execute({
        code: "macuse.call('observe', {app:'unrelated.app'}); 42",
        apps: ["unrelated.app"],
      });
      assert.equal(denied.isError, true);
      assert.equal(independentOf(denied).isError, true);
      const deniedActions = nativeActionsOf(independentOf(denied));
      const refusal = deniedActions[0];
      if (refusal === undefined) {
        assert.fail("Expected a refused native action");
      }
      assert.equal(refusal.mutationAttempted, false);
      assert.match(String(refusal.error), /operator-configured/);
      assert.equal(independentOf(denied).priorUnknown, false);
      assert.equal(value(denied), 42, "guest completion cannot certify a refused native request");
      const textBlock = denied.content.find((block) => block.type === "text");
      if (textBlock === undefined) {
        assert.fail("Expected text content");
      }
      /** @type {unknown} */
      const parsedVisible = JSON.parse(textBlock.text);
      const visible = isRecord(parsedVisible) ? parsedVisible : {};
      const evidenceList = visible.nativeEvidence;
      assert.ok(
        Array.isArray(evidenceList),
        "model-facing content must retain trusted native evidence even when guest ignores it",
      );
      /** @type {unknown} */
      const firstEvidence = evidenceList[0];
      if (firstEvidence === undefined) {
        assert.fail("Expected a native evidence entry");
      }
      if (!isRecord(firstEvidence)) {
        assert.fail("Expected a native evidence record");
      }
      assert.match(String(firstEvidence.error), /operator-configured/);
      assert.equal(firstEvidence.mutationAttempted, false);
      const reset = await session.reset();
      assert.equal(reset.isError, false);
      assert.equal(settlementOf(independentOf(reset)).settled, true);
      assert.equal(value(await session.execute({ code: "typeof retained" })), "undefined");
    } finally {
      const stopped = await session.stop();
      assert.equal(stopped.workerStopped, true);
      assert.equal(stopped.nativeStopped, true);
      assert.equal(stopped.hostCallsPending, 0);
      assert.equal(stopped.settled, true);
    }
  },
);

nodeTest(
  "trusted proof target scopes reads and rejects guest authorization/identity fields before native access",
  mac,
  async () => {
    const target = {
      bundleId: "com.macuse.actuator-fixture.00000000-0000-0000-0000-000000000000",
      pid: 12345,
      path: "/not/a/real/ActuatorFixture.app",
    };
    const session = new IndependentProofSession({ target });
    target.bundleId = "mutated.after.construction";
    try {
      for (const [
        params,
        apps,
        pattern,
      ] of /** @type {[Record<string, unknown>, string[], RegExp][]} */ ([
        [{ app: "unrelated.app" }, ["unrelated.app"], /exact trusted target/],
        [
          { app: "com.macuse.actuator-fixture.00000000-0000-0000-0000-000000000000" },
          ["com.macuse.actuator-fixture.00000000-0000-0000-0000-000000000000", "unrelated.app"],
          /exact trusted target/,
        ],
        [
          {
            app: "com.macuse.actuator-fixture.00000000-0000-0000-0000-000000000000",
            allowMutating: true,
          },
          ["com.macuse.actuator-fixture.00000000-0000-0000-0000-000000000000"],
          /Unsupported guest fields/,
        ],
        [
          {
            app: "com.macuse.actuator-fixture.00000000-0000-0000-0000-000000000000",
            expectedPid: 12345,
          },
          ["com.macuse.actuator-fixture.00000000-0000-0000-0000-000000000000"],
          /Unsupported guest fields/,
        ],
      ])) {
        const result = await session.execute({
          code: `macuse.call('observe', ${JSON.stringify(params)})`,
          apps,
        });
        assert.equal(result.isError, true);
        assert.equal(independentOf(result).isError, true);
        const refusal = nativeActionsOf(independentOf(result))[0];
        if (refusal === undefined) {
          assert.fail("Expected a refused native action");
        }
        assert.equal(refusal.mutationAttempted, false);
        assert.match(String(refusal.error), pattern);
      }
    } finally {
      await session.stop();
    }
  },
);

nodeTest(
  "proof reset refuses concurrent admission, invalidates queued execution and drains actual owned worker",
  mac,
  async () => {
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
      assert.equal(settlementOf(independentOf(cleared)).settled, true);
      assert.equal(value(await session.execute({ code: "typeof retained" })), "undefined");
    } finally {
      await session.stop();
    }
  },
);

nodeTest(
  "proof operator target configuration rejects malformed identities without starting native services",
  () => {
    const valid = {
      bundleId: "com.macuse.actuator-fixture.00000000-0000-0000-0000-000000000000",
      pid: 12345,
      path: "/not/a/real/ActuatorFixture.app",
    };
    for (const target of /** @type {unknown[]} */ ([
      {},
      { ...valid, bundleId: "com.apple.TextEdit" },
      { ...valid, pid: -1 },
      { ...valid, path: "ActuatorFixture.app" },
      { ...valid, path: "/not/a/real/Other.app" },
      { ...valid, windowTitle: "unrelated window" },
      { ...valid, allowMutating: true },
    ])) {
      // Deliberately malformed identities must reach the constructor's own validation.
      // oxlint-disable-next-line no-unsafe-type-assertion -- QX-006: Test intentionally passes invalid input.
      const malformed = /** @type {ProofTarget} */ (target);
      assert.throws(
        () => new IndependentProofSession({ target: malformed }),
        /trusted proof target/,
      );
    }
  },
);
