import { createHash, randomUUID } from "node:crypto";
import { basename, isAbsolute } from "node:path";
import { IsolatedExecutor } from "./isolated-executor.mjs";
import { validateEnvelope } from "./cua-guard-service.mjs";
import { NativeActuator } from "../tools/native-actuator.mjs";

/**
 * @typedef {{ bundleId: string, pid: number, path: string, windowTitle: string }} ResolvedTarget
 * A retained native screenshot and its provider-facing receipt.
 * @typedef {{ receipt: Record<string, unknown>, content: { type: "image", mimeType: "image/png", data: string } }} CapturedImage
 * The last accepted native observation, typed at the validation boundary.
 * @typedef {{ observationId: unknown, app: Record<string, unknown>, windows: Record<string, unknown>[], elements: Record<string, unknown>[] }} ObservedNative
 * One recorded native action or refusal.
 * @typedef {Record<string, unknown> & { method: string }} ProofNativeAction
 * Per-run bookkeeping handed to #result.
 * @typedef {{ generation: number, nativeActions: ProofNativeAction[], observations: { observationId: unknown, app: unknown, windows: unknown[] }[], images: CapturedImage[], imageBytes: number, captureAttempts: number, failed: boolean, unknown: boolean }} ProofRun
 * The executor settlement fields #result consumes.
 * @typedef {{ isError: boolean, value?: unknown, error?: string | undefined }} ExecutionSettlement
 * A validated window frame rectangle.
 * @typedef {{ x: number, y: number, width: number, height: number }} FrameRect
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
/**
 * @param {unknown} value
 * @returns {value is string}
 */
const nonempty = (value) =>
  typeof value === "string" && value.trim() !== "" && value.isWellFormed();
/**
 * @param {boolean} unknownEffect
 * @param {boolean} failed
 * @returns {"unknown" | "failed" | "completed"}
 */
const outcomeOf = (unknownEffect, failed) => {
  if (unknownEffect) return "unknown";
  if (failed) return "failed";
  return "completed";
};

const maxImageBytes = 12_000_000;
const maxRunImageBytes = 24_000_000;
/** @type {Record<string, string[]>} */
const fields = {
  observe: ["app"],
  screenshot: ["app", "observationId", "windowToken"],
  act: ["app", "observationId", "elementToken", "action", "value"],
};

/**
 * @param {unknown} supplied
 * @returns {ResolvedTarget | undefined}
 */
function targetConfiguration(supplied) {
  const configured = process.env.MACUSE_INDEPENDENT_PROOF_TARGET;
  const value =
    supplied ??
    (configured !== undefined && configured !== ""
      ? /** @type {unknown} */ (JSON.parse(configured))
      : undefined);
  if (value === undefined) return;
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !["bundleId", "pid", "path", "windowTitle"].includes(key)) ||
    !nonempty(value.bundleId) ||
    !/^com\.macuse\.actuator-fixture\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value.bundleId,
    ) ||
    typeof value.pid !== "number" ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    !nonempty(value.path) ||
    !isAbsolute(value.path) ||
    basename(value.path) !== "ActuatorFixture.app" ||
    (value.windowTitle !== undefined && value.windowTitle !== "macuse disposable actuator fixture")
  )
    throw new TypeError(
      "Invalid trusted proof target: fixture UUID bundleId, positive pid, absolute canonical path, and optional windowTitle required.",
    );
  return Object.freeze({
    bundleId: value.bundleId,
    pid: value.pid,
    path: value.path,
    windowTitle: "macuse disposable actuator fixture",
  });
}

/**
 * @param {unknown} image
 * @returns {{ width: number, height: number, bytes: number, mimeType: "image/png", sha256: string, data: string }}
 */
