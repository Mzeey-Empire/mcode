import "reflect-metadata";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeChildProcess from "node:child_process";
import { FileService } from "../file-service.js";
import { RealGitExecutor } from "../../git/execution/real-git-executor.js";

const GIT_REPO_SETUP_TIMEOUT_MS = 30_000;

/**
 * Integration tests for FileService path handling against real git output.
 * With Git's default core.quotePath=true, non-ASCII and special-character
 * paths arrive C-quoted on newline-delimited output; the service must use
 * `-z` output so listed paths round-trip into read and mention validation.
 * Regression coverage for https://github.com/Mzeey-Empire/mcode/issues/1734.
 */

/** Initializes a git repo in a temp directory with quotePath left at its default. */
function createGitRepo(): string {
  const tmpDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-files-unicode-"));
  const git = (...args: string[]) =>
    NodeChildProcess.execFileSync("git", ["-C", tmpDir, ...args], { encoding: "utf8" });
  git("init", "-b", "main");
  git("config", "user.email", "test@mcode.test");
  git("config", "user.name", "Mcode Test");
  git("config", "commit.gpgSign", "false");
  git("config", "core.hooksPath", tmpDir);
  git("config", "core.quotePath", "true");
  return tmpDir;
}

function gitIn(root: string, ...args: string[]): void {
  NodeChildProcess.execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
}

function makeService(root: string): FileService {
  const workspaceRepo = { findById: () => ({ path: root }) };
  const threadRepo = { findById: () => null };
  const gitWorktrees = { resolveWorkingDir: () => root };
  return new FileService(
    workspaceRepo as never,
    threadRepo as never,
    gitWorktrees as never,
    new RealGitExecutor(),
    { platform: process.platform } as never,
  );
}

