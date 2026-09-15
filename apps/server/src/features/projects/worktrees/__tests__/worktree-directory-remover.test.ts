import "reflect-metadata";
import * as NodeEvents from "node:events";
import type * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import { hostRuntime } from "@mcode/shared/node/host-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  WorktreeDirectoryRemover,
  type WorktreeDirectoryRemoverDependencies,
  validateRemovalTarget,
} from "../worktree-directory-remover.js";


function fakeChild() {
  const child = new NodeEvents.EventEmitter() as unknown as NodeChildProcess.ChildProcess;
  Object.defineProperty(child, "pid", { value: 42 });
  return child;
}

describe("WorktreeDirectoryRemover", () => {
  it("spawns cmd rmdir for Windows targets", async () => {
    const child = fakeChild();
    const spawn = vi.fn(() => child) as unknown as WorktreeDirectoryRemoverDependencies["spawn"];
    const remover = new WorktreeDirectoryRemover({ spawn, platform: "win32" });
    const target = "C:\\Users\\test\\.mcode\\worktrees\\repo\\main-abc12345";

    const removing = remover.remove(target);
    expect(spawn).toHaveBeenCalledWith(
      "cmd.exe",
      ["/d", "/s", "/c", `rmdir /s /q "${target}"`],
      expect.objectContaining({
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: true,
      }),
    );

    child.emit("close", 0, null);
    await expect(removing).resolves.toBeUndefined();
  });

  it("spawns rm -rf for POSIX targets", async () => {
    const child = fakeChild();
    const spawn = vi.fn(() => child) as unknown as WorktreeDirectoryRemoverDependencies["spawn"];
    const remover = new WorktreeDirectoryRemover({ spawn, platform: "linux" });
    const target = "/home/test/.mcode/worktrees/repo/main-abc12345";

    const removing = remover.remove(target);
    expect(spawn).toHaveBeenCalledWith(
      "rm",
      ["-rf", "--", target],
      expect.objectContaining({ shell: false, detached: true }),
    );

    child.emit("close", 0, null);
    await expect(removing).resolves.toBeUndefined();
  });

  it("falls back to the Node remover when a Windows path contains cmd metacharacters", async () => {
    const child = fakeChild();
    const spawn = vi.fn(() => child) as unknown as WorktreeDirectoryRemoverDependencies["spawn"];
    const remover = new WorktreeDirectoryRemover({ spawn, platform: "win32" });
    const target = "C:\\Users\\test\\.mcode\\worktrees\\repo\\100%done-abc12345";

    const removing = remover.remove(target);
    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      expect.arrayContaining(["-e", expect.any(String), target]),
      expect.objectContaining({ shell: false }),
    );

    child.emit("close", 0, null);
    await expect(removing).resolves.toBeUndefined();
  });

  it("turns a nonzero child exit into a retryable failure with captured output", async () => {
    const child = fakeChild();
    const remover = new WorktreeDirectoryRemover({
      spawn: (() => child) as WorktreeDirectoryRemoverDependencies["spawn"],
      platform: "linux",
    });

    const removing = remover.remove("/tmp/test-fixtures/worktree");
    child.emit("close", 1, null);

    await expect(removing).rejects.toThrow(/exit code 1/);
  });

  it("fails when the child exits cleanly but the directory remains", async () => {
    const target = NodeFS.mkdtempSync(NodePath.resolve(NodeOS.tmpdir(), "mcode-worktree-remover-leftover-"));
    try {
      const child = fakeChild();
      const remover = new WorktreeDirectoryRemover({
        spawn: (() => child) as WorktreeDirectoryRemoverDependencies["spawn"],
        platform: hostRuntime.platform,
      });
      const removing = remover.remove(target);
      child.emit("close", 0, null);
      await expect(removing).rejects.toThrow(/remains/);
    } finally {
      NodeFS.rmSync(target, { recursive: true, force: true });
    }
  });

  it("terminates the child when the hard timeout expires", async () => {
    const child = fakeChild();
    const killTree = vi.fn(() => {
      child.emit("close", null, "SIGKILL");
    });
    const remover = new WorktreeDirectoryRemover({
      spawn: (() => child) as WorktreeDirectoryRemoverDependencies["spawn"],
      killTree,
      platform: "linux",
    });

    await expect(remover.remove("/tmp/test-fixtures/worktree", 1)).rejects.toThrow(/timed out/);
    expect(killTree).toHaveBeenCalledWith(child);
  });

  it("executes the platform remover against a real temporary directory", async () => {
    const target = NodeFS.mkdtempSync(NodePath.resolve(NodeOS.tmpdir(), "mcode-worktree-remover-"));
    NodeFS.mkdirSync(NodePath.resolve(target, "nested"));
    NodeFS.writeFileSync(NodePath.resolve(target, "nested", "file.txt"), "temporary");

    try {
      await new WorktreeDirectoryRemover({ timeoutMs: 5_000, platform: hostRuntime.platform }).remove(target);
      expect(NodeFS.existsSync(target)).toBe(false);
    } finally {
      NodeFS.rmSync(target, { recursive: true, force: true });
    }
  });

  it("rejects invalid, protected, and ancestor targets before spawning", () => {
    expect(() => validateRemovalTarget("relative/worktree", hostRuntime.platform)).toThrow(/absolute/);
    expect(() => validateRemovalTarget(process.cwd(), hostRuntime.platform)).toThrow(/working directory/);
    expect(() => validateRemovalTarget(NodePath.resolve(process.cwd(), ".."), hostRuntime.platform)).toThrow(/working directory/);
    expect(() => validateRemovalTarget(NodePath.resolve(process.execPath, ".."), hostRuntime.platform)).toThrow(/server executable/);
    expect(() => validateRemovalTarget(NodePath.resolve(process.cwd(), "..", "sibling-worktree"), hostRuntime.platform)).not.toThrow();
  });
});
