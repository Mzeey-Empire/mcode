import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const boundaries = vi.hoisted(() => ({
  open: vi.fn(),
  which: vi.fn(),
}));

vi.mock("which", () => ({ default: boundaries.which }));

import { warmCodexAppServer } from "../../private/codex/codex-app-server.js";
import type { ProviderProcessOpener } from "../../host-ports.js";

describe("warmCodexAppServer", () => {
  it("initializes, reads rate limits, and stops the session once", async () => {
    boundaries.which.mockResolvedValue("/test/codex");
    const writes: unknown[] = [];
    const payload = { primary: { usedPercent: 12 } };
    const stop = vi.fn();
    const open: ProviderProcessOpener = (_request, observer) => ({
      write: (text) => {
        const message = JSON.parse(text);
        writes.push(message);
        if (message.id === 1) queueMicrotask(() => observer.onStdout?.('{"id":1,"result":{}}\n'));
        if (message.id === 2) queueMicrotask(() => observer.onStdout?.(JSON.stringify({ id: 2, result: payload }) + "\n"));
      },
      stop,
      exited: new Promise(() => {}),
    });
    await expect(warmCodexAppServer("codex", process.platform, open, 100)).resolves.toEqual({
      initialized: true, rateLimitsPayload: payload,
    });
    expect(writes).toEqual([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {
        clientInfo: { name: "mcode", version: "1.0.0" }, capabilities: { experimentalApi: true },
      } },
      { jsonrpc: "2.0", method: "initialized", params: {} },
      { jsonrpc: "2.0", id: 2, method: "account/rateLimits/read", params: {} },
    ]);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("returns uninitialized when the session exits before initialization", async () => {
    boundaries.which.mockResolvedValue("/test/codex");
    const writes: string[] = [];
    const sessionOpen: ProviderProcessOpener = () => ({ write: (text) => { writes.push(text); }, stop: () => {}, exited: Promise.resolve() });
    await expect(warmCodexAppServer("codex", process.platform, sessionOpen, 100)).resolves.toEqual({ initialized: false });
    expect(writes.map((text) => JSON.parse(text).method)).toEqual(["initialize"]);
  });
  beforeEach(() => {
    boundaries.open.mockReset();
    boundaries.which.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves an uninitialized result for a missing binary without throwing", async () => {
    boundaries.which.mockRejectedValue(new Error("missing"));

    await expect(
      warmCodexAppServer("definitely-not-a-real-binary-xyz", process.platform, boundaries.open, 100),
    ).resolves.toEqual({ initialized: false });
    expect(boundaries.open).not.toHaveBeenCalled();
  });

  it("bounds executable discovery inside the warmup deadline", async () => {
    vi.useFakeTimers();
    boundaries.which.mockReturnValue(new Promise(() => undefined));

    const result = warmCodexAppServer("slow-codex", process.platform, boundaries.open, 100);
    await vi.advanceTimersByTimeAsync(100);

    await expect(result).resolves.toEqual({ initialized: false });
    expect(boundaries.open).not.toHaveBeenCalled();
  });
});