describe("FileService unicode paths (real git)", () => {
  let service: FileService;
  let root: string;

  beforeEach(() => {
    root = createGitRepo();
    service = makeService(root);
  }, GIT_REPO_SETUP_TIMEOUT_MS);

  afterEach(() => {
    NodeFS.rmSync(root, { recursive: true, force: true });
  });

  it("lists a tracked non-ASCII path verbatim and round-trips read + mention validation", async () => {
    NodeFS.writeFileSync(NodePath.join(root, "café.ts"), "fixture content");
    gitIn(root, "add", "café.ts");
    gitIn(root, "commit", "-m", "add café");

    const listed = await service.list("workspace-1");

    expect(listed).toEqual({ paths: ["café.ts"], truncated: false });
    await expect(service.read("workspace-1", "café.ts")).resolves.toEqual({ kind: "text", path: "café.ts", size: 15, encoding: "utf-8", content: "fixture content", changedLines: null });
    for (const path of listed.paths) {
      expect(() => service.validateMentionPath("workspace-1", path)).not.toThrow();
    }
  });

  it("lists an untracked non-ASCII path verbatim", async () => {
    NodeFS.writeFileSync(NodePath.join(root, "new üntracked.ts"), "untracked");

    const listed = await service.list("workspace-1");

    expect(listed).toEqual({ paths: ["new üntracked.ts"], truncated: false });
    await expect(service.read("workspace-1", "new üntracked.ts")).resolves.toEqual({ kind: "text", path: "new üntracked.ts", size: 9, encoding: "utf-8", content: "untracked", changedLines: null });
  });

  it("lists names with spaces and non-ASCII names inside subdirectories", async () => {
    NodeFS.mkdirSync(NodePath.join(root, "dir q"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(root, "dir q", "ünïcode.md"), "nested");
    NodeFS.writeFileSync(NodePath.join(root, "spaced name.ts"), "spaced");

    const listed = await service.list("workspace-1");

    expect(listed.paths).toEqual(["dir q/ünïcode.md", "spaced name.ts"]);
  });

  it("keeps gitignore exclusions for non-ASCII names", async () => {
    NodeFS.writeFileSync(NodePath.join(root, ".gitignore"), "*.log\n");
    NodeFS.writeFileSync(NodePath.join(root, "ignoré.log"), "ignored");

    const listed = await service.list("workspace-1");

    expect(listed).toEqual({ paths: [".gitignore"], truncated: false });
  });

  it("reports unescaped paths in refresh changedPaths", async () => {
    NodeFS.writeFileSync(NodePath.join(root, "base.ts"), "base");
    gitIn(root, "add", "base.ts");
    gitIn(root, "commit", "-m", "base");

    await expect(service.refresh("workspace-1")).resolves.toBeNull();
    NodeFS.writeFileSync(NodePath.join(root, "café.ts"), "dirty");

    await expect(service.refresh("workspace-1")).resolves.toEqual({
      changedPaths: ["café.ts"],
      wholeWorkspace: false,
    });
  });

  it("reports the destination path for a renamed non-ASCII file", async () => {
    NodeFS.writeFileSync(NodePath.join(root, "old name.ts"), "renamed");
    gitIn(root, "add", "old name.ts");
    gitIn(root, "commit", "-m", "base");

    await expect(service.refresh("workspace-1")).resolves.toBeNull();
    gitIn(root, "mv", "old name.ts", "new näme.ts");

    await expect(service.refresh("workspace-1")).resolves.toEqual({
      changedPaths: ["new näme.ts"],
      wholeWorkspace: false,
    });
  });

  // POSIX filesystems allow newlines in filenames; NTFS does not.
  it.skipIf(process.platform === "win32")(
    "round-trips a filename containing a newline",
    async () => {
      const newlineName = "line\nbreak.ts";
      NodeFS.writeFileSync(NodePath.join(root, newlineName), "newline content");

      const listed = await service.list("workspace-1");

      expect(listed.paths).toEqual([newlineName]);
      await expect(service.read("workspace-1", newlineName)).resolves.toMatchObject({ kind: "text", content: "newline content", changedLines: null });
    },
  );

  it("reports exact changed ranges against HEAD, including staged edits", async () => {
    const original = Array.from({ length: 20 }, (_, i) => `line ${i + 1}\n`);
    NodeFS.writeFileSync(NodePath.join(root, "tracked.txt"), original.join(""));
    gitIn(root, "add", "tracked.txt");
    gitIn(root, "commit", "-m", "baseline");
    const edited = [...original];
    edited.splice(11, 4, "changed 12\n", "changed 13\n", "changed 14\n", "changed 15\n");
    NodeFS.writeFileSync(NodePath.join(root, "tracked.txt"), edited.join(""));
    gitIn(root, "add", "tracked.txt");
    await expect(service.read("workspace-1", "tracked.txt")).resolves.toMatchObject({ kind: "text", content: edited.join(""), changedLines: [[12, 15]] });
    await expect(service.changes("workspace-1")).resolves.toEqual({ git: true, entries: [{ path: "tracked.txt", mark: "M" }], truncated: false });
  });

  it("marks untracked, staged additions, and renamed destinations A and drops deletions", async () => {
    NodeFS.writeFileSync(NodePath.join(root, "old.txt"), "renamed\n");
    NodeFS.writeFileSync(NodePath.join(root, "gone.txt"), "removed\n");
    gitIn(root, "add", ".");
    gitIn(root, "commit", "-m", "baseline");
    gitIn(root, "mv", "old.txt", "new näme.txt");
    gitIn(root, "rm", "gone.txt");
    NodeFS.writeFileSync(NodePath.join(root, "untracked.txt"), "untracked\n");
    NodeFS.writeFileSync(NodePath.join(root, "added.txt"), "added\n");
    gitIn(root, "add", "added.txt");
    const changes = await service.changes("workspace-1");
    expect(changes).toEqual({ git: true, entries: [
      { path: "added.txt", mark: "A" }, { path: "new näme.txt", mark: "A" }, { path: "untracked.txt", mark: "A" },
    ], truncated: false });
    for (const path of ["untracked.txt", "added.txt"]) {
      await expect(service.read("workspace-1", path)).resolves.toMatchObject({ kind: "text", changedLines: null });
    }
  });

  it("returns null without HEAD and handles single-line hunks and pure deletions", async () => {
    NodeFS.writeFileSync(NodePath.join(root, "lines.txt"), "one\ntwo\nthree\n");
    gitIn(root, "add", "lines.txt");
    await expect(service.read("workspace-1", "lines.txt")).resolves.toMatchObject({ kind: "text", changedLines: null });
    gitIn(root, "commit", "-m", "baseline");
    NodeFS.writeFileSync(NodePath.join(root, "lines.txt"), "one\nchanged\nthree\n");
    await expect(service.read("workspace-1", "lines.txt")).resolves.toMatchObject({ kind: "text", changedLines: [[2, 2]] });
    NodeFS.writeFileSync(NodePath.join(root, "lines.txt"), "one\nthree\n");
    await expect(service.read("workspace-1", "lines.txt")).resolves.toMatchObject({ kind: "text", changedLines: [] });
  });
});
