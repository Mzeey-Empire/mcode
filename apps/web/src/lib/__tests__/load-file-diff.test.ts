import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DiffSource } from "@/stores/diffStore";
import { mockTransport } from "@/__tests__/mocks/transport";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { loadFileDiff } from "../load-file-diff";

const mocks = {
  getTurnDiffFile: vi.mocked(mockTransport.getTurnDiffFile),
  getCumulativeDiff: vi.mocked(mockTransport.getCumulativeDiff),
  getSnapshotDiff: vi.mocked(mockTransport.getSnapshotDiff),
  getWorkingTreeDiff: vi.mocked(mockTransport.getWorkingTreeDiff),
  getBranchDiff: vi.mocked(mockTransport.getBranchDiff),
  getCommitDiff: vi.mocked(mockTransport.getCommitDiff),
};
const transport = mockTransport;
const HIDDEN = { ignoreWhitespace: true };

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset().mockResolvedValue("patch");
  useWorkspaceStore.setState({ activeWorkspaceId: "workspace-1" });
});

describe("loadFileDiff whitespace routing", () => {
  it.each<{ source: DiffSource; id: string; read: () => unknown }>([
    { source: "turn-diff", id: "git:snap-1",
      read: () => expect(mocks.getTurnDiffFile).toHaveBeenCalledWith("thread-1", "git:snap-1", "a.ts", HIDDEN) },
    { source: "since-looked", id: "4",
      read: () => expect(mocks.getCumulativeDiff).toHaveBeenCalledWith("thread-1", "a.ts", undefined, 4, HIDDEN) },
    { source: "cumulative", id: "thread-1",
      read: () => expect(mocks.getCumulativeDiff).toHaveBeenCalledWith("thread-1", "a.ts", undefined, undefined, HIDDEN) },
    { source: "staged", id: "workspace-1",
      read: () => expect(mocks.getWorkingTreeDiff).toHaveBeenCalledWith("workspace-1", true, "a.ts", undefined, "thread-1", false, undefined, HIDDEN) },
    { source: "branch", id: "main...feature",
      read: () => expect(mocks.getBranchDiff).toHaveBeenCalledWith("workspace-1", "main", "feature", "a.ts", undefined, "thread-1", HIDDEN) },
    { source: "commit", id: "abc123",
      read: () => expect(mocks.getCommitDiff).toHaveBeenCalledWith("workspace-1", "abc123", "a.ts", undefined, HIDDEN) },
  ])("asks the server to hide whitespace for $source", async ({ source, id, read }) => {
    await expect(loadFileDiff(transport, source, id, "a.ts", "thread-1", false, undefined, HIDDEN)).resolves.toBe("patch");
    read();
  });
});
