import { describe, expect, it } from "vitest";
import { ReviewComparisonSchema } from "../models/review-comparison.js";
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
