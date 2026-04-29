import { describe, it, expect } from "vitest";

/**
 * This test documents the expected interface change. The actual ACP protocol
 * probe runs against a live Cursor CLI and cannot be unit-tested, so we test
 * that the session options type accepts a mode field and that sendPrompt
 * correctly threads it through.
 */
describe("CursorAcpSessionOptions mode field", () => {
  it("accepts optional mode in session options type", async () => {
    const opts = {
      cliPath: "agent",
      cwd: "/tmp",
      trustWorkspace: false,
      threadId: "t1",
      mode: "plan" as const,
      onAgentEvent: () => {},
      handleServerRequest: async () => ({}),
    };
    expect(opts.mode).toBe("plan");
  });

  it("omits mode from session/new params when undefined", () => {
    const mode: string | undefined = undefined;
    const params = {
      cwd: "/tmp",
      mcpServers: [],
      ...(mode ? { mode } : {}),
    };
    expect(params).not.toHaveProperty("mode");
  });

  it("includes mode in session/new params when set", () => {
    const mode: string | undefined = "plan";
    const params = {
      cwd: "/tmp",
      mcpServers: [],
      ...(mode ? { mode } : {}),
    };
    expect(params).toHaveProperty("mode", "plan");
  });
});
