import "reflect-metadata";
import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openReadOnlyDatabase } from "../../../../runtime/persistence/sqlite/read-only-database.js";
import { createOwnedTestDatabase, type OwnedTestDatabase } from "../../testing/owned-test-database.js";
import { WorkspaceRepo } from "../../persistence/workspace-repo.js";
import { FakeGitExecutor } from "../execution/fake-git-executor.js";
import { GitComparisonService } from "../git-comparison-service.js";

const PATCH = [
  "diff --git a/example.txt b/example.txt",
  "index 1111111..2222222 100644",
  "--- a/example.txt",
  "+++ b/example.txt",
  "@@ -1,3 +1,3 @@",
  "-before",
  "+after",
  " keep",
  " ",
  "",
].join("\n");

describe("GitComparisonService unified output", () => {
  let db: Database;
  let owned: OwnedTestDatabase;
  let workspaceRepo: WorkspaceRepo;
  let workspaceId: string;
  let fake: FakeGitExecutor;
  let service: GitComparisonService;

  beforeAll(async () => {
    owned = createOwnedTestDatabase();
    db = openReadOnlyDatabase(owned.db.filename);
    workspaceRepo = new WorkspaceRepo(db, owned.writer);
    workspaceId = (await workspaceRepo.create("Patch test", "/repo")).id;
  });

  afterAll(async () => {
    db.close(true);
    await owned.close();
  });

  beforeEach(() => {
    fake = new FakeGitExecutor();
    service = new GitComparisonService(workspaceRepo, fake);
  });

  describe.each([
    {
      view: "commit",
      args: ["diff", "--find-renames", "abc1234~1..abc1234", "--", "example.txt"],
      read: (maxLines?: number) => service.readCommitDiff(workspaceId, "abc1234", "example.txt", maxLines),
    },
    {
      view: "unstaged",
      args: ["diff", "--find-renames", "--", "example.txt"],
      read: (maxLines?: number) => service.readWorkingTreeDiff(workspaceId, false, "example.txt", maxLines),
    },
    {
      view: "staged",
      args: ["diff", "--find-renames", "--cached", "--", "example.txt"],
      read: (maxLines?: number) => service.readWorkingTreeDiff(workspaceId, true, "example.txt", maxLines),
    },
    {
      view: "branch",
      args: ["diff", "--find-renames", "main...HEAD", "--", "example.txt"],
      read: (maxLines?: number) => service.readBranchComparisonDiff(
        workspaceId, "main", "HEAD", "example.txt", maxLines,
      ),
    },
  ])("$view", ({ args, read }) => {
    it("preserves blank context in full and limited patches, and returns empty diffs", async () => {
      await expect(read()).resolves.toBe("");
      fake.setResponse(args, { stdout: PATCH, stderr: "" });

      await expect(read()).resolves.toBe(PATCH);
      await expect(read(20)).resolves.toBe(PATCH);
      await expect(read(9)).resolves.toBe(PATCH.slice(0, -1));
      await expect(read(8)).resolves.toBe("");
    });
  });

  it("preserves a whitespace-only added line in the root commit fallback", async () => {
    const patch = [
      "diff --git a/example.txt b/example.txt",
      "new file mode 100644",
      "index 0000000..1111111",
      "--- /dev/null",
      "+++ b/example.txt",
      "@@ -0,0 +1,2 @@",
      "+first",
      "+  ",
      "",
    ].join("\n");
    fake.setResponse(
      ["diff", "--find-renames", "abc1234~1..abc1234"],
      new Error("unknown parent"),
    );
    fake.setResponse(
      ["diff", "--find-renames", "4b825dc642cb6eb9a060e54bf8d69288fbee4904..abc1234"],
      { stdout: patch, stderr: "" },
    );

    await expect(service.readCommitDiff(workspaceId, "abc1234")).resolves.toBe(patch);
    await expect(service.readCommitDiff(workspaceId, "abc1234", undefined, 20)).resolves.toBe(patch);
  });

  it("still trims diff stat summaries", async () => {
    fake.setResponse(
      ["diff", "--stat", "main...HEAD"],
      { stdout: " example.txt | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n", stderr: "" },
    );

    await expect(service.readBranchComparisonDiffStat("/repo", "main", "HEAD")).resolves.toBe(
      "example.txt | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)",
    );
  });

  it("preserves per-file counts, rename destinations, and binary nulls", async () => {
    fake.setResponse(["diff", "--name-status", "-z", "--find-renames", "--find-copies", "--cached"], {
      stdout: "A\0notes.md\0R100\0old.txt\0new.txt\0M\0image.bin\0", stderr: "",
    });
    fake.setResponse(["diff", "--numstat", "-z", "--find-renames", "--find-copies", "--cached"], {
      stdout: "3\t0\tnotes.md\0" + "2\t1\t\0old.txt\0new.txt\0-\t-\timage.bin\0", stderr: "",
    });
    expect(await service.readReviewComparison(workspaceId, "staged", {})).toEqual({
      files: [
        { path: "image.bin", previousPath: null, changeType: "modified", binary: true, additions: null, deletions: null, untracked: false },
        { path: "new.txt", previousPath: "old.txt", changeType: "renamed", binary: false, additions: 2, deletions: 1, untracked: false },
        { path: "notes.md", previousPath: null, changeType: "added", binary: false, additions: 3, deletions: 0, untracked: false },
      ], additions: 5, deletions: 1,
    });
  });

  it("rejects over 10,000 untracked files before resolving or building an index", async () => {
    fake.setResponse(["ls-files", "--others", "--exclude-standard", "-z"], {
      stdout: Array.from({ length: 10_001 }, (_, index) => `file-${index}\0`).join(""), stderr: "",
    });
    await expect(service.readReviewComparison(workspaceId, "unstaged", {})).rejects.toThrow();
    expect(fake.calls.map((call) => call.args)).toEqual([["-C", "/repo", "ls-files", "--others", "--exclude-standard", "-z"]]);
  });
});
