import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createOwnedTestDatabase, type OwnedTestDatabase } from "../owned-test-database.js";
import { WorkspaceRepo } from "../../persistence/workspace-repo.js";
import { WorktreeRepo } from "../../persistence/worktree-repo.js";
import { WorkspaceTerminalPreferencesService } from "../../../terminal/preferences/workspace-terminal-preferences-service.js";
import { ModelCacheRepo } from "../../../providers/models/persistence/model-cache-repo.js";
import { WorkspaceEnvironmentConfigurationRepo } from "../../environment/persistence/workspace-environment-configuration-repo.js";
import { WorkspaceEnvironmentAutomaticRepository } from "../../environment/workspace-environment-automatic-repository.js";
import { ThreadStore } from "../../../thread-control/persistence/thread-store.js";
import { ProjectActionRunRepo } from "../../environment/persistence/project-action-run-repo.js";
import type { WorkspaceEnvironmentActionRun } from "@mcode/contracts";

describe("project and terminal database owner", () => {
  let owned: OwnedTestDatabase;
  beforeEach(() => { owned = createOwnedTestDatabase(); });
  afterEach(async () => { await owned.close(); });

  it("commits read-after-write results across worktree, preferences, model and environment facades", async () => {
    const workspace = await new WorkspaceRepo(owned.db, owned.writer).create("Owner", "/owner");
    const worktrees = new WorktreeRepo(owned.db, owned.writer);
    const registered = await worktrees.register(workspace.id, { canonicalPath: "/owner/worktree", label: "First", managed: true });
    expect(worktrees.findCurrentById(workspace.id, registered.worktreeId)?.canonicalPath).toBe("/owner/worktree");
    const reconciled = await worktrees.reconcile(workspace.id, [{ canonicalPath: "/owner/worktree", label: "Renamed", managed: true }]);
    expect(reconciled).toEqual([{ worktreeId: registered.worktreeId, label: "Renamed" }]);
    const preferences = new WorkspaceTerminalPreferencesService(owned.db, owned.writer);
    await preferences.update(workspace.id, "automatic");
    expect(preferences.get(workspace.id)?.defaultProfileId).toBe("automatic");
    await expect(preferences.update("missing", "automatic")).rejects.toMatchObject({ name: "TerminalWorkspaceNotFoundError", code: "WORKSPACE_NOT_FOUND" });
    expect(await preferences.reset(workspace.id)).toBe(true);
    const models = new ModelCacheRepo(owned.db, owned.writer);
    await models.upsert("codex", [{ id: "model", name: "Model" }]);
    expect(models.get("codex")?.models).toEqual([{ id: "model", name: "Model" }]);
    const configuration = new WorkspaceEnvironmentConfigurationRepo(owned.db, owned.writer);
    await configuration.setStorageMode(workspace.id, "shared");
    await configuration.approve(workspace.id, "setup", "fingerprint");
    expect(configuration.storageMode(workspace.id)).toBe("shared");
    expect(configuration.hasApproval(workspace.id, "setup", "fingerprint")).toBe(true);
    await configuration.clearApprovals(workspace.id);
    expect(configuration.hasApproval(workspace.id, "setup", "fingerprint")).toBe(false);
  });

  it("rolls back duplicate queued Turn admission and serializes release claims exactly once", async () => {
    const workspace = await new WorkspaceRepo(owned.db, owned.writer).create("Setup", "/setup");
    const thread = new ThreadStore(owned.db).create(workspace.id, "Setup", "worktree", "main");
    const repository = new WorkspaceEnvironmentAutomaticRepository(owned.db, () => "2026-10-01T10:00:00.000Z", owned.writer);
    const input = { threadId: thread.id, messageId: "queued-message", content: "Build", attachments: [], mentions: [], submission: { threadId: thread.id, messageId: "queued-message", content: "Build", displayContent: "Build", model: "model", attachments: [], persistedAttachments: [], mentions: [], permissionMode: "default" as const, provider: "codex" } };
    const admitted = await repository.queueFirstTurn(input);
    expect(admitted.queued).toBe(true);
    await expect(repository.queueFirstTurn(input)).rejects.toThrow("UNIQUE");
    expect(repository.snapshot(thread.id).queuedTurns).toHaveLength(1);
    await repository.releaseWithoutSetup(thread.id);
    const claims = await Promise.all([repository.claimReleasedTurn(thread.id), repository.claimReleasedTurn(thread.id)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const claim = claims.find((value) => value !== null);
    if (!claim) throw new Error("Missing claim");
    expect(await repository.markDispatched(claim.id)).toBe(true);
    expect(await repository.markDispatched(claim.id)).toBe(false);
    expect(repository.snapshot(thread.id).queuedTurns[0]?.state).toBe("dispatched");
  });

  it("preserves Project Action revision CAS and leaves the next write usable after a rejected command", async () => {
    const workspace = await new WorkspaceRepo(owned.db, owned.writer).create("Action", "/action");
    const thread = new ThreadStore(owned.db).create(workspace.id, "Action", "direct", "main");
    const runs = new ProjectActionRunRepo(owned.db, owned.writer);
    const run: WorkspaceEnvironmentActionRun = { threadId: thread.id, workspaceId: workspace.id, actionId: "build", runId: "run", revision: 1, terminalSessionId: "terminal", trigger: "manual", actionName: "Build", status: "running", snapshot: { platform: "windows", script: "build", checkoutPath: "/action", terminal: null, environmentNames: [] }, createdAt: "2026-10-01T10:00:00.000Z", startedAt: "2026-10-01T10:00:00.000Z", finishedAt: null, exitCode: null, transcript: "", transcriptTruncated: false };
    await runs.replace(run);
    expect(await runs.updateIfCurrent({ ...run, revision: 2, transcript: "saved" })).toBe(true);
    expect(await runs.updateIfCurrent({ ...run, revision: 2, transcript: "stale" })).toBe(false);
    expect(await runs.updateIfCurrent({ ...run, runId: "old", revision: 3 })).toBe(false);
    expect(runs.get(thread.id, "build")?.transcript).toBe("saved");
    const interrupted = await runs.interruptRunning("2026-10-01T10:01:00.000Z");
    expect(interrupted).toMatchObject([{ status: "interrupted", revision: 3 }]);
  });
});
