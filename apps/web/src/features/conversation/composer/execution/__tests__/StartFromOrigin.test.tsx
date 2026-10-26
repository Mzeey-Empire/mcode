import { render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { createMockWorkspace } from "@/__tests__/mocks/transport";
import type { ComposerMode } from "../composer-mode";
import { targetLabelText } from "../new-thread-target-copy";
import { StartFromOriginSwitch } from "../StartFromOriginSwitch";
import { useNewThreadTargetSelection } from "../useComposerTargetSelection";

// The branch resolver lists refs over the transport; the picked branch is all these tests need.
vi.mock("../useTargetBranch", () => ({
  useNewThreadTargetBranch: () => {
    const { newThreadBranch, newThreadBranchRemote } = useWorkspaceStore.getState();
    return { name: newThreadBranch, remote: newThreadBranchRemote, unknown: null };
  },
  useForkTargetBranch: () => ({ name: "", remote: null, unknown: "missing" }),
}));

const workspaceId = "ws-origin";

function selection(mode: ComposerMode) {
  return renderHook(() => useNewThreadTargetSelection(workspaceId, mode)).result.current.target;
}

describe("Start from origin switch", () => {
  beforeEach(() => {
    localStorage.clear();
    useWorkspaceStore.setState({ workspaces: [createMockWorkspace({ id: workspaceId })], activeWorkspaceId: workspaceId });
    useWorkspaceStore.getState().setPendingNewThread(true);
    useWorkspaceStore.getState().setNewThreadBranch("main", null);
  });

  it.each(["direct", "existing-worktree"] as const)("is not offered in %s mode", (mode) => {
    expect(selection(mode).origin).toBeUndefined();
  });

  it("is offered off in New worktree mode, and names the remote main once on", () => {
    const off = selection("worktree");
    expect(off.origin).toMatchObject({ checked: false, forced: false });
    expect(targetLabelText(off.label)).toBe("From main");

    useWorkspaceStore.getState().setNewThreadStartFromOrigin(true);

    const on = selection("worktree");
    expect(on.origin).toMatchObject({ checked: true, forced: false });
    expect(targetLabelText(on.label)).toBe("From main (remote)");
  });

  it("stays on for a remote-only origin row, which has no local branch", () => {
    useWorkspaceStore.getState().setNewThreadBranch("origin/feature/x", "origin");

    const pick = selection("worktree");

    expect(pick.origin).toMatchObject({ checked: true, forced: true });
    expect(targetLabelText(pick.label)).toBe("From feature/x (remote)");
  });

  it("names the pull request rather than origin when one is picked", () => {
    useWorkspaceStore.getState().setNewThreadStartFromOrigin(true);
    useWorkspaceStore.getState().setNewThreadBranchFromPr("fix/login", 42);

    expect(targetLabelText(selection("worktree").label)).toBe("From #42");
  });

  it("turns on from its label, and cannot be turned off when forced", async () => {
    const set = vi.fn();
    const { rerender } = render(<StartFromOriginSwitch origin={{ checked: false, forced: false, set }} />);

    await userEvent.click(screen.getByText("Start from origin"));
    expect(set).toHaveBeenCalledWith(true, expect.anything());

    rerender(<StartFromOriginSwitch origin={{ checked: true, forced: true, set }} />);
    expect(screen.getByRole("switch")).toHaveAttribute("aria-disabled", "true");
  });
});
