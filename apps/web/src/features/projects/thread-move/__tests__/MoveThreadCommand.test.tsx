import { createMockThread, createMockThreadAttention, createMockWorkspace } from "@mcode/contracts/testing";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearCommands, executeCommand, getCommand } from "@/lib/command-registry";
import { threadAttentionStore } from "@/features/thread-attention/thread-attention-store";
import { useThreadStore } from "@/stores/threadStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { MoveThreadCommand } from "../MoveThreadCommand";
import { closeMoveThreadDialog, useMoveThreadStore } from "../move-thread-store";

const PROJECT = createMockWorkspace({ id: "ws-project", name: "alpha", path: "/work/alpha" });
const HIDDEN = createMockWorkspace({ id: "ws-hidden", name: "No project", path: "/home/.mcode/no-project/a", kind: "no_project", is_git_repo: false });
const NO_PROJECT_THREAD = createMockThread({ id: "t-loose", workspace_id: HIDDEN.id });
const PROJECT_THREAD = createMockThread({ id: "t-project", workspace_id: PROJECT.id });

function select(threads: ReturnType<typeof createMockThread>[], activeThreadId: string | null): void {
  useWorkspaceStore.setState({ workspaces: [PROJECT, HIDDEN], threads, activeThreadId });
}

const entry = () => getCommand("thread.moveToProject");

describe("MoveThreadCommand", () => {
  beforeEach(() => {
    useThreadStore.setState({ runningThreadIds: new Set() });
  });

  afterEach(() => {
    cleanup();
    clearCommands();
    closeMoveThreadDialog();
    useWorkspaceStore.setState({ workspaces: [], threads: [], activeThreadId: null, activeWorkspaceId: null });
    useThreadStore.setState({ runningThreadIds: new Set() });
    threadAttentionStore.setState({ byThreadId: {}, visitBaselines: {}, onScreenThreadId: null });
  });

  it("offers Move thread to project for the selected open No project thread, and opens the dialog for it", () => {
    select([NO_PROJECT_THREAD, PROJECT_THREAD], NO_PROJECT_THREAD.id);
    render(<MoveThreadCommand />);

    expect(entry()?.title).toBe("Move thread to project…");
    expect(entry()?.disabledReason).toBeUndefined();
    expect(executeCommand("thread.moveToProject")).toBe(true);
    expect(useMoveThreadStore.getState().threadId).toBe(NO_PROJECT_THREAD.id);
  });

  it.each([
    ["a project thread", [NO_PROJECT_THREAD, PROJECT_THREAD], PROJECT_THREAD.id],
    ["no thread", [NO_PROJECT_THREAD], null],
    ["a closed No project thread", [{ ...NO_PROJECT_THREAD, user_completed_at: "2026-11-20T10:00:00.000Z" }], NO_PROJECT_THREAD.id],
  ] as const)("does not offer it for %s", (_name, threads, activeThreadId) => {
    select([...threads], activeThreadId);
    render(<MoveThreadCommand />);

    expect(entry()).toBeUndefined();
  });

  it("withdraws the entry when the selection moves to a project thread", () => {
    select([NO_PROJECT_THREAD, PROJECT_THREAD], NO_PROJECT_THREAD.id);
    render(<MoveThreadCommand />);
    expect(entry()).toBeDefined();

    act(() => useWorkspaceStore.setState({ activeThreadId: PROJECT_THREAD.id }));

    expect(entry()).toBeUndefined();
  });

  it("disables the entry with the menu's reason while the turn runs, and enables it again when it stops", () => {
    select([NO_PROJECT_THREAD], NO_PROJECT_THREAD.id);
    render(<MoveThreadCommand />);

    act(() => useThreadStore.setState({ runningThreadIds: new Set([NO_PROJECT_THREAD.id]) }));
    expect(entry()?.disabledReason).toBe("This thread is running");
    expect(executeCommand("thread.moveToProject")).toBe(false);
    expect(useMoveThreadStore.getState().threadId).toBeNull();

    act(() => useThreadStore.setState({ runningThreadIds: new Set() }));
    expect(entry()?.disabledReason).toBeUndefined();
    expect(executeCommand("thread.moveToProject")).toBe(true);
  });

  it("disables the entry while work still runs in the background", () => {
    select([NO_PROJECT_THREAD], NO_PROJECT_THREAD.id);
    render(<MoveThreadCommand />);

    act(() => threadAttentionStore.getState().apply(createMockThreadAttention({ threadId: NO_PROJECT_THREAD.id, descendants: "running" })));

    expect(entry()?.disabledReason).toBe("Work is still running in the background");
  });
});
