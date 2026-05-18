/**
 * Length-prefixed JSON framing for the Codex browser-use pipe.
 *
 * Frame layout (mirrors dpcode `browserUsePipeServer.ts`):
 *   - 4-byte UInt32 native-endian header carrying the payload byte length.
 *   - UTF-8 JSON payload, max 8 MB.
 *
 * Endianness is intentionally native: the pipe is local-only, both ends run
 * on the same host, and matching the dpcode wire keeps Codex clients that
 * expect this exact format working unchanged.
 */

import { endianness } from "node:os";
import {
  BROWSER_USE_FRAME_HEADER_BYTES,
  BROWSER_USE_MAX_MESSAGE_BYTES,
} from "@mcode/contracts";

/** Encode an arbitrary JSON-serialisable value as a length-prefixed frame. */
export function encodeFrame(message: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  if (payload.length > BROWSER_USE_MAX_MESSAGE_BYTES) {
    throw new Error(
      `browser-use frame exceeds ${BROWSER_USE_MAX_MESSAGE_BYTES} bytes`,
    );
  }
  const header = Buffer.alloc(BROWSER_USE_FRAME_HEADER_BYTES);
  if (endianness() === "LE") {
    header.writeUInt32LE(payload.length, 0);
  } else {
    header.writeUInt32BE(payload.length, 0);
  }
  return Buffer.concat([header, payload]);
}

/**
 * Decode as many complete frames as the buffer contains, returning the JSON
 * strings (not yet parsed) and the leftover bytes. Returns null if the buffer
 * holds a length header that exceeds the cap, signalling the socket should be
 * destroyed.
 */
export function decodeFrames(
  buffer: Buffer,
): { messages: string[]; remaining: Buffer } | null {
  let offset = 0;
  const messages: string[] = [];
  while (buffer.length - offset >= BROWSER_USE_FRAME_HEADER_BYTES) {
    const len =
      endianness() === "LE"
        ? buffer.readUInt32LE(offset)
        : buffer.readUInt32BE(offset);
    if (len > BROWSER_USE_MAX_MESSAGE_BYTES) {
      return null;
    }
    const frameLength = BROWSER_USE_FRAME_HEADER_BYTES + len;
    if (buffer.length - offset < frameLength) {
      break;
    }
    messages.push(
      buffer
        .subarray(offset + BROWSER_USE_FRAME_HEADER_BYTES, offset + frameLength)
        .toString("utf8"),
    );
    offset += frameLength;
  }
  return { messages, remaining: buffer.subarray(offset) };
}
