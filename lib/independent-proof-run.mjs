/** Evidence retained for one executor run, including work that settles after cancellation. */
export class ProofRun {
  /** @readonly @type {number} */
  generation;
  /** @type {Array<Record<string, unknown> & { method: string }>} */
  nativeActions = [];
  /** @type {Array<{ observationId: unknown, app: unknown, windows: unknown[] }>} */
  observations = [];
  /** @type {Array<{ receipt: Record<string, unknown>, content: { type: "image", mimeType: "image/png", data: string } }>} */
  images = [];
  imageBytes = 0;
  captureAttempts = 0;
  failed = false;
  unknown = false;

  /** @param {number} generation */
  constructor(generation) {
    this.generation = generation;
  }
  reserveCapture() {
    this.captureAttempts++;
  }
  /** @param {number} bytes */
  chargeImage(bytes) {
    this.imageBytes += bytes;
  }
  markUnknown() {
    this.unknown = true;
  }
  fail() {
    this.failed = true;
  }
}
