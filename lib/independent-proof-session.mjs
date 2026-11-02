import { randomUUID } from "node:crypto";
import { authorizeProof, fields } from "./independent-proof-authorization.mjs";
import { ProofRun } from "./independent-proof-run.mjs";
import {
  png,
  targetConfiguration,
  validateNativeObservation,
  validateScreenshotMapping,
  maxRunImageBytes,
} from "./independent-proof-validation.mjs";
import { IsolatedExecutor } from "./isolated-executor.mjs";
import { validateEnvelope } from "./cua-guard-service.mjs";
import { NativeActuator } from "../tools/native-actuator.mjs";

/**
 * @typedef {{ bundleId: string, pid: number, path: string, windowTitle: string }} ResolvedTarget
 * The last accepted native observation, typed at the validation boundary.
 * @typedef {{ observationId: unknown, app: Record<string, unknown>, windows: Record<string, unknown>[], elements: Record<string, unknown>[] }} ObservedNative
 * The executor settlement fields #result consumes.
 * @typedef {{ isError: boolean, value?: unknown, error?: string | undefined }} ExecutionSettlement
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
/**
 * @param {boolean} unknownEffect
 * @param {boolean} failed
 * @returns {"unknown" | "failed" | "completed"}
 */
const outcomeOf = (unknownEffect, failed) => {
  if (unknownEffect) {
    return "unknown";
  }
  if (failed) {
    return "failed";
  }
  return "completed";
};

/** Explicit opt-in owned-target integration. Never imported by production MacuseSession. */
export class IndependentProofSession {
  /** @readonly @type {ResolvedTarget | undefined} */
  #target;
  /** @type {string | undefined} */
  #processStartToken;
  /** @readonly */
  #native = new NativeActuator();
  /** @type {IsolatedExecutor} */
  #executor;
  /** @type {ObservedNative | undefined} */
  #observed;
  /** @readonly @type {Set<Promise<unknown>>} */
  #calls = new Set();
  /** @type {ProofRun | undefined} */
  #active;
  /** @type {Promise<unknown>} */
  #tail = Promise.resolve();
  /** @type {Promise<import("./independent-proof-session.mjs").ProofSettlement> | undefined} */
  #closing;
  /** @type {Promise<import("./independent-proof-session.mjs").ProofResult> | undefined} */
  #resetting;
  #generation = 0;
  #priorUnknown = false;
  #mutationBlocked = false;

  /**
   * @param {{ target?: unknown }} [options]
   */
  constructor({ target } = {}) {
    this.#target = targetConfiguration(target);
    this.#executor = this.#newExecutor();
  }

