import { describe, expect, it } from "vitest";
import {
  resolveSelectedTerminalId,
  shouldReattachSelectedTerminal,
} from "../ws-transport";

describe("resolveSelectedTerminalId", () => {
  it("selects the active thread terminal before the workspace terminal", () => {
    expect(resolveSelectedTerminalId({
      activeThreadId: "thread-1",
      activeWorkspaceId: "workspace-1",
      terminalPanelByThread: {
        "thread-1": { activeTerminalId: "pty-thread" },
        "workspace-1": { activeTerminalId: "pty-workspace" },
      },
    })).toBe("pty-thread");
  });

  it("keeps reconnect headless when the active scope has no selected renderer", () => {
    expect(resolveSelectedTerminalId({
      activeThreadId: "thread-1",
      activeWorkspaceId: "workspace-1",
      terminalPanelByThread: {},
    })).toBeNull();
  });

  it("waits for pending creation and reattaches retained exits", () => {
    expect(shouldReattachSelectedTerminal(
      { ptyId: "pty-pending", state: "pending" },
      "pty-pending",
    )).toBe(false);
    expect(shouldReattachSelectedTerminal(
      { ptyId: "pty-exited", state: "exited" },
      "pty-exited",
    )).toBe(true);
  });
});
