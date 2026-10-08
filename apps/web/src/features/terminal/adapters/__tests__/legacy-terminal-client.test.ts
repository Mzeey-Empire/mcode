import { describe, expect, it, vi } from "vitest";
import { LegacyTerminalClient } from "../legacy/legacy-terminal-client";
import type { TerminalRpcCall } from "../terminal-client";

const bundle = {
  contractVersion: 1,
  generatedAt: "2026-08-12T10:00:00.000Z",
  backend: "legacy",
  health: {
    contractVersion: 1,
    state: "healthy",
    hostGeneration: "7",
    activeSessions: 0,
    lastHeartbeatMsAgo: 2,
    queueBytes: 0,
    eventLoopLagMs: 1,
    hostRssBytes: "1234",
  },
  events: [],
  counters: [],
  histograms: [],
};

describe("LegacyTerminalClient", () => {
  it("preserves retained metadata and defaults only an older server's missing state", async () => {
    const rpc = vi.fn<TerminalRpcCall>().mockResolvedValue([
      { ptyId: "exited", threadId: "thread", shell: "pwsh", state: "exited", exitCode: 7, kind: "shell", cwd: "/repo", createdAt: "2026-10-08T12:00:00.000Z" },
      { ptyId: "older", threadId: "workspace" },
    ]);
    const client = new LegacyTerminalClient(rpc);
    await expect(client.listActive()).resolves.toEqual([
      { ptyId: "exited", threadId: "thread", shell: "pwsh", state: "exited", exitCode: 7, kind: "shell", cwd: "/repo", createdAt: "2026-10-08T12:00:00.000Z" },
      { ptyId: "older", threadId: "workspace", state: "running" },
    ]);
    expect(rpc.mock.calls).toEqual([["terminal.listActive", {}]]);
  });

  it("rejects malformed terminal list metadata", async () => {
    const rpc = vi.fn<TerminalRpcCall>().mockResolvedValue([{ ptyId: "bad", threadId: "thread", state: "invented" }]);
    await expect(new LegacyTerminalClient(rpc).listActive()).rejects.toThrow();
  });

  it("requests a replacement before closing the exited record for older servers", async () => {
    const rpc = vi.fn<TerminalRpcCall>()
      .mockResolvedValueOnce({ ptyId: "new", shell: "pwsh", cwd: "/repo" })
      .mockResolvedValueOnce(undefined);
    await expect(new LegacyTerminalClient(rpc).create("thread", "old")).resolves.toEqual({ ptyId: "new", shell: "pwsh", cwd: "/repo" });
    expect(rpc.mock.calls).toEqual([
      ["terminal.create", { threadId: "thread", replacesPtyId: "old" }],
      ["terminal.kill", { ptyId: "old" }],
    ]);
  });

  it("does not close the old record if creating its replacement fails", async () => {
    const rpc = vi.fn<TerminalRpcCall>().mockRejectedValue(new Error("create failed"));
    await expect(new LegacyTerminalClient(rpc).create("thread", "old")).rejects.toThrow();
    expect(rpc.mock.calls).toEqual([["terminal.create", { threadId: "thread", replacesPtyId: "old" }]]);
  });

  it("accepts additive create metadata but rejects an invalid state", async () => {
    const rpc = vi.fn<TerminalRpcCall>()
      .mockResolvedValueOnce({ ptyId: "new", shell: "pwsh", state: "exited", exitCode: 7, futureField: true })
      .mockResolvedValueOnce({ ptyId: "bad", shell: "pwsh", state: "invented" });
    const client = new LegacyTerminalClient(rpc);
    await expect(client.create("thread")).resolves.toEqual({ ptyId: "new", shell: "pwsh", state: "exited", exitCode: 7 });
    await expect(client.create("thread")).rejects.toThrow();
  });

  it("returns the exact parsed content-free diagnostics bundle", async () => {
    const rpc = vi.fn(async (method: string) => {
      if (method === "terminal.diagnostics.getBundle") return bundle;
      throw new Error(`Unexpected RPC: ${method}`);
    });
    const client = new LegacyTerminalClient(rpc);

    await expect(client.diagnostics()).resolves.toEqual(bundle);
    expect(rpc).toHaveBeenCalledWith("terminal.diagnostics.getBundle", {});
  });

  it.each([
    ["malformed", { ...bundle, health: { ...bundle.health, state: "unknown" } }],
    [
      "overlarge",
      {
        ...bundle,
        events: Array.from({ length: 2_049 }, () => ({
          eventId: "00000000-0000-4000-8000-000000000001",
          at: bundle.generatedAt,
          metric: "host.rss.bytes",
          unit: "bytes",
          value: 1,
          outcome: "ok",
          correlationId: "test",
        })),
      },
    ],
  ])("rejects %s hostile diagnostics responses", async (_kind, response) => {
    const rpc = vi.fn(async () => response);
    const client = new LegacyTerminalClient(rpc);

    await expect(client.diagnostics()).rejects.toThrow();
  });
});
