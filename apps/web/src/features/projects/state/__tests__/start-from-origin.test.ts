import { createMockThread, createMockWorkspace } from "@mcode/contracts/testing";
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CreateAndSendInput } from "@mcode/contracts/ws/methods";
import { useWorkspaceStore, __clearPendingThreadCreationsForTests } from "../workspaceStore";
import { mockTransport } from "../../../../__tests__/mocks/transport";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

const workspace = createMockWorkspace({ id: "ws-origin" });

async function sendNewWorktree(): Promise<CreateAndSendInput> {
  const created = createMockThread({ id: "origin-thread", workspace_id: workspace.id });
  const createAndSend = vi.mocked(mockTransport.createAndSendMessage);
  createAndSend.mockResolvedValue({
    ...created,
    runtimeSnapshot: { threadId: created.id, turnExecutionId: null, phase: "running" },
  });
  await useWorkspaceStore.getState().createAndSendMessage("Hello", "gpt-5.5");
  const input = createAndSend.mock.calls[0]?.[0];
  if (!input) throw new Error("createAndSendMessage was not called");
  return input;
}

describe("Start from origin", () => {
  beforeEach(() => {
    localStorage.clear();
    __clearPendingThreadCreationsForTests();
    vi.clearAllMocks();
    useWorkspaceStore.setState({
      workspaces: [workspace],
      activeWorkspaceId: workspace.id,
      threads: [],
      activeThreadId: null,
    });
    useWorkspaceStore.getState().setPendingNewThread(true);
    useWorkspaceStore.getState().setNewThreadMode("worktree");
  });

  it("sends the local branch name with startFromOrigin when the switch is on", async () => {
    useWorkspaceStore.getState().setNewThreadBranch("main", null);
    useWorkspaceStore.getState().setNewThreadStartFromOrigin(true);

    const input = await sendNewWorktree();

    expect(input).toMatchObject({ mode: "worktree", branch: "main", startFromOrigin: true });
  });

  it("starts a remote-only origin row from origin with the remote stripped, even with the switch off", async () => {
    useWorkspaceStore.getState().setNewThreadBranch("origin/feature/x", "origin");

    const input = await sendNewWorktree();

    expect(input).toMatchObject({ mode: "worktree", branch: "feature/x", startFromOrigin: true });
  });

  it("leaves startFromOrigin out when the switch is off", async () => {
    useWorkspaceStore.getState().setNewThreadBranch("main", null);

    const input = await sendNewWorktree();

    expect(input.branch).toBe("main");
    expect(input.startFromOrigin).toBeUndefined();
  });

  it("never starts a pull request from origin", async () => {
    useWorkspaceStore.getState().setNewThreadStartFromOrigin(true);
    useWorkspaceStore.getState().setNewThreadBranchFromPr("fix/login", 42);

    const input = await sendNewWorktree();

    expect(input).toMatchObject({ branch: "fix/login", pullRequestNumber: 42 });
    expect(input.startFromOrigin).toBeUndefined();
  });

  it("remembers the switch per project for the next new thread", () => {
    useWorkspaceStore.getState().setNewThreadStartFromOrigin(true);
    useWorkspaceStore.getState().setPendingNewThread(true);
    expect(useWorkspaceStore.getState().newThreadStartFromOrigin).toBe(true);

    useWorkspaceStore.setState({ activeWorkspaceId: "ws-other" });
    useWorkspaceStore.getState().setPendingNewThread(true);
    expect(useWorkspaceStore.getState().newThreadStartFromOrigin).toBe(false);
  });

  it("switching projects takes the destination's remembered switch and drops a remote pick", () => {
    useWorkspaceStore.getState().setNewThreadStartFromOrigin(true);
    useWorkspaceStore.getState().setNewThreadBranch("origin/feature/x", "origin");

    useWorkspaceStore.getState().setActiveWorkspace("ws-other");
    expect(useWorkspaceStore.getState()).toMatchObject({ newThreadStartFromOrigin: false, newThreadBranchRemote: null });

    useWorkspaceStore.getState().setActiveWorkspace(workspace.id);
    expect(useWorkspaceStore.getState().newThreadStartFromOrigin).toBe(true);
  });
});
