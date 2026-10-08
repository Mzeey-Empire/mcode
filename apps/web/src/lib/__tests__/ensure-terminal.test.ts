import { beforeEach, describe, expect, it, vi } from "vitest";
import { useToastStore } from "@/stores/toastStore";
import { useTerminalStore } from "@/features/terminal";
import { createTerminalForScope } from "../ensure-terminal";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { useDiffStore } from "@/stores/diffStore";

const terminalCreate = vi.fn();
const terminalKill = vi.fn().mockResolvedValue(undefined);

vi.mock("@/transport", () => ({
  getTransport: () => ({
    terminalCreate,
    terminalKill,
  }),
}));

describe("createTerminalForScope", () => {
  beforeEach(() => {
    vi.useRealTimers();
    terminalCreate.mockReset();
    terminalKill.mockClear();
    useToastStore.setState({ toasts: [] });
    useTerminalStore.setState({ terminals: {} });
  });

  it("keeps a newly created record that hydration already included at the cap", async () => {
    const scopeId = "hydrated-workspace";
    useWorkspaceStore.setState({ threads: [], workspaces: [{
      id: scopeId, name: "Fixture", path: "/fixture", provider_config: {}, is_git_repo: true,
      created_at: "2026-10-08T12:00:00.000Z", updated_at: "2026-10-08T12:00:00.000Z",
      pinned: false, last_opened_at: null, sort_order: 0, deleted_at: null,
    }] });
    useDiffStore.getState().showRightPanel(scopeId);
    terminalCreate.mockImplementation(async () => {
      useTerminalStore.getState().reconcileActiveSessions(
        ["1", "2", "3", "4", "5", "6", "7", "8"].map((ptyId) => ({ ptyId, threadId: scopeId, shell: "pwsh" })),
      );
      return { ptyId: "8", shell: "pwsh" };
    });
    createTerminalForScope(scopeId);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(terminalKill).not.toHaveBeenCalled();
    expect(useTerminalStore.getState().terminals[scopeId].map(({ id }) => id)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8"]);
    expect(useDiffStore.getState().getRightPanel(scopeId).activeTabId).toBe("terminal:8");
  });

  it("surfaces the failure and frees the scope for retry", async () => {
    terminalCreate.mockRejectedValue(new Error("PTY host is unhealthy"));

    createTerminalForScope("scope-a");
    await new Promise((resolve) => setTimeout(resolve, 0));
    createTerminalForScope("scope-a");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(terminalCreate).toHaveBeenCalledTimes(2);
    expect(useToastStore.getState().toasts).toContainEqual(
      expect.objectContaining({
        level: "error",
        title: "Failed to create terminal",
        message: "PTY host is unhealthy",
      }),
    );
  });

  it("keeps the scope locked until terminalCreate reports its failure", async () => {
    vi.useFakeTimers();
    terminalCreate.mockReturnValue(new Promise(() => {}));

    createTerminalForScope("scope-b");
    createTerminalForScope("scope-b");
    expect(terminalCreate).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(20_000);
    createTerminalForScope("scope-b");
    expect(terminalCreate).toHaveBeenCalledTimes(1);
  });
});
