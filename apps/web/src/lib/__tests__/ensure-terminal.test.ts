import { createMockWorkspace } from "@mcode/contracts/testing";
// @vitest-environment jsdom
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
    terminalPause: vi.fn().mockResolvedValue(undefined),
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
    useWorkspaceStore.setState({ threads: [], workspaces: [createMockWorkspace({
      id: scopeId,
      name: "Fixture",
      path: "/fixture",
      created_at: "2026-10-08T12:00:00.000Z",
      updated_at: "2026-10-08T12:00:00.000Z",
    })] });
    useDiffStore.getState().showRightPanel(scopeId);
    terminalCreate.mockImplementation(async () => {
      useTerminalStore.getState().reconcileActiveSessions(
        ["1", "2", "3", "4", "5", "6", "7", "8"].map((ptyId) => ({ ptyId, threadId: scopeId, shell: "pwsh" })),
      );
      return { ptyId: "8", shell: "pwsh" };
    });
    createTerminalForScope(scopeId);
    await vi.waitFor(() => expect(useTerminalStore.getState().activeTerminalByScope[scopeId]).toBe("8"));
    expect(terminalKill).not.toHaveBeenCalled();
    expect(useTerminalStore.getState().terminals[scopeId].map(({ id }) => id)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8"]);
    expect(useDiffStore.getState().getRightPanel(scopeId).activeTabId).toBe("singleton:terminal");
  });

  it("reports the attached PTY only when its tab joined a visible panel", async () => {
    const workspace = (id: string) => createMockWorkspace({
      id,
      name: "Fixture",
      path: "/fixture",
      created_at: "2026-10-08T12:00:00.000Z",
      updated_at: "2026-10-08T12:00:00.000Z",
    });
    useWorkspaceStore.setState({ threads: [], workspaces: [workspace("visible-ws"), workspace("hidden-ws")] });
    useDiffStore.getState().showRightPanel("visible-ws");
    terminalCreate.mockResolvedValueOnce({ ptyId: "p1", shell: "pwsh" }).mockResolvedValueOnce({ ptyId: "p2", shell: "pwsh" });
    const onAttached = vi.fn();

    createTerminalForScope("visible-ws", onAttached);
    createTerminalForScope("hidden-ws", onAttached);
    await vi.waitFor(() => expect(terminalKill).toHaveBeenCalledWith("p2"));

    expect(onAttached.mock.calls).toEqual([["p1"]]);
  });

  it("surfaces the failure and frees the scope for retry", async () => {
    terminalCreate.mockRejectedValue(new Error("PTY host is unhealthy"));

    createTerminalForScope("scope-a");
    await vi.waitFor(() => expect(useToastStore.getState().toasts).toHaveLength(1));
    createTerminalForScope("scope-a");

    expect(terminalCreate).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(useToastStore.getState().toasts).toHaveLength(2));
    expect(useToastStore.getState().toasts).toContainEqual(
      expect.objectContaining({
        kind: "failed",
        title: "Failed to create terminal",
        meta: "PTY host is unhealthy",
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
