import { describe, expect, it } from "vitest";
import { decodeFrames, encodeFrame } from "../browser-use/framing.js";
import { BROWSER_USE_MAX_MESSAGE_BYTES } from "@mcode/contracts";

describe("browser-use framing", () => {
  it("round-trips a JSON-RPC request", () => {
    const message = { jsonrpc: "2.0", id: 1, method: "ping" };
    const frame = encodeFrame(message);

    const decoded = decodeFrames(frame);
    expect(decoded).not.toBeNull();
    if (!decoded) return;
    expect(decoded.remaining.length).toBe(0);
    expect(decoded.messages).toHaveLength(1);
    expect(JSON.parse(decoded.messages[0]!)).toEqual(message);
  });

  it("decodes multiple frames coalesced into one buffer", () => {
    const a = encodeFrame({ jsonrpc: "2.0", id: 1, method: "ping" });
    const b = encodeFrame({ jsonrpc: "2.0", id: 2, method: "getInfo" });
    const decoded = decodeFrames(Buffer.concat([a, b]));
    expect(decoded).not.toBeNull();
    if (!decoded) return;
    expect(decoded.messages).toHaveLength(2);
    expect(decoded.remaining.length).toBe(0);
  });

  it("returns partial frame bytes in `remaining` when buffer is short", () => {
    const full = encodeFrame({ jsonrpc: "2.0", id: 1, method: "ping" });
    // Truncate so the header is present but the payload is short.
    const truncated = full.subarray(0, full.length - 2);
    const decoded = decodeFrames(truncated);
    expect(decoded).not.toBeNull();
    if (!decoded) return;
    expect(decoded.messages).toHaveLength(0);
    expect(decoded.remaining.equals(truncated)).toBe(true);
  });

  it("returns null when an over-cap length header is seen (poison frame)", () => {
    const poison = Buffer.alloc(4);
    poison.writeUInt32LE(BROWSER_USE_MAX_MESSAGE_BYTES + 1, 0);
    // On a BE host the LE write is still > cap because cap is small; this
    // test is endian-tolerant by design.
    const decoded = decodeFrames(poison);
    expect(decoded).toBeNull();
  });

  it("encodeFrame rejects payloads above the cap", () => {
    // Build a payload that JSON-encodes to more than the cap.
    const huge = "x".repeat(BROWSER_USE_MAX_MESSAGE_BYTES + 16);
    expect(() => encodeFrame({ s: huge })).toThrow(/exceeds/);
  });
});
