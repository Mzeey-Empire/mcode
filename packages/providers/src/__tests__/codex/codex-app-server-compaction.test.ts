import { describe, expect, it, vi } from "vitest";
import {
  CodexAppServer as NativeCodexAppServer,
  type CodexAppServerOptions,
} from "../../private/codex/codex-app-server.js";

class CodexAppServer extends NativeCodexAppServer {
  constructor(options: Omit<CodexAppServerOptions, "platform">) {
    super({ ...options, platform: process.platform });
  }
}

function serverWithRpc(sendRequest: ReturnType<typeof vi.fn>): CodexAppServer {
  const server = new CodexAppServer({ cliPath: "codex", workingDirectory: process.cwd() });
  Reflect.set(server, "_threadId", "main-thread");
  Reflect.set(server, "rpc", { sendRequest });
  return server;
}

const turnStarted = (threadId: string, turnId: string) => ({
  method: "turn/started",
  params: { threadId, turn: { id: turnId, status: "inProgress" } },
});

describe("CodexAppServer.startCompaction", () => {
  it("resolves with the main thread's compaction turn id, ignoring child turns", async () => {
    const sendRequest = vi.fn().mockResolvedValue({});
    const server = serverWithRpc(sendRequest);

    const compaction = server.startCompaction();
    server.emit("notification", turnStarted("child-thread", "child-turn"));
    server.emit("notification", turnStarted("main-thread", "compact-turn"));

    await expect(compaction).resolves.toBe("compact-turn");
    expect(sendRequest).toHaveBeenCalledWith("thread/compact/start", { threadId: "main-thread" }, 60_000);
    expect(server.listenerCount("notification")).toBe(0);
  });

  it("catches a turn/started that arrives before the RPC response", async () => {
    const server = serverWithRpc(vi.fn());
    Reflect.set(server, "rpc", {
      sendRequest: vi.fn(async () => {
        server.emit("notification", turnStarted("main-thread", "early-turn"));
        return {};
      }),
    });

    await expect(server.startCompaction()).resolves.toBe("early-turn");
  });

  it("surfaces a rejected request and stops waiting", async () => {
    const server = serverWithRpc(vi.fn().mockRejectedValue(new Error("thread busy")));

    await expect(server.startCompaction()).rejects.toThrow("thread busy");
    expect(server.listenerCount("notification")).toBe(0);
  });

  it("rejects when no compaction turn starts", async () => {
    vi.useFakeTimers();
    try {
      const server = serverWithRpc(vi.fn().mockResolvedValue({}));
      const compaction = server.startCompaction();
      const rejection = expect(compaction).rejects.toThrow("Codex compaction turn did not start");
      await vi.advanceTimersByTimeAsync(60_000);
      await rejection;
      expect(server.listenerCount("notification")).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
