import "reflect-metadata";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeChildProcess from "node:child_process";
import { SnapshotService } from "../snapshot-service.js";
import { RealGitExecutor } from "../../../git/execution/real-git-executor.js";

const GIT_REPO_SETUP_TIMEOUT_MS = 30_000;
const GIT_OPERATION_TIMEOUT_MS = 30_000;

/**
 * Integration tests for SnapshotService using real git repositories.
 * These tests exercise the full git pipeline with no mocks to verify
 * actual behavior against the filesystem.
 */

/** Initializes a fresh git repo in a temp directory with one committed file. */
function createGitRepo(): string {
  const tmpDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-snap-test-"));

  NodeChildProcess.execFileSync("git", ["-C", tmpDir, "init", "-b", "main"]);
  NodeChildProcess.execFileSync("git", ["-C", tmpDir, "config", "user.email", "test@mcode.test"]);
  NodeChildProcess.execFileSync("git", ["-C", tmpDir, "config", "user.name", "Mcode Test"]);

  // Create an initial file and commit so HEAD exists
  NodeFS.writeFileSync(NodePath.join(tmpDir, "existing.txt"), "line one\nline two\nline three\n");
  NodeChildProcess.execFileSync("git", ["-C", tmpDir, "add", "existing.txt"]);
  const tree = NodeChildProcess.execFileSync("git", ["-C", tmpDir, "write-tree"], { encoding: "utf8" }).trim();
  const commit = NodeChildProcess.execFileSync("git", ["-C", tmpDir, "commit-tree", tree, "-m", "initial commit"], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Mcode Test",
      GIT_AUTHOR_EMAIL: "test@mcode.test",
      GIT_COMMITTER_NAME: "Mcode Test",
      GIT_COMMITTER_EMAIL: "test@mcode.test",
    },
  }).trim();
  NodeChildProcess.execFileSync("git", ["-C", tmpDir, "update-ref", "refs/heads/main", commit]);

  return tmpDir;
}

/** Initializes a fresh git repo with no commits (unborn HEAD). */
function createUnbornRepo(): string {
  const tmpDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-snap-unborn-"));

  NodeChildProcess.execFileSync("git", ["-C", tmpDir, "init", "-b", "main"]);
  NodeChildProcess.execFileSync("git", ["-C", tmpDir, "config", "user.email", "test@mcode.test"]);
  NodeChildProcess.execFileSync("git", ["-C", tmpDir, "config", "user.name", "Mcode Test"]);

  return tmpDir;
}

