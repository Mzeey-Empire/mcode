import "reflect-metadata";
import { afterEach, describe, expect, it } from "vitest";
import { createMockMessage } from "@mcode/contracts/testing";
import { getMcodeDir } from "@mcode/shared";
import type { BackgroundCallKind } from "@mcode/contracts/models/tool-call-record";
import { openMemoryDatabase } from "../../../../runtime/persistence/sqlite/database.js";
import { CanonicalAgentStore } from "../../canonical/canonical-agent-store.js";
import { notifyCommittedCanonicalEvents } from "../../canonical/committed-canonical-events.js";
import { AgentWorkloadService } from "../agent-workload.js";
import { syntheticThreadExecutionId } from "../../canonical/canonical-thread-execution.js";
import { MessageStore } from "../../conversation/persistence/message-store.js";
import { ThreadStore } from "../../../thread-control/persistence/thread-store.js";
import { ThreadDeletionTeardownService } from "../../../thread-control/lifecycle/thread-deletion-teardown-service.js";
import { ProjectLifecycleStore } from "../../../projects/lifecycle/project-lifecycle-store.js";
import { projectLifecycleWriteOperations } from "../../../projects/lifecycle/project-lifecycle-write-operations.js";
import { WorkspaceService } from "../../../projects/lifecycle/workspace-service.js";
import type { ApplicationDatabaseWriter } from "../../../../runtime/persistence/sqlite/application-database-writer.js";

const NOW = "2026-11-17T12:00:00.000Z";
const disposers: (() => void)[] = [];
afterEach(() => { for (const dispose of disposers.splice(0)) dispose(); });

function harness() {
  const db = openMemoryDatabase();
  disposers.push(() => db.close());
  db.prepare("INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES ('w', 'w', 'C:/fixture', ?, ?)").run(NOW, NOW);
  const store = new CanonicalAgentStore(db, notifyCommittedCanonicalEvents);
  const active = new Set<string>();
  const workload = new AgentWorkloadService({ activeTurnThreadIds: () => [...active] }, store);
  disposers.push(workload.observeCommittedEvents());
  function hold(threadId: string, kind?: BackgroundCallKind, id = threadId, parentThreadId: string | null = null) {
    if (!store.loadTurn(threadId)) {
      db.prepare("INSERT INTO threads (id, workspace_id, title, branch, provider, parent_thread_id, created_at, updated_at) VALUES (?, 'w', 'test', 'main', 'claude', ?, ?, ?)").run(threadId, parentThreadId, NOW, NOW);
      store.startParentTurn({ thread: { id: threadId, workspaceId: "w", providerId: "claude", createdAt: NOW },
        turnId: threadId, executionId: syntheticThreadExecutionId(threadId), permissionMode: "supervised", providerIdentities: [],
        approvalReviewMode: "manual", approvalReviewReason: "manual-requested",
        projectUserMessage: () => createMockMessage({ id: `user-${threadId}`, thread_id: threadId, role: "user" }) });
    }
    const message = new MessageStore(db).create(threadId, "assistant", "Background work", 2);
    const record = { id, message_id: message.id, parent_tool_call_id: null, tool_name: "Any provider tool",
      input_summary: "", output_summary: "", status: "running" as const, background: true, background_kind: kind,
      background_label: "Investigate", started_at: NOW, completed_at: null, sort_order: 0 };
    store.commit({ threadId, turnId: threadId, executionId: syntheticThreadExecutionId(threadId), phase: "completed", events: [{ eventId: `held-${id}`, routing: { threadId, turnId: threadId, executionId: syntheticThreadExecutionId(threadId), itemId: `toolCall:${id}` }, sourceProviderId: "claude", sourceIdentities: [],
      payload: { type: "item.recorded", item: { id: `toolCall:${id}`, threadId, turnId: threadId, kind: "tool-call", providerIdentities: [],
        payload: { projection: "toolCall", record }, createdAt: NOW, updatedAt: NOW } } },
      { eventId: `ended-${id}`, routing: { threadId, turnId: threadId, executionId: syntheticThreadExecutionId(threadId) }, sourceProviderId: "claude", sourceIdentities: [],
        payload: { type: "turn.completed", endedAt: NOW } }] });
    return record;
  }
  // Deleting persistent data uses only accepted progress, so the teardown collaborators stay unused.
  const unused = (): never => { throw new Error("Thread teardown is not under test"); };
  const deletion = new ThreadDeletionTeardownService({ findById: unused }, { beginThreadDeletion: unused, cancelSetupForThread: unused },
    { beginThreadTeardown: unused, stopForThread: unused }, { cancelForRepoPath: unused }, { teardownThread: unused },
    { teardownThread: unused }, { unwatchThreadWorktree: unused });
  deletion.bindAcceptedProgress({ discardThreads: async () => {}, finishThreadDeletion: () => {} });
  disposers.push(deletion.onPersistentDataDeleted((hidden) => workload.refreshTracked(hidden)));
  return { db, store, workload, active, hold, deletion };
}

