// src/webmFix.ts
// Lightweight, zero-dependency EBML duration patcher for MediaRecorder WebM outputs.
// MediaRecorder leaves WebM 'Duration' and 'SeekHead' empty/unseekable; this utility
// injects or updates the 0x4489 Duration element in the Segment Info block.

interface Vint {
  length: number;
  value: number;
}

function readVint(buffer: Uint8Array, start: number): Vint | null {
  if (start >= buffer.length) return null;
  const firstByte = buffer[start];
  let length = 0;
  let mask = 0x80;

  for (let i = 1; i <= 8; i++) {
    if ((firstByte & mask) !== 0) {
      length = i;
      break;
    }
    mask >>= 1;
  }

  if (length === 0 || start + length > buffer.length) return null;

  let value = firstByte & (mask - 1);
  for (let i = 1; i < length; i++) {
    // Use multiplication instead of bitwise << 8 to prevent 32-bit signed integer overflow
    value = value * 256 + buffer[start + i];
  }

  return { length, value };
}

function writeVint(value: number, minLength = 1): Uint8Array {
  let length = minLength;
  for (let i = 1; i <= 8; i++) {
    // Use Math.pow instead of bitwise shift: `1 << (7 * i)` wraps at i >= 5
    // because JS bitwise operators operate on 32-bit signed integers.
    const maxVal = Math.pow(2, 7 * i) - 2;
    if (value <= maxVal) {
      length = Math.max(i, minLength);
      break;
    }
  }

  const bytes = new Uint8Array(length);
  let val = value;
  for (let i = length - 1; i >= 0; i--) {
    bytes[i] = val & 0xff;
    val >>>= 8;
  }
  bytes[0] |= 0x80 >> (length - 1);
  return bytes;
}

function readElementId(buffer: Uint8Array, start: number): { id: number; length: number } | null {
  if (start >= buffer.length) return null;
  const firstByte = buffer[start];
  let length = 0;
  let mask = 0x80;

  for (let i = 1; i <= 4; i++) {
    if ((firstByte & mask) !== 0) {
      length = i;
      break;
    }
    mask >>= 1;
  }

  if (length === 0 || start + length > buffer.length) return null;

  let id = 0;
  for (let i = 0; i < length; i++) {
    id = (id << 8) | buffer[start + i];
  }

  return { id: id >>> 0, length };
}

const ID_EBML = 0x1a45dfa3;
const ID_SEGMENT = 0x18538067;
const ID_INFO = 0x1549a966;
const ID_TIMECODESCALE = 0x2ad7b1;
const ID_DURATION = 0x4489;

/**
 * Patches the WebM EBML duration header in a Blob so it becomes scrubbable.
 * @param blob The assembled WebM recording blob
 * @param durationMs The total duration in milliseconds
 * @returns A promise resolving to the duration-patched Blob
 */