describe("SnapshotService integration", () => {
  let service: SnapshotService;
  let tmpDir: string;

  beforeEach(() => {
    service = new SnapshotService(new RealGitExecutor());
    tmpDir = createGitRepo();
  }, GIT_REPO_SETUP_TIMEOUT_MS);

  afterEach(() => {
    NodeFS.rmSync(tmpDir, { recursive: true, force: true });
  });

  function git(...args: string[]): string {
    return NodeChildProcess.execFileSync("git", ["-C", tmpDir, ...args], {
      encoding: "utf8",
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    }).trim();
  }

  function indexPath(): string {
    return NodePath.resolve(tmpDir, git("rev-parse", "--git-path", "index"));
  }

  it("captures the HEAD tree for a clean checkout", async () => {
    expect(await service.captureRef(tmpDir)).toBe(git("rev-parse", "HEAD^{tree}"));
  }, GIT_OPERATION_TIMEOUT_MS);

  it("captures tracked and untracked content while excluding ignored files", async () => {
    NodeFS.writeFileSync(NodePath.join(tmpDir, "existing.txt"), "modified\n");
    NodeFS.writeFileSync(NodePath.join(tmpDir, "new.txt"), "untracked\n");
    NodeFS.writeFileSync(NodePath.join(tmpDir, ".gitignore"), "*.log\n");
    NodeFS.writeFileSync(NodePath.join(tmpDir, "debug.log"), "ignored\n");

    const ref = await service.captureRef(tmpDir);

    expect(git("ls-tree", "-r", "--name-only", ref).split("\n")).toEqual([".gitignore", "existing.txt", "new.txt"]);
    expect(git("show", `${ref}:existing.txt`)).toBe("modified");
    expect(git("show", `${ref}:new.txt`)).toBe("untracked");
  }, GIT_OPERATION_TIMEOUT_MS);

  it("includes a force-staged ignored file", async () => {
    NodeFS.writeFileSync(NodePath.join(tmpDir, ".gitignore"), "*.log\n");
    NodeFS.writeFileSync(NodePath.join(tmpDir, "forced.log"), "force staged\n");
    git("add", "-f", "forced.log");

    const ref = await service.captureRef(tmpDir);

    expect(git("ls-tree", "-r", "--name-only", ref).split("\n")).toEqual([".gitignore", "existing.txt", "forced.log"]);
    expect(git("show", `${ref}:forced.log`)).toBe("force staged");
  }, GIT_OPERATION_TIMEOUT_MS);

  it("preserves staged and unstaged changes and the real index bytes", async () => {
    NodeFS.writeFileSync(NodePath.join(tmpDir, "existing.txt"), "staged\n");
    git("add", "existing.txt");
    NodeFS.writeFileSync(NodePath.join(tmpDir, "existing.txt"), "unstaged\n");
    const staged = git("diff", "--cached", "--name-only");
    const unstaged = git("diff", "--name-only");
    const bytes = NodeFS.readFileSync(indexPath());

    const ref = await service.captureRef(tmpDir);

    expect(git("show", `${ref}:existing.txt`)).toBe("unstaged");
    expect(NodeFS.readFileSync(indexPath())).toEqual(bytes);
    expect(git("diff", "--cached", "--name-only")).toBe(staged);
    expect(git("diff", "--name-only")).toBe(unstaged);
  }, GIT_OPERATION_TIMEOUT_MS);

  it("preserves split index files and staged changes without leaking temporary indexes", async () => {
    git("config", "core.splitIndex", "true");
    git("update-index", "--split-index");
    git("-c", "core.hooksPath=", "commit", "--allow-empty", "-m", "split index");
    NodeFS.writeFileSync(NodePath.join(tmpDir, "existing.txt"), "staged\n");
    git("add", "existing.txt");
    NodeFS.writeFileSync(NodePath.join(tmpDir, "existing.txt"), "unstaged\n");
    const dir = NodePath.dirname(indexPath());
    const shared = NodeFS.readdirSync(dir).filter((name) => name.startsWith("sharedindex.")).sort();
    expect(shared.length).toBeGreaterThan(0);
    const bytes = NodeFS.readFileSync(indexPath());

    const ref = await service.captureRef(tmpDir);

    expect(git("show", `${ref}:existing.txt`)).toBe("unstaged");
    expect(NodeFS.readFileSync(indexPath())).toEqual(bytes);
    expect(NodeFS.readdirSync(dir).filter((name) => name.startsWith("sharedindex.")).sort()).toEqual(shared);
    expect(NodeFS.readdirSync(dir).filter((name) => name.startsWith("mcode-index-"))).toEqual([]);
    expect(git("diff", "--cached", "--name-only")).toBe("existing.txt");
    expect(git("show", ":existing.txt")).toBe("staged");
  }, GIT_OPERATION_TIMEOUT_MS);

  it("captures linked worktree content and cleans its private git directory", async () => {
    const linked = NodePath.join(tmpDir, "linked");
    git("worktree", "add", "-b", "linked", linked);
    NodeFS.writeFileSync(NodePath.join(linked, "existing.txt"), "linked content\n");

    const ref = await service.captureRef(linked);

    expect(git("show", `${ref}:existing.txt`)).toBe("linked content");
    const location = NodeChildProcess.execFileSync("git", ["-C", linked, "rev-parse", "--git-path", "index"], { encoding: "utf8" }).trim();
    const dir = NodePath.dirname(NodePath.resolve(linked, location));
    expect(NodeFS.readdirSync(dir).filter((name) => name.startsWith("mcode-index-"))).toEqual([]);
  }, GIT_OPERATION_TIMEOUT_MS);

  it("captures conflict markers while preserving the real unmerged entries", async () => {
    git("checkout", "-b", "conflicting");
    NodeFS.writeFileSync(NodePath.join(tmpDir, "existing.txt"), "branch\n");
    git("add", "existing.txt");
    git("-c", "core.hooksPath=", "commit", "-m", "branch change");
    git("checkout", "main");
    NodeFS.writeFileSync(NodePath.join(tmpDir, "existing.txt"), "main\n");
    git("add", "existing.txt");
    git("-c", "core.hooksPath=", "commit", "-m", "main change");
    expect(() => git("merge", "conflicting")).toThrow();
    const unmerged = git("ls-files", "-u");
    expect(unmerged.split("\n")).toHaveLength(3);

    const ref = await service.captureRef(tmpDir);

    expect(git("show", `${ref}:existing.txt`)).toBe("<<<<<<< HEAD\nmain\n=======\nbranch\n>>>>>>> conflicting");
    expect(git("ls-files", "-u")).toBe(unmerged);
  }, GIT_OPERATION_TIMEOUT_MS);

  it("captures edits to assume-unchanged and skip-worktree files without clearing their real flags", async () => {
    NodeFS.writeFileSync(NodePath.join(tmpDir, "hidden.txt"), "committed\n");
    git("add", "hidden.txt");
    git("-c", "core.hooksPath=", "commit", "-m", "hidden");
    git("update-index", "--assume-unchanged", "existing.txt");
    git("update-index", "--skip-worktree", "hidden.txt");
    NodeFS.writeFileSync(NodePath.join(tmpDir, "existing.txt"), "assumed edit\n");
    NodeFS.writeFileSync(NodePath.join(tmpDir, "hidden.txt"), "skipped edit\n");
    const flags = git("ls-files", "-v");

    const ref = await service.captureRef(tmpDir);

    expect(git("show", `${ref}:existing.txt`)).toBe("assumed edit");
    expect(git("show", `${ref}:hidden.txt`)).toBe("skipped edit");
    expect(git("ls-files", "-v")).toBe(flags);
  }, GIT_OPERATION_TIMEOUT_MS);

  it("keeps files that sparse checkout removed from disk", async () => {
    NodeFS.mkdirSync(NodePath.join(tmpDir, "kept"));
    NodeFS.mkdirSync(NodePath.join(tmpDir, "outside"));
    NodeFS.writeFileSync(NodePath.join(tmpDir, "kept", "a.txt"), "kept\n");
    NodeFS.writeFileSync(NodePath.join(tmpDir, "outside", "b.txt"), "outside\n");
    git("add", ".");
    git("-c", "core.hooksPath=", "commit", "-m", "folders");
    git("sparse-checkout", "set", "--cone", "kept");
    expect(NodeFS.existsSync(NodePath.join(tmpDir, "outside"))).toBe(false);
    NodeFS.writeFileSync(NodePath.join(tmpDir, "kept", "a.txt"), "edited\n");

    const ref = await service.captureRef(tmpDir);

    expect(git("show", `${ref}:kept/a.txt`)).toBe("edited");
    expect(git("show", `${ref}:outside/b.txt`)).toBe("outside");
  }, GIT_OPERATION_TIMEOUT_MS);

  it("rejects a non-repository folder", async () => {
    const folder = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-no-git-"));
    try {
      await expect(service.captureRef(folder)).rejects.toThrow();
    } finally {
      NodeFS.rmSync(folder, { recursive: true, force: true });
    }
  }, GIT_OPERATION_TIMEOUT_MS);

  it("new untracked files appear in getFilesChanged", async () => {
    const refBefore = await service.captureRef(tmpDir);

    NodeFS.writeFileSync(NodePath.join(tmpDir, "newfile.ts"), 'export const x = 1;\n');

    const refAfter = await service.captureRef(tmpDir);

    expect(refBefore).not.toBe(refAfter);

    const files = await service.getFilesChanged(tmpDir, refBefore, refAfter);
    expect(files).toContain("newfile.ts");
  }, GIT_OPERATION_TIMEOUT_MS);

  it("modified tracked files appear in getFilesChanged", async () => {
    const refBefore = await service.captureRef(tmpDir);

    NodeFS.writeFileSync(NodePath.join(tmpDir, "existing.txt"), "line one\nline two\nline three\nline four\n");

    const refAfter = await service.captureRef(tmpDir);

    expect(refBefore).not.toBe(refAfter);

    const files = await service.getFilesChanged(tmpDir, refBefore, refAfter);
    expect(files).toContain("existing.txt");
  }, GIT_OPERATION_TIMEOUT_MS);

  it("both new and modified files appear in getFilesChanged", async () => {
    const refBefore = await service.captureRef(tmpDir);

    NodeFS.writeFileSync(NodePath.join(tmpDir, "existing.txt"), "line one\nline two\nline three\nmodified\n");
    NodeFS.writeFileSync(NodePath.join(tmpDir, "brand-new.ts"), "export const brand = 'new';\n");

    const refAfter = await service.captureRef(tmpDir);

    expect(refBefore).not.toBe(refAfter);

    const files = await service.getFilesChanged(tmpDir, refBefore, refAfter);
    expect(files).toContain("existing.txt");
    expect(files).toContain("brand-new.ts");
  }, GIT_OPERATION_TIMEOUT_MS);

  it("clean tree returns the same ref for consecutive captureRef calls", async () => {
    // No changes between the two captures
    const refA = await service.captureRef(tmpDir);
    const refB = await service.captureRef(tmpDir);

    expect(refA).toBe(refB);

    const files = await service.getFilesChanged(tmpDir, refA, refB);
    expect(files).toHaveLength(0);
  }, GIT_OPERATION_TIMEOUT_MS);

  it("getDiff includes new file content", async () => {
    const refBefore = await service.captureRef(tmpDir);

    NodeFS.writeFileSync(NodePath.join(tmpDir, "hello.ts"), "export function hello() {\n  return 'world';\n}\n");

    const refAfter = await service.captureRef(tmpDir);

    const diff = await service.getDiff(tmpDir, refBefore, refAfter);

    expect(diff).toContain("hello.ts");
    // Added lines are prefixed with '+' in unified diff
    expect(diff).toContain("+export function hello()");
  }, GIT_OPERATION_TIMEOUT_MS);

  it("getDiffStats counts new file additions", async () => {
    const newFileContent = "line 1\nline 2\nline 3\n";
    const expectedLineCount = newFileContent.split("\n").filter(Boolean).length; // 3

    const refBefore = await service.captureRef(tmpDir);

    NodeFS.writeFileSync(NodePath.join(tmpDir, "counted.txt"), newFileContent);

    const refAfter = await service.captureRef(tmpDir);

    const stats = await service.getDiffStats(tmpDir, refBefore, refAfter);

    const fileStat = stats.find((s) => s.filePath === "counted.txt");
    expect(fileStat).toBeDefined();
    expect(fileStat!.additions).toBe(expectedLineCount);
    expect(fileStat!.deletions).toBe(0);
  }, GIT_OPERATION_TIMEOUT_MS);

  it("scopes historical diffs and stats to attributed paths", async () => {
    const refBefore = await service.captureRef(tmpDir);
    NodeFS.writeFileSync(NodePath.join(tmpDir, "authored.txt"), "agent change\n");
    NodeFS.writeFileSync(NodePath.join(tmpDir, "unrelated.txt"), "git pull change\n");
    const refAfter = await service.captureRef(tmpDir);

    const diff = await service.getDiff(
      tmpDir,
      refBefore,
      refAfter,
      { allowedPaths: ["authored.txt"] },
    );
    const stats = await service.getDiffStats(tmpDir, refBefore, refAfter, { allowedPaths: ["authored.txt"] });

    expect(diff).toContain("authored.txt");
    expect(diff).not.toContain("unrelated.txt");
    expect(stats.map((entry) => entry.filePath)).toEqual(["authored.txt"]);
  }, GIT_OPERATION_TIMEOUT_MS);

  it("hides whitespace-only snapshot changes and preserves a pure rename", async () => {
    NodeFS.writeFileSync(NodePath.join(tmpDir, "space.txt"), "a b\n");
    const refBefore = await service.captureRef(tmpDir);
    NodeFS.writeFileSync(NodePath.join(tmpDir, "space.txt"), "a  b\n");
    NodeFS.renameSync(NodePath.join(tmpDir, "existing.txt"), NodePath.join(tmpDir, "renamed.txt"));
    const refAfter = await service.captureRef(tmpDir);

    expect(await service.getDiffStats(tmpDir, refBefore, refAfter, { ignoreWhitespace: true })).toEqual([
      { filePath: "renamed.txt", changeType: "renamed", additions: 0, deletions: 0 },
    ]);
    expect(await service.getDiffStats(tmpDir, refBefore, refAfter)).toEqual([
      { filePath: "renamed.txt", changeType: "renamed", additions: 0, deletions: 0 },
      { filePath: "space.txt", changeType: "modified", additions: 1, deletions: 1 },
    ]);
    const patch = await service.getDiff(tmpDir, refBefore, refAfter, { ignoreWhitespace: true });
    expect(patch).toContain("rename from existing.txt");
    expect(patch).toContain("rename to renamed.txt");
    expect(patch).not.toContain("space.txt");
  }, GIT_OPERATION_TIMEOUT_MS);

  it("keeps both sides of a rename when opening the renamed file", async () => {
    const refBefore = await service.captureRef(tmpDir);
    NodeFS.renameSync(NodePath.join(tmpDir, "existing.txt"), NodePath.join(tmpDir, "renamed.txt"));
    const refAfter = await service.captureRef(tmpDir);

    const diff = await service.getDiff(
      tmpDir,
      refBefore,
      refAfter,
      {
        filePath: "renamed.txt",
        allowedPaths: ["renamed.txt", "existing.txt"],
        allowedPathGroups: [["renamed.txt", "existing.txt"]],
      },
    );

    expect(diff).toContain("similarity index 100%");
    expect(diff).toContain("rename from existing.txt");
    expect(diff).toContain("rename to renamed.txt");
  }, GIT_OPERATION_TIMEOUT_MS);

  it("gitignored files are excluded from getFilesChanged", async () => {
    const refBefore = await service.captureRef(tmpDir);

    NodeFS.writeFileSync(NodePath.join(tmpDir, ".gitignore"), "*.log\n");
    NodeFS.writeFileSync(NodePath.join(tmpDir, "debug.log"), "some debug output\n");
    NodeFS.writeFileSync(NodePath.join(tmpDir, "visible.txt"), "this file should appear\n");

    const refAfter = await service.captureRef(tmpDir);

    const files = await service.getFilesChanged(tmpDir, refBefore, refAfter);

    expect(files).not.toContain("debug.log");
    // The .gitignore itself and visible.txt are tracked changes
    expect(files).toContain(".gitignore");
    expect(files).toContain("visible.txt");
  }, GIT_OPERATION_TIMEOUT_MS);
});

