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
    workspaceId = (await workspaceRepo.create("Patch test", process.cwd())).id;
  });

  afterAll(async () => {
    db.close(true);
    await owned.close();
  });

  beforeEach(() => {
    fake = new FakeGitExecutor();
    service = new GitComparisonService(workspaceRepo, fake);
  });

  it.each([
    { error: Object.assign(new Error("Git command timed out after 5000 ms"), { killed: true, stderr: "" }), kind: "timeout", detail: "Git command timed out after 5000 ms" },
    { error: Object.assign(new Error("Git command timed out after 5000 ms"), { killed: true, stderr: " \n" }), kind: "timeout", detail: "Git command timed out after 5000 ms" },
    { error: Object.assign(new Error("timeout"), { killed: true, stderr: "git timed out\n" }), kind: "timeout", detail: "git timed out\n" },
    { error: Object.assign(new Error("exit 128"), { stderr: "fatal: bad object\n" }), kind: "git-error", detail: "fatal: bad object\n" },
  ])("returns $kind and preserves raw stderr", async ({ error, kind, detail }) => {
    fake.setResponse(["diff", "--name-status", "-z", "--find-renames", "--find-copies", "--cached"], error);
    expect(await service.readReviewComparison(workspaceId, "staged", {})).toMatchObject({ status: "failed", failure: { kind, detail } });
  });

  it("reports the shortstat count rather than the parser's first over-limit record", async () => {
    fake.setResponse(["diff", "--name-status", "-z", "--find-renames", "--find-copies", "--cached"],
      { stdout: Array.from({ length: 10_001 }, (_, index) => `M\0file-${index}.ts\0`).join(""), stderr: "" });
    fake.setResponse(["diff", "--shortstat", "--find-renames", "--find-copies", "--cached"], { stdout: " 12480 files changed, 12480 insertions(+)\n", stderr: "" });
    expect(await service.readReviewComparison(workspaceId, "staged", {})).toEqual({ status: "too-many-files", fileCount: 12_480, limit: 10_000 });
  });

  it("rejects too many untracked files before preparing a temporary index", async () => {
    fake.setResponse(["ls-files", "--others", "--exclude-standard", "-z"],
      { stdout: Array.from({ length: 10_001 }, (_, index) => `file-${index}.ts\0`).join(""), stderr: "" });
    expect(await service.readReviewComparison(workspaceId, "unstaged", {}))
      .toEqual({ status: "too-many-files", fileCount: 10_001, limit: 10_000 });
    expect(fake.calls.map((call) => call.args)).toEqual([["-C", process.cwd(), "ls-files", "--others", "--exclude-standard", "-z"]]);
  });

  it.each([
    { error: Object.assign(new Error("Git command timed out after 5000 ms"), { killed: true, code: null, stderr: "" }), kind: "timeout" },
    { error: Object.assign(new Error("not a repository"), { code: 128, stderr: "fatal: not a git repository" }), kind: "git-error" },
  ])("preserves $kind from the HEAD probe", async ({ error, kind }) => {
    fake.setResponse(["rev-parse", "--verify", "--quiet", "HEAD"], error);
    expect(await service.readReviewComparison(workspaceId, "uncommitted", {}))
      .toMatchObject({ status: "failed", failure: { kind } });
  });

  it("recognizes only the quiet missing-HEAD exit as an unborn branch", async () => {
    fake.setResponse(["rev-parse", "--verify", "--quiet", "HEAD"], Object.assign(new Error("exit 1"), { code: 1, stderr: "" }));
    expect(await service.readReviewComparison(workspaceId, "branch", {})).toEqual({ status: "unavailable", reason: "unborn" });
  });

  it("returns unsafe-ref before executing the comparison", async () => {
    expect(await service.readReviewComparison(workspaceId, "branch", { base: "--output=outside", compare: "HEAD" })).toMatchObject({ status: "failed", failure: { kind: "unsafe-ref" } });
    expect(fake.calls).toEqual([]);
  });

  it("distinguishes an empty comparison from a missing checkout", async () => {
    expect(await service.readReviewComparison(workspaceId, "staged", {})).toEqual({ status: "ready", comparison: { files: [], additions: 0, deletions: 0 } });
    fake.reset();
    expect(await service.readReviewComparison(workspaceId, "staged", {}, `${process.cwd()}/missing-review-checkout`)).toMatchObject({ status: "failed", failure: { kind: "worktree-missing" } });
    expect(fake.calls).toEqual([]);
  });

  describe.each([
    {
      view: "commit",
      args: ["diff", "--find-renames", "abc1234~1..abc1234", "--", "example.txt"],
      read: (maxLines?: number) => service.readCommitDiff(workspaceId, "abc1234", { filePath: "example.txt", maxLines }),
    },
    {
      view: "unstaged",
      args: ["-c", "diff.autoRefreshIndex=false", "diff", "--find-renames", "--", ":(literal)example.txt"],
      read: (maxLines?: number) => service.readWorkingTreeDiff(workspaceId, false, { filePath: "example.txt", maxLines }),
    },
    {
      view: "staged",
      args: ["-c", "diff.autoRefreshIndex=false", "diff", "--find-renames", "--cached", "--", ":(literal)example.txt"],
      read: (maxLines?: number) => service.readWorkingTreeDiff(workspaceId, true, { filePath: "example.txt", maxLines }),
    },
    {
      view: "branch",
      args: ["diff", "--find-renames", "main...HEAD", "--", "example.txt"],
      read: (maxLines?: number) => service.readBranchComparisonDiff(
        workspaceId, "main", "HEAD", { filePath: "example.txt", maxLines },
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
    await expect(service.readCommitDiff(workspaceId, "abc1234", { maxLines: 20 })).resolves.toBe(patch);
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
      status: "ready", comparison: { files: [
        { path: "image.bin", previousPath: null, changeType: "modified", binary: true, additions: null, deletions: null, untracked: false },
        { path: "new.txt", previousPath: "old.txt", changeType: "renamed", binary: false, additions: 2, deletions: 1, untracked: false },
        { path: "notes.md", previousPath: null, changeType: "added", binary: false, additions: 3, deletions: 0, untracked: false },
      ], additions: 5, deletions: 1 },
    });
  });

  it.each([false, true])("filters comparison files and totals only when ignoreWhitespace is %s", async (ignoreWhitespace) => {
    const suffix = ignoreWhitespace ? ["--cached", "-w"] : ["--cached"];
    fake.setResponse(["diff", "--name-status", "-z", "--find-renames", "--find-copies", ...suffix], {
      stdout: "M\0space.txt\0M\0code.txt\0M\0binary.bin\0A\0added.txt\0D\0deleted.txt\0R100\0old.txt\0renamed.txt\0C100\0source.txt\0copied.txt\0", stderr: "",
    });
    fake.setResponse(["diff", "--numstat", "-z", "--find-renames", "--find-copies", ...suffix], {
      stdout: "2\t1\tcode.txt\0-\t-\tbinary.bin\0" + (ignoreWhitespace ? "" : "3\t3\tspace.txt\0"), stderr: "",
    });
    const result = await service.readReviewComparison(workspaceId, "staged", { ignoreWhitespace });
    if (result.status !== "ready") throw new Error(JSON.stringify(result));
    expect(result.comparison.files.map((file) => file.path)).toEqual(ignoreWhitespace
      ? ["added.txt", "binary.bin", "code.txt", "copied.txt", "deleted.txt", "renamed.txt"]
      : ["added.txt", "binary.bin", "code.txt", "copied.txt", "deleted.txt", "renamed.txt", "space.txt"]);
    expect(result.comparison.additions).toBe(ignoreWhitespace ? 2 : 5);
    expect(result.comparison.deletions).toBe(ignoreWhitespace ? 1 : 4);
    expect(result.comparison.files.find((file) => file.path === "binary.bin")).toMatchObject({ binary: true, additions: null, deletions: null });
    expect(fake.calls.map((call) => call.args.includes("-w"))).toEqual([ignoreWhitespace, ignoreWhitespace]);
  });

  it("applies the file cap after hiding whitespace-only modifications", async () => {
    fake.setResponse(["diff", "--name-status", "-z", "--find-renames", "--find-copies", "--cached", "-w"], {
      stdout: Array.from({ length: 10_001 }, (_, index) => `M\0file-${index}.ts\0`).join(""), stderr: "",
    });
    expect(await service.readReviewComparison(workspaceId, "staged", { ignoreWhitespace: true }))
      .toEqual({ status: "ready", comparison: { files: [], additions: 0, deletions: 0 } });
  });

  it("keeps -w in the shortstat cap fallback", async () => {
    fake.setResponse(["diff", "--name-status", "-z", "--find-renames", "--find-copies", "--cached", "-w"], {
      stdout: Array.from({ length: 10_001 }, (_, index) => `A\0file-${index}.ts\0`).join(""), stderr: "",
    });
    fake.setResponse(["diff", "--shortstat", "--find-renames", "--find-copies", "--cached", "-w"], {
      stdout: " 12480 files changed, 12480 insertions(+)\n", stderr: "",
    });
    expect(await service.readReviewComparison(workspaceId, "staged", { ignoreWhitespace: true }))
      .toEqual({ status: "too-many-files", fileCount: 12_480, limit: 10_000 });
  });

  it("reads filtered patches for working tree, staged, commit and branch views", async () => {
    fake.setResponse(["-c", "diff.autoRefreshIndex=false", "diff", "--find-renames", "-w", "--", ":(literal)example.txt"], { stdout: PATCH, stderr: "" });
    fake.setResponse(["-c", "diff.autoRefreshIndex=false", "diff", "--find-renames", "-w", "--cached", "--", ":(literal)example.txt"], { stdout: PATCH, stderr: "" });
    fake.setResponse(["diff", "--find-renames", "abc1234~1..abc1234", "-w", "--", "example.txt"], { stdout: PATCH, stderr: "" });
    fake.setResponse(["diff", "--find-renames", "main...HEAD", "-w", "--", "example.txt"], { stdout: PATCH, stderr: "" });
    const options = { filePath: "example.txt", ignoreWhitespace: true };
    expect(await service.readWorkingTreeDiff(workspaceId, false, options)).toBe(PATCH);
    expect(await service.readWorkingTreeDiff(workspaceId, true, options)).toBe(PATCH);
    expect(await service.readCommitDiff(workspaceId, "abc1234", options)).toBe(PATCH);
    expect(await service.readBranchComparisonDiff(workspaceId, "main", "HEAD", options)).toBe(PATCH);
  });

});
