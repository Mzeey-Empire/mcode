import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectIcon } from "@mcode/contracts";
import { createMockWorkspace, mockTransport } from "@/__tests__/mocks/transport";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { useProjectIconStore } from "../projectIconStore";

function noIcon(workspaceId: string): ProjectIcon {
  return { workspaceId, source: "none", chosenMissing: false };
}

describe("project icon resolution", () => {
  beforeEach(() => {
    useProjectIconStore.setState({ iconsByWorkspaceId: {} });
    vi.mocked(mockTransport.resolveProjectIcons).mockReset();
    vi.mocked(mockTransport.resolveProjectIcons).mockImplementation(async (ids) => ids.map(noIcon));
  });

  it("resolves every listed project in batches the server accepts", async () => {
    const workspaces = Array.from({ length: 300 }, (_, index) => createMockWorkspace({ id: `ws-${index}` }));
    vi.mocked(mockTransport.listWorkspaces).mockResolvedValueOnce(workspaces);

    await useWorkspaceStore.getState().loadWorkspaces();

    await vi.waitFor(() => expect(Object.keys(useProjectIconStore.getState().iconsByWorkspaceId)).toHaveLength(300));
    const batches = vi.mocked(mockTransport.resolveProjectIcons).mock.calls.map(([ids]) => ids);
    expect(batches.map((ids) => ids.length)).toEqual([256, 44]);
    expect(batches.flat()).toEqual(workspaces.map((workspace) => workspace.id));
  });

  it("asks once per id when the same project is requested twice", async () => {
    await useProjectIconStore.getState().resolve(["ws-1", "ws-1", "ws-2"]);
    expect(vi.mocked(mockTransport.resolveProjectIcons).mock.calls).toEqual([[["ws-1", "ws-2"]]]);
  });
});
