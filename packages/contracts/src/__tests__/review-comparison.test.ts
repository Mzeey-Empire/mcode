import { describe, expect, it } from "vitest";
import { ReviewComparisonSchema, ReviewComparisonResultSchema } from "../models/review-comparison.js";
import { WS_METHODS } from "../ws/methods.js";

describe("ReviewComparisonSchema", () => {
  it("preserves both literal rename paths in a working-tree request", () => {
    const params = {
      workspaceId: "workspace", threadId: "draft", staged: false, untracked: true,
      filePath: "new[1].txt", previousPath: "old[1].txt",
    };
    expect(WS_METHODS()["git.workingTreeDiff"].params.parse(params)).toEqual(params);
  });
  it("accepts batched rename and binary metadata", () => {
    const result = ReviewComparisonSchema().parse({
      files: [
        {
          path: "src/new.ts",
          previousPath: "src/old.ts",
          changeType: "renamed",
          binary: false,
          additions: 4, deletions: 2, untracked: true,
        },
        {
          path: "assets/logo.png",
          previousPath: null,
          changeType: "modified",
          binary: true,
          additions: null, deletions: null, untracked: false,
        },
      ],
      additions: 4,
      deletions: 2,
    });

    expect(result.files).toHaveLength(2);
    expect(result.files[0]?.previousPath).toBe("src/old.ts");
    expect(result.files[1]?.binary).toBe(true);
    expect(result.files[0]).toMatchObject({ additions: 4, deletions: 2, untracked: true });
    expect(result.files[1]).toMatchObject({ additions: null, deletions: null, untracked: false });
  });
  it.each([-1, 1.5, undefined])("rejects invalid or missing per-file counts: %s", (additions) => {
    expect(ReviewComparisonSchema().safeParse({
      files: [{ path: "notes.md", previousPath: null, changeType: "added", binary: false, additions, deletions: 0, untracked: true }],
      additions: 0, deletions: 0,
    }).success).toBe(false);
  });
});

describe("ReviewComparisonResult", () => {
  it.each([
    { status: "ready", comparison: { files: [], additions: 0, deletions: 0 } },
    { status: "too-many-files", fileCount: 12_480, limit: 10_000 },
    ...["unborn", "no-base", "snapshot-expired", "snapshot-pruned"].map((reason) => ({ status: "unavailable", reason })),
    ...["timeout", "worktree-missing", "unsafe-ref", "git-error"].map((kind) => ({ status: "failed", failure: { kind, summary: "Could not load", detail: "raw stderr\n" } })),
  ])("round trips $status", (value) => {
    expect(ReviewComparisonResultSchema().parse(value)).toEqual(value);
    expect(WS_METHODS()["git.reviewComparison"].result.parse(value)).toEqual(value);
    expect(WS_METHODS()["turnDiff.getComparison"].result.parse(value)).toEqual(value);
    expect(WS_METHODS()["snapshot.getCumulativeDiffStats"].result.parse(value)).toEqual(value);
  });

  it.each([null, {}, { status: "ready" }, { status: "too-many-files", fileCount: 10_001, limit: 9999 },
    { status: "too-many-files", fileCount: -1, limit: 10_000 }, { status: "unavailable", reason: "unknown" },
    { status: "failed", failure: { kind: "git-error", summary: "Oops" } },
  ])("rejects incomplete or unrecognised outcomes", (value) => {
    expect(ReviewComparisonResultSchema().safeParse(value).success).toBe(false);
  });
});
