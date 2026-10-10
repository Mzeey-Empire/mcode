import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "bun:sqlite";
import type { WorkspaceEnvironmentActionRun } from "@mcode/contracts";
import { openMemoryDatabase } from "../../../../../runtime/persistence/sqlite/database.js";
import { ThreadStore } from "../../../../thread-control/persistence/thread-store.js";
import { WorkspaceStore } from "../../../persistence/workspace-store.js";
import { ProjectActionRunStore } from "../project-action-run-store.js";

const RETAINED_ACTION_RUNS_PER_THREAD = 256;

function run(
  threadId: string,
  workspaceId: string,
  actionId: string,
  index: number,
  status: "running" | "completed" = "completed",
): WorkspaceEnvironmentActionRun {
  const timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
  return {
    threadId,
    workspaceId,
    actionId,
    runId: `run-${index}`,
    revision: 1,
    terminalSessionId: status === "running" ? `terminal-${index}` : null,
    trigger: "manual",
    actionName: `Deleted action ${index}`,
    status,
    snapshot: {
      platform: "windows",
      script: "bun run build",
      checkoutPath: "C:\\repo",
      terminal: null,
      environmentNames: [],
    },
    createdAt: timestamp,
    startedAt: timestamp,
    finishedAt: status === "running" ? null : timestamp,
    exitCode: status === "running" ? null : 0,
    transcript: "",
    transcriptTruncated: false,
  };
}

describe("ProjectActionRunStore retention", () => {
  let db: Database;
  let repo: ProjectActionRunStore;
  let threadId: string;
  let workspaceId: string;

  beforeEach(() => {
    db = openMemoryDatabase();
    const workspace = new WorkspaceStore(db).create("Action retention", "C:\\repo");
    const thread = new ThreadStore(db).create(workspace.id, "Thread", "direct", "main");
    repo = new ProjectActionRunStore(db);
    threadId = thread.id;
    workspaceId = workspace.id;
  });

  afterEach(() => {
    db.close();
  });

  it("persists run triggers and clears terminal identity during startup recovery", () => {
    repo.replace(run(threadId, workspaceId, "manual", 0, "running"));
    repo.replace({ ...run(threadId, workspaceId, "startup", 1, "running"), trigger: "startup" });
    const recovered = repo.interruptRunning("2026-01-02T00:00:00.000Z");
    expect(recovered.map(({ actionId, trigger, status, terminalSessionId }) => ({
      actionId, trigger, status, terminalSessionId,
    }))).toEqual([
      { actionId: "manual", trigger: "manual", status: "interrupted", terminalSessionId: null },
      { actionId: "startup", trigger: "startup", status: "interrupted", terminalSessionId: null },
    ]);
    expect(repo.get(threadId, "startup")).toMatchObject({ trigger: "startup", terminalSessionId: null });
  });

  it("defaults a pre-trigger insert to manual through the migrated database", () => {
    const original = run(threadId, workspaceId, "old", 0);
    db.prepare(`INSERT INTO project_action_runs
      (thread_id, workspace_id, action_id, run_id, revision, action_name, status,
       snapshot_json, created_at, started_at, finished_at, exit_code)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      threadId, workspaceId, original.actionId, original.runId, original.revision,
      original.actionName, original.status, JSON.stringify(original.snapshot),
      original.createdAt, original.startedAt, original.finishedAt, original.exitCode,
    );
    expect(repo.get(threadId, "old")).toEqual(original);
  });

  it("keeps the newest bounded deleted Action slots using an independent retention oracle", () => {
    const submitted = Array.from({ length: RETAINED_ACTION_RUNS_PER_THREAD + 1 }, (_, index) =>
      run(threadId, workspaceId, `deleted-${index.toString().padStart(3, "0")}`, index),
    );
    for (const candidate of submitted) repo.replace(candidate);

    const expected = [...submitted]
      .sort((left, right) =>
        right.createdAt.localeCompare(left.createdAt) || right.actionId.localeCompare(left.actionId),
      )
      .slice(0, RETAINED_ACTION_RUNS_PER_THREAD)
      .map((candidate) => candidate.actionId);
    const retained = repo.list(threadId);

    expect(retained.map((candidate) => candidate.actionId)).toEqual(expected);
    expect(retained).toHaveLength(RETAINED_ACTION_RUNS_PER_THREAD);
    expect(retained.every((candidate) => candidate.actionName.startsWith("Deleted action"))).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS count FROM project_action_runs WHERE thread_id = ?")
      .get(threadId)).toEqual({ count: RETAINED_ACTION_RUNS_PER_THREAD });
  });

  it("keeps a running slot through finalized retention and preserves its final result", () => {
    const active = run(threadId, workspaceId, "active", 0, "running");
    const finalized = Array.from({ length: RETAINED_ACTION_RUNS_PER_THREAD + 1 }, (_, index) =>
      run(threadId, workspaceId, `deleted-${(index + 1).toString().padStart(3, "0")}`, index + 1),
    );
    repo.replace(active);
    for (const candidate of finalized) repo.replace(candidate);

    expect(repo.get(threadId, active.actionId)).toMatchObject({ status: "running" });
    const finalizedActive = {
      ...active,
      revision: 2,
      status: "completed" as const,
      finishedAt: "2026-01-01T00:00:00.000Z",
      exitCode: 0,
    };
    expect(repo.updateIfCurrent(finalizedActive)).toBe(true);

    const expectedFinalized = [...finalized]
      .sort((left, right) =>
        right.createdAt.localeCompare(left.createdAt) || right.actionId.localeCompare(left.actionId),
      )
      .slice(0, RETAINED_ACTION_RUNS_PER_THREAD - 1)
      .map((candidate) => candidate.actionId);
    const retained = repo.list(threadId);

    expect(retained.map((candidate) => candidate.actionId)).toEqual([...expectedFinalized, active.actionId]);
    expect(retained).toHaveLength(RETAINED_ACTION_RUNS_PER_THREAD);
    expect(repo.get(threadId, active.actionId)).toMatchObject({
      runId: active.runId,
      status: "completed",
      revision: 2,
    });
  });
});
