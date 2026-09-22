import "reflect-metadata";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileService } from "../file-service.js";

function makeService(overrides?: {
  exec?: ReturnType<typeof vi.fn>;
}): { service: FileService; exec: ReturnType<typeof vi.fn> } {
  const exec = overrides?.exec ?? vi.fn().mockResolvedValue({ stdout: "" });
  const workspaceRepo = { findById: vi.fn().mockReturnValue({ path: "C:/workspace" }) };
  const threadRepo = {
    findById: vi.fn().mockReturnValue({ id: "thread-1", workspace_id: "workspace-1" }),
  };
  const gitWorktrees = { resolveWorkingDir: vi.fn().mockReturnValue("C:/workspace") };
  const service = new FileService(
    workspaceRepo as never,
    threadRepo as never,
    gitWorktrees as never,
    { exec } as never,
    { platform: process.platform } as never,
  );
  return { service, exec };
}

describe("FileService.refresh", () => {
  it("baselines silently on the first call and reports only later deltas", async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce({ stdout: " M src/a.ts\n" })
      .mockResolvedValueOnce({ stdout: " M src/a.ts\n" })
      .mockResolvedValueOnce({ stdout: " M src/a.ts\n?? src/b.ts\n" });
    const { service } = makeService({ exec });

    await expect(service.refresh("workspace-1")).resolves.toBeNull();
    await expect(service.refresh("workspace-1")).resolves.toBeNull();
    await expect(service.refresh("workspace-1")).resolves.toEqual({
      changedPaths: ["src/b.ts"],
      wholeWorkspace: false,
    });
    expect(exec).toHaveBeenCalledTimes(3);
    expect(exec).toHaveBeenLastCalledWith(
      ["status", "--porcelain", "--untracked-files=all"],
      { cwd: "C:/workspace" },
    );
  });

  it("tracks thread scopes independently", async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce({ stdout: " M src/a.ts\n" })
      .mockResolvedValueOnce({ stdout: " M src/a.ts\n" });
    const { service } = makeService({ exec });

    await expect(service.refresh("workspace-1", "thread-1")).resolves.toBeNull();
    // Same status under a different scope is still a first-seen baseline.
    await expect(service.refresh("workspace-1")).resolves.toBeNull();
  });

  it("reports wholeWorkspace when a delta exceeds the changed-path cap", async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "" })
      .mockResolvedValueOnce({
        stdout: Array.from({ length: 101 }, (_, i) => `?? dir/file-${i}.ts`).join("\n"),
      });
    const { service } = makeService({ exec });

    await expect(service.refresh("workspace-1")).resolves.toBeNull();
    await expect(service.refresh("workspace-1")).resolves.toEqual({
      changedPaths: [],
      wholeWorkspace: true,
    });
  });

  it("fingerprints the bounded listing when the scope is not a git repository", async () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "file-service-"));
    try {
      const workspaceRepo = { findById: vi.fn().mockReturnValue({ path: root }) };
      const service = new FileService(
        workspaceRepo as never,
        { findById: vi.fn().mockReturnValue(null) } as never,
        { resolveWorkingDir: vi.fn().mockReturnValue(root) } as never,
        { exec: vi.fn().mockRejectedValue(new Error("not a repo")) } as never,
        { platform: process.platform } as never,
      );

      await expect(service.refresh("workspace-1")).resolves.toBeNull();
      NodeFS.writeFileSync(NodePath.join(root, "new-file.ts"), "x");
      await expect(service.refresh("workspace-1")).resolves.toEqual({
        changedPaths: ["new-file.ts"],
        wholeWorkspace: false,
      });
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("FileService.list non-git fallback", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
  });

  function makeTreeService(root: string): FileService {
    const workspaceRepo = { findById: vi.fn().mockReturnValue({ path: root }) };
    const threadRepo = { findById: vi.fn().mockReturnValue(null) };
    const gitWorktrees = { resolveWorkingDir: vi.fn().mockReturnValue(root) };
    const exec = vi.fn().mockRejectedValue(new Error("not a repo"));
    return new FileService(
      workspaceRepo as never,
      threadRepo as never,
      gitWorktrees as never,
      { exec } as never,
      { platform: process.platform } as never,
    );
  }

  it("walks the directory tree when the workspace is not a git repo", async () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "file-service-"));
    tempDirs.push(root);
    NodeFS.mkdirSync(NodePath.join(root, "src"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(root, "src", "a.ts"), "a");
    NodeFS.writeFileSync(NodePath.join(root, "README.md"), "r");
    NodeFS.mkdirSync(NodePath.join(root, "node_modules", "pkg"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(root, "node_modules", "pkg", "x.js"), "x");

    const files = await makeTreeService(root).list("workspace-1");

    expect(files).toContain("src/a.ts");
    expect(files).toContain("README.md");
    expect(files).not.toContain("node_modules/pkg/x.js");
  });

  it("rethrows the git error when the workspace is a repository", async () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "file-service-"));
    tempDirs.push(root);
    NodeFS.mkdirSync(NodePath.join(root, ".git"));

    await expect(makeTreeService(root).list("workspace-1")).rejects.toThrow("Failed to list files");
  });
});
