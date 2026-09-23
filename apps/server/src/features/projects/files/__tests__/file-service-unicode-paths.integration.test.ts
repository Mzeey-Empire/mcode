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

    expect(listed).toContain("café.ts");
    expect(service.read("workspace-1", "café.ts")).toBe("fixture content");
    for (const path of listed) {
      expect(() => service.validateMentionPath("workspace-1", path)).not.toThrow();
    }
  });

  it("lists an untracked non-ASCII path verbatim", async () => {
    NodeFS.writeFileSync(NodePath.join(root, "new üntracked.ts"), "untracked");

    const listed = await service.list("workspace-1");

    expect(listed).toContain("new üntracked.ts");
    expect(service.read("workspace-1", "new üntracked.ts")).toBe("untracked");
  });

  it("lists names with spaces and non-ASCII names inside subdirectories", async () => {
    NodeFS.mkdirSync(NodePath.join(root, "dir q"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(root, "dir q", "ünïcode.md"), "nested");
    NodeFS.writeFileSync(NodePath.join(root, "spaced name.ts"), "spaced");

    const listed = await service.list("workspace-1");

    expect(listed).toContain("dir q/ünïcode.md");
    expect(listed).toContain("spaced name.ts");
  });

  it("keeps gitignore exclusions for non-ASCII names", async () => {
    NodeFS.writeFileSync(NodePath.join(root, ".gitignore"), "*.log\n");
    NodeFS.writeFileSync(NodePath.join(root, "ignoré.log"), "ignored");

    const listed = await service.list("workspace-1");

    expect(listed).toContain(".gitignore");
    expect(listed).not.toContain("ignoré.log");
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

      expect(listed).toContain(newlineName);
      expect(service.read("workspace-1", newlineName)).toBe("newline content");
    },
  );
});
