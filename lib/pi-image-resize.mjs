import { availableParallelism } from "node:os";
import { resizeImage } from "@earendil-works/pi-coding-agent";

/** @typedef {Parameters<typeof resizeImage>[2]} ImageResizeOptions */
/** @typedef {Awaited<ReturnType<typeof resizeImage>>} ImageResizeResult */

// ponytail: Pi's resizeImage decodes each image in its own worker; four at once bound
// the decode memory of a cold reseed. Raise only with measured memory headroom.
let resizeSlots = Math.max(1, Math.min(4, availableParallelism() - 1));
/** @type {Array<() => void>} */
const resizeQueue = [];

/**
 * @param {string} data
 * @param {string} mimeType
 * @param {ImageResizeOptions | undefined} profile
 * @returns {Promise<ImageResizeResult>}
 */
export async function resizeOriginal(data, mimeType, profile) {
  if (resizeSlots > 0) {
    resizeSlots--;
  } else {
    /** @type {Promise<void>} */
    const slot = new Promise((resolve) => {
      resizeQueue.push(() => resolve());
    });
    await slot;
  }
  try {
    return await resizeImage(Buffer.from(data, "base64"), mimeType, profile);
  } finally {
    const next = resizeQueue.shift();
    if (next) {
      next();
    } else {
      resizeSlots++;
    }
  }
}

/**
 * Settle every task, then report the first failure in input order, as a
 * sequential loop would, without leaving work running after the caller returns.
 * @template T
 * @param {Promise<T>[]} tasks
 * @returns {Promise<T[]>}
 */
export async function settleAll(tasks) {
  await Promise.allSettled(tasks);
  return Promise.all(tasks);
}