  #newExecutor() {
    return new IsolatedExecutor({
      capabilities: Object.fromEntries(
        Object.keys(fields).map((method) => [
          method,
          {
            mutating: method === "act",
            invoke: (params, context) => this.#invoke(method, params, context),
          },
        ]),
      ),
    });
  }

  /**
   * @param {string} method
   * @param {unknown} params
   * @param {import("./isolated-executor.mjs").ExecutorCallContext} context
   * @returns {Promise<unknown>}
   */
  #invoke(method, params, context) {
    if (!isRecord(params)) {
      throw new Error("Guest capability params must be an object.");
    }
    const task = this.#perform(method, params, context);
    this.#calls.add(task);
    return task.finally(() => {
      this.#calls.delete(task);
    });
  }

  /**
   * @param {ProofRun} run
   * @param {string} method
   * @param {unknown} error
   * @returns {{ status: string, mutationAttempted: boolean, outcome: string, error: string }}
   */
  #refuse(run, method, error) {
    const detail = isRecord(error) && typeof error.message === "string" ? error.message : error;
    const result = {
      status: "refused",
      mutationAttempted: false,
      outcome: "not-dispatched",
      error: String(detail),
    };
    run.nativeActions.push({ method, ...result });
    return result;
  }

  /**
   * @param {string} method
   * @param {Record<string, unknown>} params
   * @param {import("./isolated-executor.mjs").ExecutorCallContext} context
   * @returns {Promise<unknown>}
   */
  async #perform(method, params, context) {
    const run = this.#active;
    const target = this.#target;
    try {
      authorizeProof(method, params, context, {
        run,
        target,
        observed: this.#observed,
        generation: this.#generation,
        mutationBlocked: this.#mutationBlocked,
      });
    } catch (error) {
      if (run === undefined) {
        throw error;
      }
      run.failed = true;
      return this.#refuse(run, method, error);
    }
    if (run === undefined || target === undefined) {
      throw new Error("Proof target or run unavailable.");
    }
    try {
      if (method === "observe") {
        return await this.#observe(params, context, run, target);
      }
      if (method === "screenshot") {
        return await this.#screenshot(params, context, run, target);
      }
      return await this.#act(params, context, run, target);
    } catch (error) {
      if (await this.#recordNativeError(error, method, params, { run, target })) {
        throw error;
      }
      return this.#refuse(run, method, error);
    }
  }

  /**
   * @param {unknown} error
   * @param {string} method
   * @param {Record<string, unknown>} params
   * @param {{ run: ProofRun, target: ResolvedTarget }} state
   * @returns {Promise<boolean>}
   */
  async #recordNativeError(error, method, params, state) {
    const { run, target } = state;
    this.#observed = undefined;
    const record = isRecord(error) ? error : undefined;
    const recorded = record !== undefined && Boolean(record.recorded);
    if (method === "act" && (recorded || record?.dispatched !== false)) {
      if (!recorded) {
        run.nativeActions.push({
          method,
          app: target.bundleId,
          action: params.action,
          mutationAttempted: true,
          status: "unknown",
          outcome: "unknown",
          error: String(record?.message),
        });
      }
      this.#mutationBlocked = true;
      this.#priorUnknown = true;
      run.markUnknown();
      run.fail();
      await this.#native.stop();
      return true;
    }
    run.fail();
    return false;
  }

  /**
   * @param {Record<string, unknown>} params
   * @param {import("./isolated-executor.mjs").ExecutorCallContext} context
   * @param {ProofRun} run
   * @param {ResolvedTarget} target
   * @returns {Promise<unknown>}
   */
  async #observe(params, context, run, target) {
    const stale = () => run.generation !== this.#generation;
    const aborted = () => context.signal.aborted;
    this.#observed = undefined;
    const result = await this.#native.observe(
      {
        app: target.bundleId,
        expectedPid: target.pid,
        expectedPath: target.path,
        ...(this.#processStartToken !== undefined
          ? { expectedProcessStartToken: this.#processStartToken }
          : {}),
      },
      { signal: context.signal },
    );
    const { app, observationId, windows, elements } = validateNativeObservation(
      result,
      target,
      this.#processStartToken,
    );
    if (aborted() || stale()) {
      throw Object.assign(new Error("Observation completed after cancellation; discarded."), {
        dispatched: false,
      });
    }
    this.#processStartToken ??= app.processStartToken;
    this.#observed = {
      observationId,
      app,
      windows: windows.filter(isRecord),
      elements: elements.filter(isRecord),
    };
    run.observations.push({
      observationId,
      app,
      windows,
    });
    return result;
  }

  /**
   * @param {Record<string, unknown>} params
   * @param {import("./isolated-executor.mjs").ExecutorCallContext} context
   * @param {ProofRun} run
   * @param {ResolvedTarget} target
   * @returns {Promise<unknown>}
   */
  async #screenshot(params, context, run, target) {
    const stale = () => run.generation !== this.#generation;
    const aborted = () => context.signal.aborted;
    const observed = this.#observed;
    run.reserveCapture();
    const result = await this.#native.screenshot(
      {
        app: target.bundleId,
        observationId: params.observationId,
        windowToken: params.windowToken,
      },
      { signal: context.signal },
    );
    if (aborted() || stale()) {
      throw Object.assign(new Error("Screenshot completed after cancellation; discarded."), {
        dispatched: false,
      });
    }
    if (
      !isRecord(result) ||
      result.windowToken !== params.windowToken ||
      result.coordinateSpace !== "screenshot-pixels"
    ) {
      throw new Error("Native screenshot target/coordinate identity changed.");
    }
    const { data, ...metadata } = png(result.image);
    const window = observed?.windows.find(
      (/** @type {Record<string, unknown>} */ entry) => entry.token === params.windowToken,
    );
    validateScreenshotMapping(result, window, metadata);
    const { windowFrame, captureRect } = result;
    if (run.imageBytes + metadata.bytes > maxRunImageBytes) {
      throw new Error("Per-run decoded image budget exhausted.");
    }
    const receipt = {
      handle: randomUUID(),
      contentIndex: run.images.length + 1,
      windowToken: result.windowToken,
      windowId: result.windowId,
      windowFrame,
      captureRect,
      pointPixelScale: result.pointPixelScale,
      coordinateSpace: result.coordinateSpace,
      ...metadata,
    };
    run.chargeImage(metadata.bytes);
    run.images.push({
      receipt,
      content: { type: "image", mimeType: "image/png", data },
    });
    return receipt;
  }

  /**
   * @param {Record<string, unknown>} params
   * @param {import("./isolated-executor.mjs").ExecutorCallContext} context
   * @param {ProofRun} run
   * @param {ResolvedTarget} target
   * @returns {Promise<unknown>}
   */
  async #act(params, context, run, target) {
    const method = "act";
    const result = await this.#native.act(
      {
        app: target.bundleId,
        observationId: params.observationId,
        elementToken: params.elementToken,
        action: params.action,
        ...(params.action === "setValue" ? { value: params.value } : {}),
        allowMutating: true,
        safetyNote: context.envelope.safetyNote,
      },
      { signal: context.signal },
    );
    const native = isRecord(result) ? result : {};
    this.#observed = undefined;
    run.nativeActions.push({
      method,
      app: target.bundleId,
      action: params.action,
      elementToken: params.elementToken,
      ...native,
    });
    const accepted =
      native.mutationAttempted === true &&
      native.status === "applied" &&
      native.nativeAccepted === true &&
      (params.action === "press"
        ? native.outcome === "requires-fresh-observation"
        : native.verified === true && native.outcome === "verified");
    if (!accepted) {
      this.#mutationBlocked = true;
      this.#priorUnknown = true;
      run.markUnknown();
      throw Object.assign(
        new Error(
          "Native mutation outcome is unknown/unverified. Inspect fresh state; never replay.",
        ),
        { recorded: true },
      );
    }
    return native;
  }

  /**
   * @param {unknown} input
   * @param {{ signal?: AbortSignal }} [options]
   * @returns {Promise<import("./independent-proof-session.mjs").ProofResult>}
   */
  execute(input, { signal } = {}) {
    if (this.#closing !== undefined || this.#resetting !== undefined) {
      throw new Error("Proof session is stopping/resetting; no execution admitted.");
    }
    validateEnvelope(input);
    const saved = structuredClone(input);
    const generation = this.#generation;
    const task = this.#tail.then(() => this.#run(saved, signal, generation));
    this.#tail = task.catch(() => null);
    return task;
  }

  /**
   * @param {ExecutionSettlement} execution
   * @param {ProofRun} run
   * @returns {import("./independent-proof-session.mjs").ProofResult}
   */
  #result(execution, run) {
    const isError = execution.isError || run.failed || run.unknown;
    // Providers consume content, not details. Guest completion must not hide a
    // refusal, unknown effect, or accepted-but-not-verified AXPress.
    const nativeEvidence = run.nativeActions.map((action) => {
      const errorPresent = Boolean(action.error);
      const verificationErrorPresent = Boolean(action.verificationError);
      return {
        method: action.method,
        app: action.app,
        elementToken: action.elementToken,
        action: action.action,
        status: action.status,
        mutationAttempted: action.mutationAttempted,
        nativeAccepted: action.nativeAccepted,
        verified: action.verified,
        outcome: action.outcome,
        ...(errorPresent ? { error: String(action.error).slice(0, 256) } : {}),
        ...(verificationErrorPresent
          ? { verificationError: String(action.verificationError).slice(0, 256) }
          : {}),
      };
    });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ...(execution.value !== undefined ? { value: execution.value } : {}),
            ...(execution.error !== undefined && execution.error !== ""
              ? { error: execution.error }
              : {}),
            nativeEvidence,
            priorUnknown: this.#priorUnknown,
            outcome: outcomeOf(run.unknown, isError),
          }),
        },
        ...run.images.map((image) => image.content),
      ],
      isError,
      details: {
        independent: {
          isError,
          execution,
          nativeActions: run.nativeActions,
          observations: run.observations,
          images: run.images.map((image) => image.receipt),
          priorUnknown: this.#priorUnknown,
          outcome: outcomeOf(run.unknown, isError),
        },
      },
    };
  }

  async #drainNative() {
    this.#observed = undefined;
    await this.#native.stop();
    await Promise.allSettled(this.#calls);
  }

  /**
   * @param {import("./cua-guard-service.mjs").MacuseEnvelope} input
   * @param {AbortSignal | undefined} signal
   * @param {number} generation
   * @returns {Promise<import("./independent-proof-session.mjs").ProofResult>}
   */
  async #run(input, signal, generation) {
    const run = new ProofRun(generation);
    if (signal?.aborted === true || generation !== this.#generation) {
      return this.#result(
        { isError: true, error: "Proof execution cancelled before dispatch." },
        run,
      );
    }
    this.#active = run;
    /** @type {ExecutionSettlement} */
    let execution;
    try {
      execution = await this.#executor.execute(input, { signal });
      if (execution.isError || generation !== this.#generation) {
        await this.#drainNative();
      }
    } catch (error) {
      await this.#drainNative();
      const detail = isRecord(error) && typeof error.message === "string" ? error.message : error;
      execution = { isError: true, error: String(detail) };
    } finally {
      if (this.#active === run) {
        this.#active = undefined;
      }
    }
    return this.#result(execution, run);
  }

  /**
   * @returns {Promise<import("./independent-proof-session.mjs").ProofSettlement>}
   */
  async stop() {
    if (this.#closing !== undefined) {
      return this.#closing;
    }
    this.#generation++;
    const settled = this.#tail;
    const closing = Promise.resolve()
      .then(async () => {
        await Promise.all([this.#executor.stop(), this.#native.stop()]);
        await Promise.allSettled(this.#calls);
        await settled;
        await this.#drainNative();
        const status = this.#executor.status();
        this.#observed = undefined;
        return {
          workerStopped: status.pid === undefined,
          nativeStopped: true,
          hostCallsPending: status.hostCallsPending,
          settled:
            status.pid === undefined && status.hostCallsPending === 0 && this.#calls.size === 0,
          priorUnknown: this.#priorUnknown,
        };
      })
      .finally(() => {
        this.#closing = undefined;
      });
    this.#closing = closing;
    return closing;
  }

  /**
   * @returns {Promise<import("./independent-proof-session.mjs").ProofResult>}
   */
  reset() {
    if (this.#resetting !== undefined) {
      return this.#resetting;
    }
    const resetting = Promise.resolve()
      .then(async () => {
        const settlement = await this.stop();
        if (!settlement.settled) {
          throw new Error("Owned proof work is not settled; reset refused.");
        }
        this.#executor = this.#newExecutor();
        this.#mutationBlocked = false;
        const text =
          "Proof bindings and observations cleared. Reset does not undo or prove cancellation of GUI effects; inspect fresh state, never automatically replay a prior mutation." +
          (this.#priorUnknown ? " A prior GUI effect remains unknown." : "");
        /** @type {import("./independent-proof-session.mjs").ProofResult["content"]} */
        const content = [{ type: "text", text }];
        return {
          content,
          isError: false,
          details: {
            independent: {
              isError: false,
              reset: true,
              priorUnknown: this.#priorUnknown,
              settlement,
            },
          },
        };
      })
      .finally(() => {
        this.#resetting = undefined;
      });
    this.#resetting = resetting;
    return resetting;
  }
}