function png(image) {
  if (
    !isRecord(image) ||
    image.mimeType !== "image/png" ||
    typeof image.data !== "string" ||
    image.data.length > Math.ceil(maxImageBytes / 3) * 4
  )
    throw new Error("Native screenshot exceeds the PNG transport budget.");
  const bytes = Buffer.from(image.data, "base64");
  if (
    bytes.length > maxImageBytes ||
    bytes.toString("base64") !== image.data ||
    bytes.length < 33 ||
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    bytes.readUInt32BE(8) !== 13 ||
    bytes.toString("ascii", 12, 16) !== "IHDR"
  )
    throw new Error("Native screenshot is not a bounded PNG.");
  const width = bytes.readUInt32BE(16),
    height = bytes.readUInt32BE(20);
  if (
    width === 0 ||
    height === 0 ||
    width > 8192 ||
    height > 8192 ||
    width * height > 16_000_000 ||
    width !== image.width ||
    height !== image.height
  )
    throw new Error("Native screenshot dimensions fail the proof budget or metadata check.");
  return {
    width,
    height,
    bytes: bytes.length,
    mimeType: "image/png",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    data: image.data,
  };
}

/** Explicit opt-in owned-target integration. Never imported by production MacuseSession. */
export class IndependentProofSession {
  /** @type {ResolvedTarget | undefined} */
  // oxlint-disable-next-line typescript/prefer-readonly -- .mjs private fields cannot express readonly (TS8009)
  #target;
  /** @type {string | undefined} */
  #processStartToken;
  // oxlint-disable-next-line typescript/prefer-readonly -- .mjs private fields cannot express readonly (TS8009)
  #native = new NativeActuator();
  /** @type {IsolatedExecutor} */
  #executor;
  /** @type {ObservedNative | undefined} */
  #observed;
  /** @type {Set<Promise<unknown>>} */
  // oxlint-disable-next-line typescript/prefer-readonly -- .mjs private fields cannot express readonly (TS8009)
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
    if (!isRecord(params)) throw new Error("Guest capability params must be an object.");
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
    const observed = this.#observed;
    const stale = () => run?.generation !== this.#generation;
    const aborted = () => context.signal.aborted;
    try {
      if (!run || stale() || aborted())
        throw new Error("Proof request cancelled before native dispatch.");
      if (!this.#target)
        throw new Error(
          "Native proof requires operator-configured MACUSE_INDEPENDENT_PROOF_TARGET; guest code cannot select the target.",
        );
      const allowed = fields[method] ?? [];
      if (Object.keys(params).some((key) => !allowed.includes(key)))
        throw new Error(
          "Unsupported guest fields; authorization and target identity are parent-owned.",
        );
      const apps = context.envelope.apps;
      if (
        params.app !== this.#target.bundleId ||
        !Array.isArray(apps) ||
        apps.length !== 1 ||
        apps[0] !== this.#target.bundleId
      )
        throw new Error(
          "Every native proof operation requires the exact trusted target app scope.",
        );
      if (
        method !== "observe" &&
        (observed === undefined || params.observationId !== observed.observationId)
      )
        throw new Error("A fresh same-session native observation is required.");
      if (method === "act") {
        if (observed === undefined)
          throw new Error("A fresh same-session native observation is required.");
        if (this.#mutationBlocked || run.failed)
          throw new Error(
            "Proof mutation blocked after a refusal or uncertain effect; inspect/reset before continuing, never replay.",
          );
        if (context.envelope.allowMutating !== true || !nonempty(context.envelope.safetyNote))
          throw new Error("Parent mutation authorization is required.");
        if (
          typeof params.action !== "string" ||
          !["press", "setValue"].includes(params.action) ||
          (params.action === "setValue" &&
            (typeof params.value !== "string" || !params.value.isWellFormed())) ||
          (params.action === "press" && params.value !== undefined)
        )
          throw new Error("Only observed press or exact full-field setValue is supported.");
        if (!observed.elements.some((element) => element.token === params.elementToken))
          throw new Error("Unknown observed element token.");
      }
      if (method === "screenshot") {
        if (observed === undefined)
          throw new Error("A fresh same-session native observation is required.");
        if (!observed.windows.some((window) => window.token === params.windowToken))
          throw new Error("Unknown observed window token.");
        // Reserve the full native ceiling before starting another capture, not after
        // retaining an over-budget payload in the trusted parent.
        if (run.captureAttempts >= 2 || run.imageBytes + maxImageBytes > maxRunImageBytes)
          throw new Error("Per-run screenshot count/byte budget exhausted.");
      }
    } catch (error) {
      if (run === undefined) throw error;
      run.failed = true;
      return this.#refuse(run, method, error);
    }

    /** @type {unknown} */
    let result;
    try {
      const options = { signal: context.signal };
      if (method === "observe") {
        this.#observed = undefined;
        result = await this.#native.observe(
          {
            app: this.#target.bundleId,
            expectedPid: this.#target.pid,
            expectedPath: this.#target.path,
            ...(this.#processStartToken !== undefined
              ? { expectedProcessStartToken: this.#processStartToken }
              : {}),
          },
          options,
        );
        if (!isRecord(result))
          throw Object.assign(
            new Error(
              "Native observation did not match the operator-owned target identity/window.",
            ),
            { dispatched: false },
          );
        const app = isRecord(result.app) ? result.app : undefined;
        if (
          app === undefined ||
          app.bundleId !== this.#target.bundleId ||
          app.pid !== this.#target.pid ||
          app.path !== this.#target.path ||
          typeof app.processStartToken !== "string" ||
          !/^[1-9]\d*:\d+$/.test(app.processStartToken) ||
          (this.#processStartToken !== undefined &&
            app.processStartToken !== this.#processStartToken) ||
          !nonempty(result.observationId) ||
          result.fullSnapshot !== true ||
          !Array.isArray(result.windows) ||
          !Array.isArray(result.elements) ||
          result.windows.length !== 1 ||
          !isRecord(result.windows[0]) ||
          result.windows[0].title !== this.#target.windowTitle
        ) {
          throw Object.assign(
            new Error(
              "Native observation did not match the operator-owned target identity/window.",
            ),
            { dispatched: false },
          );
        }
        if (aborted() || stale())
          throw Object.assign(new Error("Observation completed after cancellation; discarded."), {
            dispatched: false,
          });
        this.#processStartToken ??= app.processStartToken;
        this.#observed = {
          observationId: result.observationId,
          app,
          windows: result.windows.filter(isRecord),
          elements: result.elements.filter(isRecord),
        };
        run.observations.push({
          observationId: result.observationId,
          app: result.app,
          windows: result.windows,
        });
        return result;
      }
      if (method === "screenshot") {
        run.captureAttempts++;
        result = await this.#native.screenshot(
          {
            app: this.#target.bundleId,
            observationId: params.observationId,
            windowToken: params.windowToken,
          },
          options,
        );
        if (aborted() || stale())
          throw Object.assign(new Error("Screenshot completed after cancellation; discarded."), {
            dispatched: false,
          });
        if (
          !isRecord(result) ||
          result.windowToken !== params.windowToken ||
          result.coordinateSpace !== "screenshot-pixels"
        )
          throw new Error("Native screenshot target/coordinate identity changed.");
        const { data, ...metadata } = png(result.image);
        const window = observed?.windows.find(
          (/** @type {Record<string, unknown>} */ entry) => entry.token === params.windowToken,
        );
        /**
         * @param {unknown} frame
         * @returns {frame is FrameRect}
         */
        const rectangle = (frame) => {
          if (!isRecord(frame)) return false;
          const { x, y, width, height } = frame;
          return (
            typeof x === "number" &&
            typeof y === "number" &&
            typeof width === "number" &&
            typeof height === "number" &&
            Number.isFinite(x) &&
            Number.isFinite(y) &&
            Number.isFinite(width) &&
            Number.isFinite(height) &&
            width > 0 &&
            height > 0
          );
        };
        const windowFrame = result.windowFrame;
        const captureRect = result.captureRect;
        const observedFrame = window?.frame;
        /** @type {("x" | "y" | "width" | "height")[]} */
        const axes = ["x", "y", "width", "height"];
        if (
          !rectangle(windowFrame) ||
          !rectangle(captureRect) ||
          !rectangle(observedFrame) ||
          axes.some((key) => windowFrame[key] !== observedFrame[key]) ||
          typeof result.pointPixelScale !== "number" ||
          !Number.isFinite(result.pointPixelScale) ||
          result.pointPixelScale <= 0 ||
          result.pointPixelScale > 8 ||
          typeof result.windowId !== "number" ||
          !Number.isSafeInteger(result.windowId) ||
          result.windowId <= 0 ||
          Math.round(captureRect.width * result.pointPixelScale) !== metadata.width ||
          Math.round(captureRect.height * result.pointPixelScale) !== metadata.height
        )
          throw new Error(
            "Native screenshot window/pixel mapping does not match the observed target.",
          );
        if (run.imageBytes + metadata.bytes > maxRunImageBytes)
          throw new Error("Per-run decoded image budget exhausted.");
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
        run.imageBytes += metadata.bytes;
        run.images.push({
          receipt,
          content: { type: "image", mimeType: "image/png", data },
        });
        return receipt;
      }
      result = await this.#native.act(
        {
          app: this.#target.bundleId,
          observationId: params.observationId,
          elementToken: params.elementToken,
          action: params.action,
          ...(params.action === "setValue" ? { value: params.value } : {}),
          allowMutating: true,
          safetyNote: context.envelope.safetyNote,
        },
        options,
      );
      const native = isRecord(result) ? result : {};
      this.#observed = undefined;
      this.#observed = undefined;
      run.nativeActions.push({
        method,
        app: this.#target.bundleId,
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
        run.unknown = true;
        throw Object.assign(
          new Error(
            "Native mutation outcome is unknown/unverified. Inspect fresh state; never replay.",
          ),
          { recorded: true },
        );
      }
      return native;
    } catch (error) {
      this.#observed = undefined;
      const record = isRecord(error) ? error : undefined;
      const recorded = record !== undefined && Boolean(record.recorded);
      if (method === "act" && (recorded || record?.dispatched !== false)) {
        if (!recorded)
          run.nativeActions.push({
            method,
            app: this.#target.bundleId,
            action: params.action,
            mutationAttempted: true,
            status: "unknown",
            outcome: "unknown",
            error: String(record?.message),
          });
        this.#mutationBlocked = true;
        this.#priorUnknown = true;
        run.unknown = true;
        run.failed = true;
        await this.#native.stop();
        throw error;
      }
      run.failed = true;
      return this.#refuse(run, method, error);
    }
  }