describe("AgentWorkload", () => {
  it("unions running turns and background subagents by thread", () => {
    const { workload, active, hold } = harness();
    active.add("first");
    expect(workload.count()).toBe(1);
    hold("first", "subagent");
    expect(workload.count()).toBe(1);
    active.clear();
    expect(workload.count()).toBe(1);
    hold("second", "subagent");
    expect(workload.count()).toBe(2);
  });

  it("ignores commands and unclassified legacy calls", () => {
    const { workload, hold } = harness();
    hold("command", "command");
    hold("legacy");
    expect(workload.count()).toBe(0);
    expect(workload.backgroundSubagentThreadIds().has("legacy")).toBe(false);
  });

  it("notifies only first and last subagent transitions, including late saved results", () => {
    const { workload, hold, store } = harness();
    const changes: string[] = [];
    const unsubscribe = workload.onSubagentChange((threadId) => changes.push(threadId));
    const first = hold("first", "subagent", "a");
    const second = hold("first", "subagent", "b");
    function settle(record: typeof first) {
      store.commit({ threadId: "first", turnId: "first", executionId: syntheticThreadExecutionId("first"), phase: "completed", events: [{ eventId: `settled-${record.id}`, routing: { threadId: "first", turnId: "first", executionId: syntheticThreadExecutionId("first"), itemId: `toolCall:${record.id}` }, sourceProviderId: "claude", sourceIdentities: [],
        payload: { type: "item.recorded", item: { id: `toolCall:${record.id}`, threadId: "first", turnId: "first", kind: "tool-call", providerIdentities: [],
          payload: { projection: "toolCall", record: { ...record, status: "completed", completed_at: NOW } }, createdAt: NOW, updatedAt: NOW } } }] });
    }
    expect(changes).toEqual(["first"]);
    settle(first);
    expect(workload.count()).toBe(1);
    expect(changes).toEqual(["first"]);
    settle(second);
    expect(workload.count()).toBe(0);
    expect(changes).toEqual(["first", "first"]);
    unsubscribe();
    hold("second", "subagent");
    expect(changes).toEqual(["first", "first"]);
  });

  it("drops a deleted thread and the child threads its deletion cascades to", async () => {
    const { db, workload, hold, deletion } = harness();
    const changes: string[] = [];
    disposers.push(workload.onSubagentChange((threadId) => changes.push(threadId)));
    hold("parent", "subagent");
    hold("child", "subagent", "child", "parent");
    hold("other", "subagent");
    expect(workload.count()).toBe(3);

    await deletion.deletePersistentData(["parent"], async () => new ThreadStore(db).hardDelete("parent"));

    expect(workload.count()).toBe(1);
    expect(workload.backgroundSubagentThreadIds().has("other")).toBe(true);
    expect(changes).toEqual(["parent", "child", "other", "parent", "child"]);
  });

  it("drops a soft-deleted thread before its delayed cleanup removes it", () => {
    const { db, workload, hold, deletion } = harness();
    hold("hidden", "subagent");
    hold("other", "subagent");

    new ThreadStore(db).softDelete("hidden");
    deletion.notifyThreadsHidden(["hidden"]);

    expect(workload.count()).toBe(1);
    expect(workload.backgroundSubagentThreadIds().has("hidden")).toBe(false);
  });

  /** Soft-deletes workspace `w` through its service; the given teardown never lets it reach the later write. */
  function deleteWorkspace({ db, deletion }: ReturnType<typeof harness>, teardownThread: () => Promise<void>) {
    const writer = { execute: async (operation: unknown, input: [string]) => {
      if (operation !== projectLifecycleWriteOperations.beginWorkspaceDeletion) throw new Error("Unexpected write");
      return new ProjectLifecycleStore(db).beginWorkspaceDeletion(...input);
    } } as unknown as ApplicationDatabaseWriter;
    const unusedDependency = {} as never;
    const workspaces = new WorkspaceService(unusedDependency, unusedDependency, writer,
      { removeForThread: () => {} }, Object.assign(deletion, { teardownThread }), unusedDependency,
      { killByThread: async () => {} }, getMcodeDir());
    workspaces.delete("w").catch(() => {});
  }

  it.each([
    ["waits", () => new Promise<void>(() => {})],
    ["fails", () => Promise.reject(new Error("Session would not stop"))],
  ])("drops a deleted workspace's thread whose only work is a background subagent while its teardown %s", async (_teardown, teardownThread) => {
    const test = harness();
    test.hold("idle-parent", "subagent");
    expect(test.workload.count()).toBe(1);

    deleteWorkspace(test, teardownThread);

    await expect.poll(() => test.workload.count()).toBe(0);
    expect(test.workload.backgroundSubagentThreadIds().has("idle-parent")).toBe(false);
  });

  it("drops a deleted workspace's thread whose turn is still running while its teardown waits", async () => {
    const test = harness();
    test.db.prepare("INSERT INTO threads (id, workspace_id, title, branch, provider, created_at, updated_at) VALUES ('running', 'w', 'test', 'main', 'claude', ?, ?)").run(NOW, NOW);
    test.active.add("running");
    expect(test.workload.count()).toBe(1);

    deleteWorkspace(test, () => new Promise<void>(() => {}));

    await expect.poll(() => test.db.prepare("SELECT deleted_at IS NOT NULL AS hidden FROM threads WHERE id = 'running'").get())
      .toEqual({ hidden: 1 });
    expect(test.workload.count()).toBe(0);
  });

  it("drops every thread of a deleted workspace", async () => {
    const { db, workload, hold, deletion } = harness();
    hold("first", "subagent");
    hold("second", "subagent");

    await deletion.deletePersistentData(["first", "second"], async () => new ProjectLifecycleStore(db).forceDeleteWorkspace("w"));

    expect(workload.count()).toBe(0);
  });
});
