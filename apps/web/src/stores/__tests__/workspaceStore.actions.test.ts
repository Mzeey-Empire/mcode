import { describe, it, expect, vi, beforeEach } from "vitest";
import { useWorkspaceStore, type WorkspaceRpcCall } from "../workspaceStore";
import type { Workspace } from "@/transport/types";

function makeWs(overrides?: Partial<Workspace>): Workspace {
  return {
    id: "ws-1",
    name: "test",
    path: "/tmp/test",
    provider_config: {},
    is_git_repo: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    pinned: false,
    last_opened_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  useWorkspaceStore.setState({ workspaces: [makeWs()], activeWorkspaceId: null });
});

describe("workspaceStore pin/remove/touch", () => {
  it("setActiveWorkspace calls touchLastOpened RPC", async () => {
    const call = vi.fn().mockResolvedValue({ ok: true });
    await useWorkspaceStore.getState().setActiveWorkspace("ws-1", call as unknown as WorkspaceRpcCall);
    expect(call).toHaveBeenCalledWith("workspace.touchLastOpened", { id: "ws-1" });
  });

  it("pinWorkspace updates local state optimistically and calls RPC", async () => {
    const call = vi.fn().mockResolvedValue({ ok: true });
    await useWorkspaceStore.getState().pinWorkspace("ws-1", true, call as unknown as WorkspaceRpcCall);
    expect(useWorkspaceStore.getState().workspaces[0].pinned).toBe(true);
    expect(call).toHaveBeenCalledWith("workspace.pin", { id: "ws-1", pinned: true });
  });

  it("pinWorkspace reverts on RPC failure", async () => {
    const call = vi.fn().mockRejectedValue(new Error("network error"));
    try {
      await useWorkspaceStore.getState().pinWorkspace("ws-1", true, call as unknown as WorkspaceRpcCall);
    } catch { /* expected */ }
    expect(useWorkspaceStore.getState().workspaces[0].pinned).toBe(false);
  });

  it("removeRecent updates local state optimistically and calls RPC", async () => {
    useWorkspaceStore.setState({
      workspaces: [makeWs({ last_opened_at: Date.now(), pinned: true })],
    });
    const call = vi.fn().mockResolvedValue({ ok: true });
    await useWorkspaceStore.getState().removeRecent("ws-1", call as unknown as WorkspaceRpcCall);
    const ws = useWorkspaceStore.getState().workspaces[0];
    expect(ws.last_opened_at).toBeNull();
    expect(ws.pinned).toBe(false);
    expect(call).toHaveBeenCalledWith("workspace.removeRecent", { id: "ws-1" });
  });
});