  /**
   * @param {unknown} input
   * @param {{ signal?: AbortSignal }} [options]
   * @returns {Promise<import("./independent-proof-session.mjs").ProofResult>}
   */
  execute(input, { signal } = {}) {
    if (this.#closing !== undefined || this.#resetting !== undefined)
      throw new Error("Proof session is stopping/resetting; no execution admitted.");
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
    /** @type {ProofRun} */
    const run = {
      generation,
      nativeActions: [],
      observations: [],
      images: [],
      imageBytes: 0,
      captureAttempts: 0,
      failed: false,
      unknown: false,
    };
    if (signal?.aborted === true || generation !== this.#generation)
      return this.#result(
        { isError: true, error: "Proof execution cancelled before dispatch." },
        run,
      );
    this.#active = run;
    /** @type {ExecutionSettlement} */
    let execution;
    try {
      execution = await this.#executor.execute(input, { signal });
      if (execution.isError || generation !== this.#generation) await this.#drainNative();
    } catch (error) {
      await this.#drainNative();
      const detail = isRecord(error) && typeof error.message === "string" ? error.message : error;
      execution = { isError: true, error: String(detail) };
    } finally {
      if (this.#active === run) this.#active = undefined;
    }
    return this.#result(execution, run);
  }

  /**
   * @returns {Promise<import("./independent-proof-session.mjs").ProofSettlement>}
   */
  async stop() {
    if (this.#closing !== undefined) return this.#closing;
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
    if (this.#resetting !== undefined) return this.#resetting;
    const resetting = Promise.resolve()
      .then(async () => {
        const settlement = await this.stop();
        if (!settlement.settled) throw new Error("Owned proof work is not settled; reset refused.");
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
