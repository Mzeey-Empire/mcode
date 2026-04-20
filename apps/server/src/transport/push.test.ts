import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { WebSocket } from "ws";
import {
  addClient,
  broadcastTerminalData,
  _resetForTest,
} from "./push.js";
import { decodeTerminalDataFrame } from "@mcode/contracts";

function fakeOpenSocket(received: Array<{ buf: Buffer; binary: boolean }>): WebSocket {
  const ws: Partial<WebSocket> = {
    readyState: 1, // OPEN
    OPEN: 1,
    send: ((data: unknown, opts?: { binary?: boolean }) => {
      const buf = Buffer.isBuffer(data)
        ? data
        : Buffer.from(data as Uint8Array);
      received.push({ buf, binary: !!opts?.binary });
    }) as WebSocket["send"],
  };
  return ws as WebSocket;
}

describe("broadcastTerminalData", () => {
  beforeEach(() => _resetForTest());
  afterEach(() => _resetForTest());

  it("sends a binary frame to every connected client", () => {
    const a: Array<{ buf: Buffer; binary: boolean }> = [];
    const b: Array<{ buf: Buffer; binary: boolean }> = [];
    addClient(fakeOpenSocket(a));
    addClient(fakeOpenSocket(b));

    const payload = new Uint8Array([0x41, 0x42, 0x43]); // ABC
    broadcastTerminalData("pty-1", 42, payload);

    expect(a).toHaveLength(1);
    expect(a[0].binary).toBe(true);
    const decoded = decodeTerminalDataFrame(new Uint8Array(a[0].buf));
    expect(decoded).toEqual({ ptyId: "pty-1", seq: 42, payload });
    expect(b).toHaveLength(1);
    expect(b[0].binary).toBe(true);
  });

  it("preserves byte boundaries for multi-byte UTF-8", () => {
    const received: Array<{ buf: Buffer; binary: boolean }> = [];
    addClient(fakeOpenSocket(received));
    const payload = new Uint8Array([0xe4, 0xbd, 0xa0]); // "你" in UTF-8
    broadcastTerminalData("pty-1", 0, payload);
    const decoded = decodeTerminalDataFrame(new Uint8Array(received[0].buf));
    expect(decoded.payload).toEqual(payload);
  });
});
