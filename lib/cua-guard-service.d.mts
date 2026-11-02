import type { AppElement, AppObservation } from "./app-state.mjs";

/**
 * A request accepted from the vendor Sky service bridge. The bridge is the only
 * caller of the exported guard handler; `method` and `args` are absent on
 * session setup requests and are validated before any dispatch.
 */
export interface SkyRequest {
  type: string;
  method?: string | undefined;
  args?: unknown[] | undefined;
  /** Sky may attach protocol fields the guard validates or rejects. */
  [extra: string]: unknown;
}

/** The vendor Sky service bridge the guard dispatches validated requests to. */
export type GuardDispatch = (request: SkyRequest) => Promise<unknown>;

/**
 * One recorded GUI action attempt. `app` keeps the raw guest argument as
 * evidence, so it is `unknown` until the operation validates it; failed
 * attempts can carry values the guest supplied.
 */
export interface GuardAction {
  id: number;
  method: string;
  app?: unknown;
  dispatched: boolean;
  outcome: "not_dispatched" | "unknown" | "completed";
  verification: "none" | "native-returned" | "exact-field-value";
  target?: { index: string; id?: string | undefined; role: string; name: string } | undefined;
  before?: { title: string | null; url: string | null; nativeWindowIdentity: boolean } | undefined;
  closesWindow?: boolean | undefined;
  error?: string | undefined;
}

/** The guard's per-run state. One run is one admitted guest program. */
export interface RunRecord {
  runId: string;
  actions: GuardAction[];
  mutationBlocked: boolean;
}

/** The focused field the guard carries across a follow-up keyboard input. */
export interface FocusAnchor {
  app: string;
  observation: AppObservation;
  element: AppElement;
  returnToAncestor?: boolean | undefined;
}

/**
 * The tool-input envelope carried through trusted host metadata. Envelope
 * fields arrive from guest tool input and are validated by `validateEnvelope`
 * before use; `runId` and `invalidatedApps` are host-constructed.
 */
export interface MacuseRunMeta {
  runId?: unknown;
  apps?: unknown;
  allowMutating?: unknown;
  safetyNote?: unknown;
  invalidatedApps?: string[] | undefined;
  code?: unknown;
  timeoutMs?: unknown;
}

/** The validated form of the guest tool-input envelope. */
export interface MacuseEnvelope {
  runId?: unknown;
  apps?: string[] | undefined;
  allowMutating?: boolean | undefined;
  safetyNote?: string | undefined;
  invalidatedApps?: string[] | undefined;
  code?: unknown;
  timeoutMs?: unknown;
}

/** A diagnostic event emitted to the host over stderr. */
export type GuardDiagnostic = { runId: string } & Record<string, unknown>;

/**
 * The vendor node-repl session context. The guard reads trusted host metadata
 * through it and publishes evidence with `setResponseMeta`.
 */
export interface NodeReplContext {
  requestMeta?: { macuse?: MacuseRunMeta | undefined } | undefined;
  setResponseMeta: (meta: unknown) => void;
}

declare global {
  /**
   * The active node-repl session context. Present only inside the vendor
   * sandbox that loads this module as a trusted service.
   */
  var nodeRepl: NodeReplContext | undefined;
}

export const GUI_METHODS: readonly [
  "click",
  "drag",
  "paste",
  "perform_secondary_action",
  "press_key",
  "scroll",
  "select_text",
  "set_value",
  "type_text",
];

/** Validate a macuse tool envelope in place; throws on any invalid field. */
export function validateEnvelope(input: unknown): asserts input is MacuseEnvelope;

/** Create the guard used inside the vendor sandbox. */
export function createGuard(options: {
  dispatch: GuardDispatch;
  context?: (() => NodeReplContext | undefined) | undefined;
  diagnostic?: ((event: GuardDiagnostic) => void) | undefined;
}): (request: SkyRequest) => Promise<unknown>;

/** Handle one vendor Sky service request through the guard. */
export function handleRpc(request: SkyRequest): Promise<unknown>;
