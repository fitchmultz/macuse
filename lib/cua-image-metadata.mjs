/** @param {Buffer} bytes */
function jpegMetadata(bytes) {
  for (let i = 2; i + 3 < bytes.length;) {
    if (bytes[i++] !== 0xff) {
      break;
    }
    while (bytes[i] === 0xff) {
      i++;
    }
    const marker = bytes[i++] ?? 0xd9;
    if (jpegEndMarker(marker)) {
      break;
    }
    if (jpegStandaloneMarker(marker)) {
      continue;
    }
    if (i + 2 > bytes.length) {
      break;
    }
    const length = bytes.readUInt16BE(i);
    if (!jpegSegmentFits(length, i, bytes.length)) {
      break;
    }
    if (jpegFrame(marker, length)) {
      return {
        mimeType: "image/jpeg",
        width: bytes.readUInt16BE(i + 5),
        height: bytes.readUInt16BE(i + 3),
      };
    }
    i += length;
  }
  return { mimeType: "image/jpeg" };
}

/** @param {number} marker @param {number} length */
function jpegFrame(marker, length) {
  return (
    length >= 8 &&
    [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)
  );
}

/** @param {number} marker */
function jpegEndMarker(marker) {
  return marker === 0xda || marker === 0xd9;
}

/** @param {number} marker */
function jpegStandaloneMarker(marker) {
  return marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7);
}

/** @param {number} length @param {number} offset @param {number} total */
function jpegSegmentFits(length, offset, total) {
  return length >= 2 && offset + length <= total;
}

/** @param {Buffer} bytes */
function webpLosslessMetadata(bytes) {
  return {
    mimeType: "image/webp",
    width: 1 + ((((bytes[22] ?? 0) & 0x3f) << 8) | (bytes[21] ?? 0)),
    height:
      1 + ((((bytes[24] ?? 0) & 0x0f) << 10) | ((bytes[23] ?? 0) << 2) | ((bytes[22] ?? 0) >> 6)),
  };
}

/** @param {Buffer} bytes */
function webpMetadata(bytes) {
  const kind = bytes.toString("ascii", 12, 16);
  if (kind === "VP8X" && bytes.length >= 30) {
    return {
      mimeType: "image/webp",
      width: bytes.readUIntLE(24, 3) + 1,
      height: bytes.readUIntLE(27, 3) + 1,
    };
  }
  if (kind === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
    return webpLosslessMetadata(bytes);
  }
  if (
    kind === "VP8 " &&
    bytes.length >= 30 &&
    bytes.subarray(23, 26).equals(Buffer.from([0x9d, 1, 0x2a]))
  ) {
    return {
      mimeType: "image/webp",
      width: bytes.readUInt16LE(26) & 0x3fff,
      height: bytes.readUInt16LE(28) & 0x3fff,
    };
  }
  return { mimeType: "image/webp" };
}

// Read actual file signatures. Native macOS captures can be JPEG labelled image/png.
/**
 * @param {string} data
 * @returns {{ mimeType?: string | undefined, width?: number | undefined, height?: number | undefined }}
 */
export function imageMetadata(data) {
  const bytes = Buffer.from(data, "base64");
  if (isPng(bytes)) {
    return { mimeType: "image/png", width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (isJpeg(bytes)) {
    return jpegMetadata(bytes);
  }
  if (bytes.length >= 10 && /^GIF8[79]a$/.test(bytes.toString("ascii", 0, 6))) {
    return { mimeType: "image/gif", width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  }
  if (isWebp(bytes)) {
    return webpMetadata(bytes);
  }
  return {};
}

/** @param {Buffer} bytes */
function isPng(bytes) {
  return (
    bytes.length >= 24 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    bytes.toString("ascii", 12, 16) === "IHDR"
  );
}

/** @param {Buffer} bytes */
function isJpeg(bytes) {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

/** @param {Buffer} bytes */
function isWebp(bytes) {
  return (
    bytes.length >= 20 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  );
}
