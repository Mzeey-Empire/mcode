// @vitest-environment jsdom
import { createMockThread, createMockWorkspace } from "@mcode/contracts/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockTransport } from "../../../../__tests__/mocks/transport";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

const workspace = createMockWorkspace({ id: "ws-reload" });
const otherWorkspace = createMockWorkspace({ id: "ws-other" });

/** A fresh module graph stands in for the page after a reload; session storage survives it. */
async function loadStoreAfterReload() {
  vi.resetModules();
  const { useWorkspaceStore } = await import("../workspaceStore");
  useWorkspaceStore.setState({ workspaces: [workspace, otherWorkspace], activeWorkspaceId: null, activeThreadId: null });
  return useWorkspaceStore;
}

describe("reload reopens the open thread", () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.clearAllMocks();
  });

  it("reopens the thread and its project that were open before the reload", async () => {
    const open = createMockThread({ id: "open-thread", workspace_id: workspace.id, status: "active" });
    const before = await loadStoreAfterReload();
    before.getState().setActiveWorkspace(workspace.id);
    before.getState().setActiveThread(open.id);

    vi.mocked(mockTransport.listAllThreads).mockResolvedValue([open]);
    const after = await loadStoreAfterReload();
    await after.getState().hydrateThreads();

    expect(after.getState()).toMatchObject({ activeWorkspaceId: workspace.id, activeThreadId: open.id });
  });

  it("reopens a thread started from New thread, under its durable id", async () => {
    const created = createMockThread({ id: "created-thread", workspace_id: workspace.id, status: "active" });
    vi.mocked(mockTransport.createAndSendMessage).mockResolvedValue({
      ...created,
      runtimeSnapshot: { threadId: created.id, turnExecutionId: null, phase: "running" },
    });
    const before = await loadStoreAfterReload();
    before.getState().setActiveWorkspace(workspace.id);
    before.getState().setPendingNewThread(true);
    await before.getState().createAndSendMessage("Hello", "gpt-5.6-luna");

    vi.mocked(mockTransport.listAllThreads).mockResolvedValue([created]);
    const after = await loadStoreAfterReload();
    await after.getState().hydrateThreads();

    expect(after.getState().activeThreadId).toBe(created.id);
  });

  it.each(["archived", "deleted"] as const)("falls back to New thread when the open thread was %s", async (status) => {
    const before = await loadStoreAfterReload();
    before.getState().setActiveThread("gone-thread");

    vi.mocked(mockTransport.listAllThreads).mockResolvedValue([
      createMockThread({ id: "gone-thread", workspace_id: workspace.id, status }),
    ]);
    const after = await loadStoreAfterReload();
    await after.getState().hydrateThreads();

    expect(after.getState()).toMatchObject({ activeWorkspaceId: null, activeThreadId: null });
  });

  it("falls back to New thread when the open thread no longer exists", async () => {
    const before = await loadStoreAfterReload();
    before.getState().setActiveThread("missing-thread");

    vi.mocked(mockTransport.listAllThreads).mockResolvedValue([]);
    const after = await loadStoreAfterReload();
    await after.getState().hydrateThreads();

    expect(after.getState().activeThreadId).toBeNull();
  });

  it("does not pull the user back after a reconnect hydration", async () => {
    const open = createMockThread({ id: "open-thread", workspace_id: workspace.id });
    const before = await loadStoreAfterReload();
    before.getState().setActiveThread(open.id);

    vi.mocked(mockTransport.listAllThreads).mockResolvedValue([open]);
    const after = await loadStoreAfterReload();
    await after.getState().hydrateThreads();
    after.getState().beginNewThread(otherWorkspace.id);
    await after.getState().hydrateThreads();

    expect(after.getState()).toMatchObject({ activeWorkspaceId: otherWorkspace.id, activeThreadId: null });
  });
});
