import "reflect-metadata";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { Database } from "bun:sqlite";
import { createThreadPersistenceTestRuntime } from "../../testing/thread-persistence-test-runtime.js";
import { CleanupJobRepo } from "../persistence/cleanup-job-repo.js";
import { ThreadRepo } from "../../persistence/thread-repo.js";
import { WorkspaceRepo } from "../../../projects/persistence/workspace-repo.js";
import { CleanupWorker } from "../cleanup-worker.js";
import type { HandoffStorage } from "../../../handoff/index.js";
import type { ThreadService } from "../../index.js";
import type { ClaudeProviderBoundary as ClaudeProvider } from "@mcode/providers";
import type { AttachmentService } from "../../../attachments/storage/attachment-service.js";
import {
  RepositoryGitMutationLock,
  type GitWorktreeService,
  type SandboxWorktreeCleanupPolicy,
} from "../../../projects/index.js";
import type { ThreadDeletionTeardownService } from "../../lifecycle/thread-deletion-teardown-service.js";
import { getMcodeDir } from "@mcode/shared";

const WINDOWS_HOST_RUNTIME = { platform: "win32", architecture: "x64", nodeAbi: "127" } as const;
const WT_BASE = NodePath.join(getMcodeDir(), "worktrees", "process-scope-test");

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function spawnOtherThreadClaude(directory: string): NodeChildProcess.ChildProcess {
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const image = NodePath.join(directory, "claude.exe");
  NodeFS.copyFileSync(NodePath.join(systemRoot, "System32", "PING.EXE"), image);
  return NodeChildProcess.spawn(image, ["-n", "120", "127.0.0.1"], { stdio: "ignore", windowsHide: true });
}

describe.skipIf(process.platform !== "win32")("Cleanup process scope", () => {
  let db: Database;
  let cleanupJobRepo: CleanupJobRepo;
  let threadRepo: ThreadRepo;
  let workspaceRepo: WorkspaceRepo;
  let worker: CleanupWorker;
  let imageDirectory: string;
  let otherThreadClaude: NodeChildProcess.ChildProcess | undefined;

  beforeEach(() => {
    const runtime = createThreadPersistenceTestRuntime();
    db = runtime.database;
    cleanupJobRepo = new CleanupJobRepo(runtime.reader, runtime.writer);
    threadRepo = new ThreadRepo(runtime.reader, runtime.writer);
    workspaceRepo = new WorkspaceRepo(runtime.reader, runtime.writer);
    imageDirectory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-cleanup-scope-"));

    worker = new CleanupWorker(
      cleanupJobRepo,
      threadRepo,
      { waitForSessionExit: vi.fn().mockResolvedValue(undefined) } as unknown as ClaudeProvider,
      {
        removeWorktree: vi.fn().mockResolvedValue(true),
        isRegisteredWorktreePath: vi.fn().mockReturnValue(true),
      } as unknown as GitWorktreeService,
      {
        decide: vi.fn(async ({ worktreePath }) => ({ action: "remove" as const, worktreePath, branch: "mcode/done" })),
        resolveSandboxPath: vi.fn(async (path: string) => path),
        isSameSandboxPath: vi.fn((left: string, right: string) => left === right),
      } as unknown as SandboxWorktreeCleanupPolicy,
      new RepositoryGitMutationLock(WINDOWS_HOST_RUNTIME),
      workspaceRepo,
      { removeForThread: vi.fn() } as unknown as AttachmentService,
      { deleteThreadFiles: vi.fn().mockResolvedValue(undefined) } as unknown as HandoffStorage,
      {
        teardownThread: vi.fn().mockResolvedValue(undefined),
        bindAcceptedProgress: vi.fn(),
        deletePersistentData: async <Result>(_ids: readonly string[], remove: () => Promise<Result>): Promise<Result> => remove(),
        notifyThreadsHidden: vi.fn(),
      } as unknown as ThreadDeletionTeardownService,
      { run: vi.fn().mockResolvedValue(undefined) },
      { deleteDelegatedChildren: vi.fn().mockResolvedValue(undefined) } as unknown as ThreadService,
      WINDOWS_HOST_RUNTIME,
      undefined,
      0,
    );
  });

  afterEach(async () => {
    worker.dispose();
    const child = otherThreadClaude;
    if (child && child.exitCode === null && child.signalCode === null) {
      // Windows keeps the image file locked until the process has exited.
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill();
      await exited;
    }
    NodeFS.rmSync(imageDirectory, { recursive: true, force: true });
  });

  it("leaves another thread's live claude.exe running", async () => {
    const workspace = await workspaceRepo.create("process-scope", "/process-scope-repo");
    const now = new Date().toISOString();
    const worktreePath = NodePath.join(WT_BASE, "done-wt");
    db.prepare(
      `INSERT INTO threads
        (id, workspace_id, title, branch, mode, status, worktree_path, worktree_managed, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'worktree', 'deleted', ?, 1, ?, ?)`,
    ).run("thread-done", workspace.id, "Done Thread", "mcode/done", worktreePath, now, now);
    await cleanupJobRepo.insert({
      thread_id: "thread-done",
      workspace_path: "/process-scope-repo",
      worktree_path: worktreePath,
      branch: "mcode/done",
    });
    otherThreadClaude = spawnOtherThreadClaude(imageDirectory);
    const pid = otherThreadClaude.pid!;
    expect(isRunning(pid)).toBe(true);

    await worker.poll();

    expect(threadRepo.findById("thread-done")).toBeNull();
    expect(isRunning(pid)).toBe(true);
  }, 60_000);
});
