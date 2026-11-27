import "reflect-metadata";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireWorkspaceMoveGate } from "../../../../projects/lifecycle/workspace-move-gate.js";
import type { TerminalProfileService } from "../../../profiles/terminal-profile-service.js";
import { LegacyTerminalBackend } from "../legacy-terminal-backend.js";
import { stubEnvService } from "../../../../../runtime/environment/__tests__/stub-env-service.js";
import { FakeGitExecutor } from "../../../../projects/git/execution/index.js";
import { GitWorktreeService } from "../../../../projects/git/git-worktree-service.js";
import { WorkspaceRepo } from "../../../../projects/persistence/workspace-repo.js";
import { SettingsService } from "../../../../settings/settings-service.js";
import { ThreadRepo } from "../../../../thread-control/persistence/thread-repo.js";
import { createThreadPersistenceTestRuntime } from "../../../../thread-control/testing/thread-persistence-test-runtime.js";
import { InMemoryPtyHostAdapter } from "../../../testing/in-memory-pty-host-adapter.js";
import { TerminalService } from "../terminal-service.js";

const NO_PROJECT_WORKSPACE_ID = "00000000-0000-4000-8000-0000000000a1";
let sandbox: string;
let folder: string;
let worktree: string;

beforeEach(() => {
  sandbox = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-no-project-cwd-"));
  vi.stubEnv("MCODE_DATA_DIR", sandbox);
  folder = NodePath.join(sandbox, "no-project", "abc123");
  worktree = NodePath.join(sandbox, "worktrees", "feature");
  NodeFS.mkdirSync(folder, { recursive: true });
  NodeFS.mkdirSync(worktree, { recursive: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
  NodeFS.rmSync(sandbox, { recursive: true, force: true });
});

async function createService() {
  const { reader, writer } = createThreadPersistenceTestRuntime();
  const threads = new ThreadRepo(reader, writer);
  const workspaces = new WorkspaceRepo(reader, writer);
  await workspaces.createNoProject(NO_PROJECT_WORKSPACE_ID, folder);
  const gitWorktrees = new GitWorktreeService(workspaces, new FakeGitExecutor(), {
    platform: process.platform,
    architecture: process.arch,
    nodeAbi: process.versions.modules,
  });
  const settings = new SettingsService();
  const host = new InMemoryPtyHostAdapter("1");
  const spawn = vi.spyOn(host, "create");
  const service = new TerminalService(threads, workspaces, gitWorktrees, settings, stubEnvService(), host);
  return { service, threads, workspaces, settings, spawn };
}

const launch: Parameters<TerminalService["create"]>[1] = {
  executable: "pwsh.exe",
  arguments: [],
  requestedProfileId: "automatic",
  resolvedProfile: {
    id: "certified:windows-powershell-7",
    name: "PowerShell 7",
    executable: "pwsh.exe",
    arguments: [],
    source: "certified",
    platform: "windows",
  },
};

describe("Terminal working directory in a No project workspace", () => {
  it("starts a direct thread's shell in the thread's own folder", async () => {
    const { service, threads, settings, spawn } = await createService();
    try {
      const thread = await threads.create(NO_PROJECT_WORKSPACE_ID, "Direct", "direct", "");
      await service.create(thread.id, launch);
      expect(spawn.mock.calls.map(([input]) => input.cwd)).toEqual([folder]);
    } finally {
      await service.shutdown();
      settings.dispose();
    }
  });

  it("uses the checkout folder for a worktree-mode thread", async () => {
    const { service, threads, settings } = await createService();
    try {
      const thread = await threads.create(NO_PROJECT_WORKSPACE_ID, "Worktree", "worktree", "feature");
      await threads.updateWorktreePath(thread.id, worktree);
      expect(service.resolveWorkingDirectory(thread.id)).toBe(worktree);
    } finally {
      await service.shutdown();
      settings.dispose();
    }
  });

  it("fences creates and restarts by path after profile lookup", async () => {
    const { service, threads, workspaces, settings } = await createService();
    const sharer = await threads.create(NO_PROJECT_WORKSPACE_ID, "Direct", "direct", "");
    const inside = NodePath.join(folder, "inside");
    NodeFS.mkdirSync(inside);
    const other = await workspaces.create("Other", worktree, false);
    const nested = await threads.create(other.id, "Checkout", "worktree", "feature");
    await threads.updateWorktreePath(nested.id, inside);
    const profile = Promise.withResolvers<Awaited<ReturnType<TerminalProfileService["resolveLaunchProfile"]>>>();
    const auth = { resolveLaunchProfile: () => profile.promise };
    const hostRuntime = { platform: process.platform, architecture: process.arch, nodeAbi: process.versions.modules };
    const backend = new LegacyTerminalBackend(service, threads, auth, hostRuntime);
    const prior = await service.create(sharer.id, launch);
    const pending = backend.create(sharer.id);
    const release = acquireWorkspaceMoveGate(NO_PROJECT_WORKSPACE_ID, folder);
    if (!release) throw new Error("Expected the move gate");
    try {
      profile.resolve({ requestedProfileId: launch.requestedProfileId, resolvedProfile: { ...launch.resolvedProfile, arguments: [] } });
      await expect(pending).rejects.toThrow(/moving/);
      await expect(backend.create(sharer.id, prior.ptyId)).rejects.toThrow(/moving/);
      await expect(backend.create(nested.id)).rejects.toThrow(/moving/);
      await expect(backend.create(NO_PROJECT_WORKSPACE_ID)).rejects.toThrow(/moving/);
      expect((await backend.create(other.id)).cwd).toBe(worktree);
      release();
      expect((await backend.create(sharer.id)).cwd).toBe(folder);
    } finally {
      release();
      await service.shutdown();
      settings.dispose();
    }
  });
});
