import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { createMockWorkspace } from "@/__tests__/mocks/transport";
import { NewThreadTargetRail } from "../NewThreadTargetRail";

vi.mock("../ComposerTargetSelection", () => ({
  ComposerTargetSelection: () => <button type="button" data-testid="composer-branch-trigger">From main</button>,
}));

function seedWorkspace(isGitRepo: boolean) {
  useWorkspaceStore.setState({
    workspaces: [createMockWorkspace({ id: "ws-1", path: "/src/mcode", is_git_repo: isGitRepo })],
  });
}

function renderRail({ workspaceId }: { workspaceId?: string } = { workspaceId: "ws-1" }) {
  render(<NewThreadTargetRail workspaceId={workspaceId} mode="worktree" onModeChange={vi.fn()} />);
}

describe("NewThreadTargetRail", () => {
  beforeEach(() => seedWorkspace(true));

  it("carries the workspace and branch", () => {
    renderRail();

    const rail = screen.getByTestId("new-thread-target-rail");
    expect(within(rail).getByTestId("workspace-target-trigger")).toHaveTextContent("New worktree");
    expect(within(rail).getByTestId("composer-branch-trigger")).toBeInTheDocument();
  });

  it("offers only Local and no branch outside a git repo", () => {
    seedWorkspace(false);
    renderRail();

    const rail = screen.getByTestId("new-thread-target-rail");
    expect(within(rail).getByTestId("workspace-target-trigger")).toHaveTextContent("Local");
    expect(within(rail).queryByTestId("composer-branch-trigger")).not.toBeInTheDocument();
  });

  it("renders nothing before a project is chosen", () => {
    renderRail({});
    expect(screen.queryByTestId("new-thread-target-rail")).not.toBeInTheDocument();
  });
});
