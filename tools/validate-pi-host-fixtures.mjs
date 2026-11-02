import assert from "node:assert/strict";
import { crc32, deflateSync } from "node:zlib";

/** @typedef {typeof import("@earendil-works/pi-coding-agent")} PiPublic */
/** @typedef {Awaited<ReturnType<PiPublic["createAgentSession"]>>["session"]} PiSession */
/** @typedef {PiSession["messages"][number]} AgentMessage */
/** @typedef {Extract<AgentMessage, { role: "toolResult" }>["content"][number]} ContentBlock */
/** @typedef {import("@earendil-works/pi-ai").FauxContentBlock} FauxContentBlock */
/** @typedef {Extract<FauxContentBlock, { type: "toolCall" }>} FauxToolCall */

/**
 * A minimal base64 PNG fixture.
 * @param {number} width
 * @param {number} height
 * @returns {string}
 */
export function png(width, height) {
  /**
   * @param {string} name
   * @param {Buffer} bytes
   * @returns {Buffer}
   */
  const chunk = (name, bytes) => {
    const data = Buffer.concat([Buffer.from(name), bytes]),
      length = Buffer.alloc(4),
      crc = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    crc.writeUInt32BE(crc32(data));
    return Buffer.concat([length, data, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.alloc((width * 4 + 1) * height))),
    chunk("IEND", Buffer.alloc(0)),
  ]).toString("base64");
}

/** The oversized controlled result the macuse tool fixture returns. */
/** @type {ContentBlock[]} */
export const content = [
  { type: "text", text: "Controlled synthetic image" },
  { type: "image", mimeType: "image/png", data: png(4000, 3000) },
];

/** The retained-originals evidence that result carries. */
export const details = {
  macuse: {
    isError: true,
    originalContent: content,
    actions: [{ dispatched: true, outcome: "unknown" }],
  },
};

/** The synthetic macuse tool call the host must process. */
/** @type {FauxToolCall} */
export const call = {
  type: "toolCall",
  name: "macuse",
  id: "call_image|fc_image",
  arguments: { code: "synthetic fixture only" },
};

/** A later hook's redacted replacement output. */
/** @type {ContentBlock[]} */
export const redacted = [
  { type: "text", text: "Redacted screenshot" },
  { type: "image", mimeType: "image/png", data: png(64, 64) },
];

const image = content[1];
if (image === undefined || image.type !== "image") {
  assert.fail("Fixture content must include the oversized image");
}

/** The oversized original image content part. */
export const originalImage = image;
