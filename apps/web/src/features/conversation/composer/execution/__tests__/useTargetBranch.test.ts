import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { createMockWorkspace } from "@/__tests__/mocks/transport";
import type { BranchRefTarget } from "../targets/branch-target";
import { useNewThreadTargetBranch } from "../useTargetBranch";

const originMain: BranchRefTarget = {
  kind: "branch",
  name: "origin/main",
  branchName: "main",
  remote: "origin",
  twin: null,
  isCurrent: false,
  isDefault: true,
  worktree: null,
};

vi.mock("../targets/useBranchTargets", () => ({
  useDefaultBranchTarget: (request: unknown) => (request ? originMain : undefined),
}));

const workspaceId = "ws-default";

describe("useNewThreadTargetBranch", () => {
  beforeEach(() => {
    useWorkspaceStore.setState({ workspaces: [createMockWorkspace({ id: workspaceId, is_git_repo: true })], activeWorkspaceId: workspaceId });
    useWorkspaceStore.getState().setPendingNewThread(true);
  });

  it("keeps the remote of a remote-only default, so a project without local main starts from origin", () => {
    const { result } = renderHook(() => useNewThreadTargetBranch(workspaceId));

    expect(result.current).toEqual({ name: "origin/main", remote: "origin", unknown: null });
  });

  it("reports a picked local branch without a remote", () => {
    useWorkspaceStore.getState().setNewThreadBranch("feature/local", null);

    const { result } = renderHook(() => useNewThreadTargetBranch(workspaceId));

    expect(result.current).toEqual({ name: "feature/local", remote: null, unknown: null });
  });
});