export async function fixWebmDuration(blob: Blob, durationMs: number): Promise<Blob> {
  if (durationMs <= 0) return blob;

  // Read the first 256 KB which invariably contains the EBML header and Segment Info block
  const sliceSize = Math.min(blob.size, 262144);
  const headBuffer = new Uint8Array(await blob.slice(0, sliceSize).arrayBuffer());
  const view = new DataView(headBuffer.buffer);

  let offset = 0;
  let segmentOffset = -1;
  let segmentSizeVint: Vint | null = null;
  let segmentSizePos = -1;

  let infoOffset = -1;
  let infoSizeVint: Vint | null = null;
  let infoSizePos = -1;
  let infoDataStart = -1;
  let infoDataEnd = -1;

  let timecodeScale = 1000000; // default 1,000,000 ns = 1 ms
  let durationOffset = -1;
  let durationDataSize = -1;

  // Scan top-level elements: EBML and Segment
  while (offset < headBuffer.length) {
    const elId = readElementId(headBuffer, offset);
    if (!elId) break;
    offset += elId.length;

    const elSize = readVint(headBuffer, offset);
    if (!elSize) break;
    const sizeOffset = offset;
    offset += elSize.length;

    if (elId.id === ID_SEGMENT) {
      segmentOffset = offset;
      segmentSizeVint = elSize;
      segmentSizePos = sizeOffset;
      break;
    } else {
      offset += elSize.value;
    }
  }

  if (segmentOffset === -1 || !segmentSizeVint || segmentSizePos === -1) {
    console.warn('[webmFix] Segment element not found; returning original blob.');
    return blob;
  }

  // Inside Segment: find Info element
  offset = segmentOffset;
  while (offset < headBuffer.length) {
    const elId = readElementId(headBuffer, offset);
    if (!elId) break;
    offset += elId.length;

    const elSize = readVint(headBuffer, offset);
    if (!elSize) break;
    const sizeOffset = offset;
    offset += elSize.length;

    if (elId.id === ID_INFO) {
      infoOffset = offset;
      infoSizeVint = elSize;
      infoSizePos = sizeOffset;
      infoDataStart = offset;
      infoDataEnd = offset + elSize.value;
      break;
    } else {
      offset += elSize.value;
    }
  }

  if (infoOffset === -1 || !infoSizeVint || infoSizePos === -1 || infoDataEnd > headBuffer.length) {
    console.warn('[webmFix] Info element not found or incomplete; returning original blob.');
    return blob;
  }

  // Inside Info: inspect TimecodeScale and Duration
  offset = infoDataStart;
  while (offset < infoDataEnd) {
    const elId = readElementId(headBuffer, offset);
    if (!elId) break;
    offset += elId.length;

    const elSize = readVint(headBuffer, offset);
    if (!elSize) break;
    offset += elSize.length;

    if (elId.id === ID_TIMECODESCALE) {
      let tc = 0;
      for (let i = 0; i < elSize.value; i++) {
        tc = tc * 256 + headBuffer[offset + i];
      }
      if (tc > 0) timecodeScale = tc;
      offset += elSize.value;
    } else if (elId.id === ID_DURATION) {
      durationOffset = offset;
      durationDataSize = elSize.value;
      offset += elSize.value;
    } else {
      offset += elSize.value;
    }
  }

  // Calculate duration in timecode ticks
  const durationTicks = (durationMs * 1000000) / timecodeScale;

  // Case 1: Duration element already exists inside Info
  if (durationOffset !== -1) {
    if (durationDataSize === 4) {
      view.setFloat32(durationOffset, durationTicks, false); // big-endian
    } else if (durationDataSize === 8) {
      view.setFloat64(durationOffset, durationTicks, false);
    }
    return new Blob([headBuffer, blob.slice(sliceSize)], { type: blob.type });
  }

  // Case 2: Duration element missing -> Inject an 8-byte float Duration element (0x4489)
  // ID (2 bytes: 0x44, 0x89) + VINT size (1 byte: 0x88 = 8 bytes) + 8-byte double = 11 bytes
  const durationElement = new Uint8Array(11);
  durationElement[0] = 0x44;
  durationElement[1] = 0x89;
  durationElement[2] = 0x88;
  const dv = new DataView(durationElement.buffer);
  dv.setFloat64(3, durationTicks, false);

  // We will insert durationElement at the end of the Info element data (infoDataEnd).
  // Update Info element size:
  const newInfoSize = infoSizeVint.value + 11;
  const newInfoVint = writeVint(newInfoSize, infoSizeVint.length);

  // If new VINT length matches old length, we can simply overwrite it
  if (newInfoVint.length === infoSizeVint.length) {
    headBuffer.set(newInfoVint, infoSizePos);

    // Update Segment size if not unknown size (0x01FFFFFFFFFFFFFF or 0xFF)
    if (segmentSizeVint && segmentSizeVint.value > 0 && segmentSizeVint.length <= 8) {
      const isUnknownSize = (headBuffer[segmentSizePos] & 0x01) && headBuffer[segmentSizePos + 1] === 0xff;
      if (!isUnknownSize) {
        const newSegSize = segmentSizeVint.value + 11;
        const newSegVint = writeVint(newSegSize, segmentSizeVint.length);
        if (newSegVint.length === segmentSizeVint.length) {
          headBuffer.set(newSegVint, segmentSizePos);
        }
      }
    }

    const before = headBuffer.subarray(0, infoDataEnd);
    const after = headBuffer.subarray(infoDataEnd);

    return new Blob([before, durationElement, after, blob.slice(sliceSize)], { type: blob.type });
  } else {
    // If VINT length expanded, slice and rebuild buffer accurately
    const beforeInfoSize = headBuffer.subarray(0, infoSizePos);
    const between = headBuffer.subarray(infoSizePos + infoSizeVint.length, infoDataEnd);
    const rest = headBuffer.subarray(infoDataEnd);

    return new Blob(
      [beforeInfoSize, newInfoVint, between, durationElement, rest, blob.slice(sliceSize)],
      { type: blob.type }
    );
  }
}
