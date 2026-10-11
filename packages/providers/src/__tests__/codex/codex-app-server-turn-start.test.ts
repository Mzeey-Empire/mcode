import { describe, expect, it, vi } from "vitest";
import { CodexAppServer } from "../../private/codex/codex-app-server.js";

describe("CodexAppServer.sendTurn", () => {
  it("requests reasoning summaries so reasoning items carry text", async () => {
    const sendRequest = vi.fn().mockResolvedValue({ turn: { id: "turn-1" } });
    const server = new CodexAppServer({ cliPath: "codex", workingDirectory: process.cwd(), platform: process.platform });
    Reflect.set(server, "_threadId", "main-thread");
    Reflect.set(server, "rpc", { sendRequest });

    await expect(server.sendTurn("hi", { effort: "high" })).resolves.toBe("turn-1");
    expect(sendRequest).toHaveBeenCalledWith("turn/start", {
      threadId: "main-thread",
      input: [{ type: "text", text: "hi" }],
      summary: "auto",
      effort: "high",
    }, 60000);
  });
});
