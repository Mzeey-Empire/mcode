import { createMockThread, createMockWorkspace } from "@mcode/contracts/testing";
import { mockTransport } from "@/__tests__/mocks/transport";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Thread } from "@/transport/types";

vi.mock("@/transport", () => ({ getTransport: () => mockTransport }));

import { useWorkspaceStore } from "../../state/workspaceStore";
import { ThreadDeleteDialog } from "../thread-deletion";

const PROJECT = createMockWorkspace({ id: "ws-project", name: "Alpha", path: "/alpha" });
const HIDDEN = createMockWorkspace({ id: "ws-hidden", name: "No project", path: "/home/.mcode/no-project/abc", kind: "no_project", is_git_repo: false });

function seed(threads: Thread[]): void {
  useWorkspaceStore.setState({ workspaces: [PROJECT, HIDDEN], threads, activeThreadId: null, activeWorkspaceId: null });
}

function renderDialog(threadId: string, threadTitle: string, onConfirm = vi.fn().mockResolvedValue(undefined)) {
  render(
    <ThreadDeleteDialog
      dialog={{ threadId, threadTitle, worktreePath: null }}
      deleteWorktree={false}
      isDeleting={false}
      onDeleteWorktreeChange={vi.fn()}
      onClose={vi.fn()}
      onConfirm={onConfirm}
    />,
  );
  return onConfirm;
}

describe("ThreadDeleteDialog for a No project thread", () => {
  afterEach(() => {
    cleanup();
    useWorkspaceStore.setState({ workspaces: [], threads: [], activeThreadId: null, activeWorkspaceId: null });
  });

  it("says the folder goes with a thread that has it to itself, without showing its path", async () => {
    seed([createMockThread({ id: "t-1", title: "Sketch a schema", workspace_id: HIDDEN.id })]);

    const onConfirm = renderDialog("t-1", "Sketch a schema");

    expect(await screen.findByText("Deletes the thread, its folder, and any files the agent wrote there.")).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(HIDDEN.path);
    await userEvent.setup().click(screen.getByRole("button", { name: "Delete thread and folder" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("says the folder stays while a fork sharing it exists", async () => {
    seed([
      createMockThread({ id: "t-1", title: "Sketch a schema", workspace_id: HIDDEN.id }),
      createMockThread({ id: "t-2", title: "Sketch, take two", workspace_id: HIDDEN.id }),
    ]);

    renderDialog("t-1", "Sketch a schema");

    expect(await screen.findByText("Deletes the thread. The folder stays while “Sketch, take two” uses it.")).toBeInTheDocument();
    expect(screen.queryByText(HIDDEN.path)).toBeNull();
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete thread and folder" })).toBeNull();
  });

  it("ignores threads of other workspaces when deciding who shares the folder", async () => {
    seed([
      createMockThread({ id: "t-1", title: "Sketch a schema", workspace_id: HIDDEN.id }),
      createMockThread({ id: "t-2", title: "Project work", workspace_id: PROJECT.id }),
    ]);

    renderDialog("t-1", "Sketch a schema");

    expect(await screen.findByRole("button", { name: "Delete thread and folder" })).toBeInTheDocument();
  });

  it("leaves a project thread's dialog as it was", async () => {
    seed([createMockThread({ id: "t-2", title: "Project work", workspace_id: PROJECT.id })]);

    renderDialog("t-2", "Project work");

    expect(await screen.findByText("Are you sure you want to delete “Project work”? This action cannot be undone.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
    expect(screen.queryByText(PROJECT.path)).toBeNull();
  });
});
