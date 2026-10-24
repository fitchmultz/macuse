import { createHash, randomUUID } from "node:crypto";
import { basename, isAbsolute } from "node:path";
import { IsolatedExecutor } from "./isolated-executor.mjs";
import { validateEnvelope } from "./cua-guard-service.mjs";
import { NativeActuator } from "../tools/native-actuator.mjs";

const maxImageBytes = 12_000_000;
const maxRunImageBytes = 24_000_000;
const fields = {
  observe: ["app"],
  screenshot: ["app", "observationId", "windowToken"],
  act: ["app", "observationId", "elementToken", "action", "value"],
};
const nonempty = value => typeof value === "string" && value.trim() && value.isWellFormed();

function targetConfiguration(supplied) {
  const value = supplied ?? (process.env.MACUSE_INDEPENDENT_PROOF_TARGET ? JSON.parse(process.env.MACUSE_INDEPENDENT_PROOF_TARGET) : undefined);
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some(key => !["bundleId", "pid", "path", "windowTitle"].includes(key))
    || !nonempty(value.bundleId) || !/^com\.macuse\.actuator-fixture\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.bundleId)
    || !Number.isSafeInteger(value.pid) || value.pid <= 0
    || !nonempty(value.path) || !isAbsolute(value.path) || basename(value.path) !== "ActuatorFixture.app"
    || value.windowTitle !== undefined && value.windowTitle !== "macuse disposable actuator fixture") throw new TypeError("Invalid trusted proof target: fixture UUID bundleId, positive pid, absolute canonical path, and optional windowTitle required.");
  return Object.freeze({ ...structuredClone(value), windowTitle: "macuse disposable actuator fixture" });
}