describe("SnapshotService integration - unborn repo", () => {
  let service: SnapshotService;
  let tmpDir: string;

  beforeEach(() => {
    service = new SnapshotService(new RealGitExecutor());
    tmpDir = createUnbornRepo();
  }, GIT_OPERATION_TIMEOUT_MS);

  afterEach(() => {
    NodeFS.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("captures files in a repo with no commits", async () => {
    NodeFS.writeFileSync(NodePath.join(tmpDir, "first.ts"), "export const first = true;\n");

    const ref = await service.captureRef(tmpDir);

    // Should return a valid 40-char hex tree SHA, not empty
    expect(ref).toMatch(/^[0-9a-f]{40}$/);
    expect(ref).not.toBe("4b825dc642cb6eb9a060e54bf899d69f82cf7109"); // not the empty tree
  }, GIT_OPERATION_TIMEOUT_MS);

  it("detects new files between snapshots in unborn repo", async () => {
    const refBefore = await service.captureRef(tmpDir);

    NodeFS.writeFileSync(NodePath.join(tmpDir, "hello.ts"), "export const hello = 'world';\n");

    const refAfter = await service.captureRef(tmpDir);

    expect(refBefore).not.toBe(refAfter);

    const files = await service.getFilesChanged(tmpDir, refBefore, refAfter);
    expect(files).toContain("hello.ts");
  }, GIT_OPERATION_TIMEOUT_MS);

  it("clean unborn repo returns the same (empty) tree SHA", async () => {
    const refA = await service.captureRef(tmpDir);
    const refB = await service.captureRef(tmpDir);

    expect(refA).toBe(refB);
    // Should be a valid 40-char hex tree SHA
    expect(refA).toMatch(/^[0-9a-f]{40}$/);
  }, GIT_OPERATION_TIMEOUT_MS);
});
