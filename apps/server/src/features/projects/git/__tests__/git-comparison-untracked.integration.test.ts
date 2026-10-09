import "reflect-metadata";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSPromises from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { createOwnedTestDatabase, type OwnedTestDatabase } from "../../testing/owned-test-database.js";
import { WorkspaceRepo } from "../../persistence/workspace-repo.js";
import { GitComparisonService, ReviewComparisonError } from "../git-comparison-service.js";
import { RealGitExecutor } from "../execution/real-git-executor.js";
import type { GitExecutor } from "../execution/index.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, copyFile: vi.fn(actual.copyFile), unlink: vi.fn(actual.unlink) };
});

describe("Review comparisons with the real Git index", () => {
  let owned: OwnedTestDatabase;
  let repo: WorkspaceRepo;
  let cwd: string;
  let service: GitComparisonService;
  const executor = new RealGitExecutor();
  const git = (...args: string[]) => NodeChildProcess.execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
  const write = (path: string, content: string) => NodeFS.writeFileSync(NodePath.join(cwd, path), content);
  const indexHash = () => NodeFS.existsSync(NodePath.join(cwd, ".git/index"))
    ? NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(NodePath.join(cwd, ".git/index"))).digest("hex") : null;
  const temporaryIndexes = () => NodeFS.readdirSync(NodePath.join(cwd, ".git")).filter((name) => name.startsWith("mcode-review-index-"));
  async function read(view: "unstaged" | "uncommitted" | "staged") {
    const before = indexHash();
    try { return await service.readReviewComparison("fixture", view, {}, cwd); }
    finally {
      expect(indexHash()).toBe(before);
      expect(temporaryIndexes()).toEqual([]);
    }
  }
  function commit() {
    git("add", ".");
    git("-c", "core.hooksPath=/dev/null", "commit", "-m", "fixture");
  }
  beforeAll(() => {
    owned = createOwnedTestDatabase();
    repo = new WorkspaceRepo(owned.db, owned.writer);
  });
  afterAll(async () => { await owned.close(); });
  beforeEach(() => {
    cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-review-"));
    git("init", "-b", "main");
    git("config", "user.name", "Review Test");
    git("config", "user.email", "review@example.test");
    git("config", "core.autocrlf", "false");
    service = new GitComparisonService(repo, executor);
  });
  afterEach(() => { NodeFS.rmSync(cwd, { recursive: true, force: true }); });

  it("lists literal untracked paths with counts in an unborn repository without creating the real index", async () => {
    write("[notes].md", "one\ntwo\n");
    for (const view of ["unstaged", "uncommitted"] as const) {
      expect(await read(view)).toEqual({
        files: [{ path: "[notes].md", previousPath: null, changeType: "added", binary: false, additions: 2, deletions: 0, untracked: true }],
        additions: 2, deletions: 0,
      });
    }
    expect(indexHash()).toBeNull();
    const patch = await service.readWorkingTreeDiff("fixture", false, "[notes].md", undefined, cwd, true);
    expect(patch).toContain("@@ -0,0 +1,2 @@\n+one\n+two\n");
    expect(indexHash()).toBeNull();
    expect(temporaryIndexes()).toEqual([]);
  });

  it("pairs a deleted tracked file with its untracked new name", async () => {
    write("old.txt", "one\ntwo\nthree\n");
    commit();
    NodeFS.renameSync(NodePath.join(cwd, "old.txt"), NodePath.join(cwd, "new.txt"));
    expect(git("status", "--porcelain")).toBe("D old.txt\n?? new.txt");
    for (const view of ["unstaged", "uncommitted"] as const) {
      expect((await read(view)).files).toEqual([
        { path: "new.txt", previousPath: "old.txt", changeType: "renamed", binary: false, additions: 0, deletions: 0, untracked: true },
      ]);
    }
  });

  it.each([false, true])("honours global excludes with observed execution %s", async (observed) => {
    const config = NodePath.join(cwd, ".git", "test-global-config");
    const excludes = NodePath.join(cwd, ".git", "test-global-excludes");
    NodeFS.writeFileSync(excludes, "*.global-ignore\n");
    git("config", "--file", config, "core.excludesFile", excludes);
    vi.stubEnv("GIT_CONFIG_GLOBAL", config);
    if (observed) {
      service = new GitComparisonService(repo, {
        exec: (args, options) => executor.exec(args, { ...options, onStdout: () => {} }),
      });
    }
    try {
      write("hidden.global-ignore", "ignored\n");
      write("visible.txt", "visible\n");
      expect(git("status", "--porcelain")).toBe("?? visible.txt");
      expect((await read("unstaged")).files).toEqual([
        { path: "visible.txt", previousPath: null, changeType: "added", binary: false, additions: 1, deletions: 0, untracked: true },
      ]);
      expect(await service.readReviewState("fixture", cwd)).toEqual({
        isGitRepo: true, head: null, branch: "main",
        uncommitted: { staged: 0, unstaged: 0, untracked: 1 },
        commitsAhead: null, branchDefault: { unavailable: "unborn" },
      });
    } finally { vi.unstubAllEnvs(); }
  });

  it("keeps staged and unstaged edits distinct, preserves intent-to-add, and excludes ignored files", async () => {
    write("tracked.txt", "base\n");
    write(".gitignore", "ignored.txt\n");
    commit();
    write("tracked.txt", "base\nstaged\n");
    git("add", "tracked.txt");
    write("tracked.txt", "base\nstaged\nunstaged\n");
    write("intent.txt", "intent\n");
    git("add", "-N", "intent.txt");
    write("ignored.txt", "ignored\n");
    expect(git("status", "--porcelain")).toBe("A intent.txt\nMM tracked.txt");
    expect((await read("unstaged")).files).toEqual([
      { path: "intent.txt", previousPath: null, changeType: "added", binary: false, additions: 1, deletions: 0, untracked: false },
      { path: "tracked.txt", previousPath: null, changeType: "modified", binary: false, additions: 1, deletions: 0, untracked: false },
    ]);
    expect((await read("uncommitted")).files).toEqual([
      { path: "intent.txt", previousPath: null, changeType: "added", binary: false, additions: 1, deletions: 0, untracked: false },
      { path: "tracked.txt", previousPath: null, changeType: "modified", binary: false, additions: 2, deletions: 0, untracked: false },
    ]);
    expect((await read("staged")).files).toEqual([
      { path: "tracked.txt", previousPath: null, changeType: "modified", binary: false, additions: 1, deletions: 0, untracked: false },
    ]);
  });

  it("preserves unmerged stages and returns one entry for the conflicted path", async () => {
    write("conflict.txt", "base\n");
    commit();
    git("checkout", "-b", "other");
    write("conflict.txt", "other\n");
    commit();
    git("checkout", "main");
    write("conflict.txt", "main\n");
    commit();
    expect(() => git("merge", "other")).toThrow();
    expect(git("status", "--porcelain")).toBe("UU conflict.txt");
    expect((await read("unstaged")).files).toEqual([
      { path: "conflict.txt", previousPath: null, changeType: "modified", binary: false, additions: 4, deletions: 0, untracked: false },
    ]);
    expect((await read("uncommitted")).files).toEqual([
      { path: "conflict.txt", previousPath: null, changeType: "modified", binary: false, additions: 4, deletions: 0, untracked: false },
    ]);
  });

  it("reports a corrupt index as a typed Git error and preserves its bytes", async () => {
    NodeFS.writeFileSync(NodePath.join(cwd, ".git/index"), "unreadable index data");
    await expect(read("unstaged")).rejects.toBeInstanceOf(ReviewComparisonError);
  });

  it("never substitutes an empty index when copying the real index fails", async () => {
    write("tracked.txt", "tracked\n");
    commit();
    write("notes.md", "notes\n");
    const failure = Object.assign(new Error("permission denied"), { code: "EACCES" });
    const copy = vi.mocked(NodeFSPromises.copyFile).mockClear().mockRejectedValueOnce(failure);
    try {
      await expect(read("unstaged")).rejects.toMatchObject({ kind: "git-error" });
      expect(copy).toHaveBeenCalledTimes(1);
    } finally { copy.mockReset(); }
  });

  it.each(["failure", "timeout"])("cleans the temporary index after a diff %s", async (mode) => {
    write("base.txt", "base\n");
    commit();
    write("notes.md", "notes\n");
    const boundary: GitExecutor = {
      exec: async (args, options) => {
        if (args.includes("--name-status")) throw Object.assign(new Error("injected Git failure"), { killed: mode === "timeout" });
        return executor.exec(args, options);
      },
    };
    service = new GitComparisonService(repo, boundary);
    await expect(read("unstaged")).rejects.toMatchObject({ kind: "git-error" });
  });

  it("counts untracked-only and staged-only trees as dirty without refreshing the real index", async () => {
    write("notes.md", "notes\n");
    const before = indexHash();
    expect(await service.readReviewState("fixture", cwd)).toEqual({
      isGitRepo: true, head: null, branch: "main",
      uncommitted: { staged: 0, unstaged: 0, untracked: 1 },
      commitsAhead: null, branchDefault: { unavailable: "unborn" },
    });
    expect(indexHash()).toBe(before);
    git("add", "notes.md");
    const staged = indexHash();
    expect(await service.readReviewState("fixture", cwd)).toEqual({
      isGitRepo: true, head: null, branch: "main",
      uncommitted: { staged: 1, unstaged: 0, untracked: 0 },
      commitsAhead: null, branchDefault: { unavailable: "unborn" },
    });
    expect(indexHash()).toBe(staged);
  });

  it.each(["success", "failure"])("preserves a comparison %s when temporary index cleanup fails", async (outcome) => {
    write("notes.md", "notes\n");
    const failure = new ReviewComparisonError("Could not read Review comparison", "Git timed out");
    service = new GitComparisonService(repo, {
      exec: (args, options) => {
        if (outcome === "failure" && args.includes("--name-status")) return Promise.reject(failure);
        return executor.exec(args, options);
      },
    });
    const unlink = vi.mocked(NodeFSPromises.unlink).mockRejectedValueOnce(
      Object.assign(new Error("index busy"), { code: "EBUSY" }),
    );
    const before = indexHash();
    try {
      const result = service.readReviewComparison("fixture", "unstaged", {}, cwd);
      if (outcome === "failure") {
        await expect(result).rejects.toBe(failure);
      } else {
        await expect(result).resolves.toEqual({
          files: [{ path: "notes.md", previousPath: null, changeType: "added", binary: false, additions: 1, deletions: 0, untracked: true }],
          additions: 1, deletions: 0,
        });
      }
      expect(indexHash()).toBe(before);
      expect(temporaryIndexes()).toHaveLength(1);
    } finally { unlink.mockReset(); }
  });

  it("probes commits ahead and the ADR-0007 local branch default", async () => {
    write("base.txt", "base\n");
    commit();
    git("checkout", "-b", "feature");
    write("feature.txt", "feature\n");
    commit();
    const before = indexHash();
    expect(await service.readReviewState("fixture", cwd)).toEqual({
      isGitRepo: true, head: git("rev-parse", "HEAD"), branch: "feature",
      uncommitted: { staged: 0, unstaged: 0, untracked: 0 },
      commitsAhead: { count: 1, base: "main" },
      branchDefault: { base: "main", compare: "feature" },
    });
    expect(indexHash()).toBe(before);
  });
});