function png(image) {
  if (image?.mimeType !== "image/png" || typeof image.data !== "string" || image.data.length > Math.ceil(maxImageBytes / 3) * 4) throw new Error("Native screenshot exceeds the PNG transport budget.");
  const bytes = Buffer.from(image.data, "base64");
  if (bytes.length > maxImageBytes || bytes.toString("base64") !== image.data || bytes.length < 33
    || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR") throw new Error("Native screenshot is not a bounded PNG.");
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (!width || !height || width > 8192 || height > 8192 || width * height > 16_000_000
    || width !== image.width || height !== image.height) throw new Error("Native screenshot dimensions fail the proof budget or metadata check.");
  return { width, height, bytes: bytes.length, mimeType: "image/png", sha256: createHash("sha256").update(bytes).digest("hex") };
}

/** Explicit opt-in owned-target integration. Never imported by production MacuseSession. */
export class IndependentProofSession {
  #target;
  #processStartToken;
  #native = new NativeActuator();
  #executor;
  #observed;
  #calls = new Set();
  #active;
  #tail = Promise.resolve();
  #closing;
  #resetting;
  #generation = 0;
  #priorUnknown = false;
  #mutationBlocked = false;

  constructor({ target } = {}) {
    this.#target = targetConfiguration(target);
    this.#executor = this.#newExecutor();
  }

  #newExecutor() {
    return new IsolatedExecutor({ capabilities: Object.fromEntries(Object.keys(fields).map(method => [method, {
      mutating: method === "act", invoke: (params, context) => this.#invoke(method, params, context),
    }])) });
  }

  #invoke(method, params, context) {
    const run = this.#active;
    const task = this.#perform(run, method, params, context);
    this.#calls.add(task);
    return task.finally(() => { this.#calls.delete(task); });
  }

  #refuse(run, method, error) {
    run.failed = true;
    const result = { status: "refused", mutationAttempted: false, outcome: "not-dispatched", error: String(error?.message ?? error) };
    run.nativeActions.push({ method, ...result });
    return result;
  }

  async #perform(run, method, params, context) {
    try {
      if (!run || run.generation !== this.#generation || context.signal.aborted) throw new Error("Proof request cancelled before native dispatch.");
      if (!this.#target) throw new Error("Native proof requires operator-configured MACUSE_INDEPENDENT_PROOF_TARGET; guest code cannot select the target.");
      if (Object.keys(params).some(key => !fields[method].includes(key))) throw new Error("Unsupported guest fields; authorization and target identity are parent-owned.");
      if (params.app !== this.#target.bundleId || context.envelope.apps?.length !== 1 || context.envelope.apps[0] !== this.#target.bundleId) throw new Error("Every native proof operation requires the exact trusted target app scope.");
      if (method !== "observe" && (!this.#observed || params.observationId !== this.#observed.observationId)) throw new Error("A fresh same-session native observation is required.");
      if (method === "act") {
        if (this.#mutationBlocked || run.failed) throw new Error("Proof mutation blocked after a refusal or uncertain effect; inspect/reset before continuing, never replay.");
        if (!context.envelope.allowMutating || !nonempty(context.envelope.safetyNote)) throw new Error("Parent mutation authorization is required.");
        if (!["press", "setValue"].includes(params.action) || params.action === "setValue" && (typeof params.value !== "string" || !params.value.isWellFormed())
          || params.action === "press" && params.value !== undefined) throw new Error("Only observed press or exact full-field setValue is supported.");
        if (!this.#observed.elements.some(element => element.token === params.elementToken)) throw new Error("Unknown observed element token.");
      }
      if (method === "screenshot") {
        if (!this.#observed.windows.some(window => window.token === params.windowToken)) throw new Error("Unknown observed window token.");
        // Reserve the full native ceiling before starting another capture, not after
        // retaining an over-budget payload in the trusted parent.
        if (run.captureAttempts >= 2 || run.imageBytes + maxImageBytes > maxRunImageBytes) throw new Error("Per-run screenshot count/byte budget exhausted.");
      }
    } catch (error) {
      if (!run) throw error;
      return this.#refuse(run, method, error);
    }

    let result;
    try {
      const options = { signal: context.signal };
      if (method === "observe") {
        this.#observed = undefined;
        result = await this.#native.observe({ app: this.#target.bundleId, expectedPid: this.#target.pid, expectedPath: this.#target.path,
          ...(this.#processStartToken !== undefined ? { expectedProcessStartToken: this.#processStartToken } : {}),
        }, options);
        if (result.app?.bundleId !== this.#target.bundleId || result.app?.pid !== this.#target.pid || result.app?.path !== this.#target.path
          || typeof result.app.processStartToken !== "string" || !/^[1-9]\d*:\d+$/.test(result.app.processStartToken)
          || this.#processStartToken !== undefined && result.app.processStartToken !== this.#processStartToken
          || !nonempty(result.observationId) || result.fullSnapshot !== true || !Array.isArray(result.windows) || !Array.isArray(result.elements)
          || this.#target.windowTitle !== undefined && (result.windows.length !== 1 || result.windows[0].title !== this.#target.windowTitle)) {
          throw Object.assign(new Error("Native observation did not match the operator-owned target identity/window."), { dispatched: false });
        }
        if (context.signal.aborted || run.generation !== this.#generation) throw Object.assign(new Error("Observation completed after cancellation; discarded."), { dispatched: false });
        this.#processStartToken ??= result.app.processStartToken;
        this.#observed = result;
        run.observations.push({ observationId: result.observationId, app: result.app, windows: result.windows });
        return result;
      }
      if (method === "screenshot") {
        run.captureAttempts++;
        result = await this.#native.screenshot({ app: this.#target.bundleId, observationId: params.observationId, windowToken: params.windowToken }, options);
        if (context.signal.aborted || run.generation !== this.#generation) throw Object.assign(new Error("Screenshot completed after cancellation; discarded."), { dispatched: false });
        if (result.windowToken !== params.windowToken || result.coordinateSpace !== "screenshot-pixels") throw new Error("Native screenshot target/coordinate identity changed.");
        const metadata = png(result.image);
        const observed = this.#observed.windows.find(window => window.token === params.windowToken);
        const rectangle = frame => frame && ["x", "y", "width", "height"].every(key => Number.isFinite(frame[key])) && frame.width > 0 && frame.height > 0;
        if (!rectangle(result.windowFrame) || !rectangle(result.captureRect) || !rectangle(observed?.frame)
          || ["x", "y", "width", "height"].some(key => result.windowFrame[key] !== observed.frame[key])
          || !Number.isFinite(result.pointPixelScale) || result.pointPixelScale <= 0 || result.pointPixelScale > 8
          || !Number.isSafeInteger(result.windowId) || result.windowId <= 0
          || Math.round(result.captureRect.width * result.pointPixelScale) !== metadata.width
          || Math.round(result.captureRect.height * result.pointPixelScale) !== metadata.height) throw new Error("Native screenshot window/pixel mapping does not match the observed target.");
        if (run.imageBytes + metadata.bytes > maxRunImageBytes) throw new Error("Per-run decoded image budget exhausted.");
        const receipt = { handle: randomUUID(), contentIndex: run.images.length + 1, windowToken: result.windowToken,
          windowId: result.windowId, windowFrame: result.windowFrame, captureRect: result.captureRect,
          pointPixelScale: result.pointPixelScale, coordinateSpace: result.coordinateSpace, ...metadata };
        run.imageBytes += metadata.bytes;
        run.images.push({ receipt, content: { type: "image", mimeType: "image/png", data: result.image.data } });
        return receipt;
      }
      result = await this.#native.act({ app: this.#target.bundleId, observationId: params.observationId,
        elementToken: params.elementToken, action: params.action, ...(params.action === "setValue" ? { value: params.value } : {}),
        allowMutating: true, safetyNote: context.envelope.safetyNote,
      }, options);
      this.#observed = undefined;
      run.nativeActions.push({ method, app: this.#target.bundleId, action: params.action, elementToken: params.elementToken, ...result });
      const accepted = result.mutationAttempted === true && result.status === "applied" && result.nativeAccepted === true
        && (params.action === "press" ? result.outcome === "requires-fresh-observation" : result.verified === true && result.outcome === "verified");
      if (!accepted) {
        this.#mutationBlocked = true;
        this.#priorUnknown = true;
        run.unknown = true;
        throw Object.assign(new Error("Native mutation outcome is unknown/unverified. Inspect fresh state; never replay."), { recorded: true });
      }
      return result;
    } catch (error) {
      this.#observed = undefined;
      if (method === "act" && (error.recorded || error.dispatched !== false)) {
        if (!error.recorded) run.nativeActions.push({ method, app: this.#target.bundleId, action: params.action,
          mutationAttempted: true, status: "unknown", outcome: "unknown", error: String(error.message) });
        this.#mutationBlocked = true;
        this.#priorUnknown = true;
        run.unknown = true;
        run.failed = true;
        await this.#native.stop();
        throw error;
      }
      return this.#refuse(run, method, error);
    }
  }

  execute(input, { signal } = {}) {
    if (this.#closing || this.#resetting) throw new Error("Proof session is stopping/resetting; no execution admitted.");
    validateEnvelope(input);
    const saved = structuredClone(input);
    const generation = this.#generation;
    const task = this.#tail.then(() => this.#run(saved, signal, generation));
    this.#tail = task.catch(() => {});
    return task;
  }

  #result(execution, run) {
    const isError = Boolean(execution.isError || run.failed || run.unknown);
    // Providers consume content, not details. Guest completion must not hide a
    // refusal, unknown effect, or accepted-but-not-verified AXPress.
    const nativeEvidence = run.nativeActions.map(action => ({
      method: action.method, app: action.app, elementToken: action.elementToken,
      action: action.action, status: action.status,
      mutationAttempted: action.mutationAttempted, nativeAccepted: action.nativeAccepted,
      verified: action.verified, outcome: action.outcome,
      ...(action.error ? { error: String(action.error).slice(0, 256) } : {}),
      ...(action.verificationError ? { verificationError: String(action.verificationError).slice(0, 256) } : {}),
    }));
    return { content: [{ type: "text", text: JSON.stringify({ ...(execution.value !== undefined ? { value: execution.value } : {}),
      ...(execution.error ? { error: execution.error } : {}), nativeEvidence, priorUnknown: this.#priorUnknown,
      outcome: run.unknown ? "unknown" : isError ? "failed" : "completed" }) }, ...run.images.map(image => image.content)],
      isError, details: { independent: { isError, execution, nativeActions: run.nativeActions, observations: run.observations,
        images: run.images.map(image => image.receipt), priorUnknown: this.#priorUnknown,
        outcome: run.unknown ? "unknown" : isError ? "failed" : "completed" } } };
  }

  async #drainNative() {
    this.#observed = undefined;
    await this.#native.stop();
    await Promise.allSettled([...this.#calls]);
  }

  async #run(input, signal, generation) {
    const run = { generation, nativeActions: [], observations: [], images: [], imageBytes: 0, captureAttempts: 0, failed: false, unknown: false };
    if (signal?.aborted || generation !== this.#generation) return this.#result({ isError: true, error: "Proof execution cancelled before dispatch." }, run);
    this.#active = run;
    let execution;
    try {
      execution = await this.#executor.execute(input, { signal });
      if (execution.isError || generation !== this.#generation) await this.#drainNative();
    } catch (error) {
      await this.#drainNative();
      execution = { isError: true, error: String(error?.message ?? error) };
    } finally { if (this.#active === run) this.#active = undefined; }
    return this.#result(execution, run);
  }

  async stop() {
    if (this.#closing) return this.#closing;
    this.#generation++;
    const settled = this.#tail;
    this.#closing = Promise.resolve().then(async () => {
      await Promise.all([this.#executor.stop(), this.#native.stop()]);
      await Promise.allSettled([...this.#calls]);
      await settled;
      await this.#drainNative();
      const status = this.#executor.status();
      this.#observed = undefined;
      return { workerStopped: !status.pid, nativeStopped: true, hostCallsPending: status.hostCallsPending,
        settled: !status.pid && status.hostCallsPending === 0 && this.#calls.size === 0, priorUnknown: this.#priorUnknown };
    }).finally(() => { this.#closing = undefined; });
    return this.#closing;
  }

  reset() {
    if (this.#resetting) return this.#resetting;
    this.#resetting = Promise.resolve().then(async () => {
      const settlement = await this.stop();
      if (!settlement.settled) throw new Error("Owned proof work is not settled; reset refused.");
      this.#executor = this.#newExecutor();
      this.#mutationBlocked = false;
      const text = "Proof bindings and observations cleared. GUI state is unchanged; inspect fresh state, never automatically replay a prior mutation."
        + (this.#priorUnknown ? " A prior GUI effect remains unknown." : "");
      return { content: [{ type: "text", text }], isError: false,
        details: { independent: { isError: false, reset: true, priorUnknown: this.#priorUnknown, settlement } } };
    }).finally(() => { this.#resetting = undefined; });
    return this.#resetting;
  }
}
