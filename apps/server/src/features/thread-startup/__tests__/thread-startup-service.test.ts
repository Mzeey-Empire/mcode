import "reflect-metadata";
import * as NodeCrypto from "node:crypto";
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { THREAD_STARTUP_TRANSCRIPT_ENTRY_MAX_CHARS, THREAD_STARTUP_TRANSCRIPT_MAX_CHARS } from "@mcode/contracts/thread-startup";
import { createMockThreadStartup } from "@mcode/contracts/testing";
import { broadcast } from "../../../application/transport/push.js";
import { DatabaseWriterAdmissionFull } from "../../../runtime/persistence/sqlite/application-database-writer.js";
import { openReadOnlyDatabase } from "../../../runtime/persistence/sqlite/read-only-database.js";
import { createOwnedTestDatabase, type OwnedTestDatabase } from "../../projects/testing/owned-test-database.js";
import { ThreadStartupRepo } from "../persistence/thread-startup-repo.js";
import { ThreadStartupStore } from "../persistence/thread-startup-store.js";
import { ThreadStartupConflictError, ThreadStartupService, type ThreadStartupThreadCreation } from "../thread-startup-service.js";

vi.mock("../../../application/transport/push.js", () => ({ broadcast: vi.fn() }));

const harnesses: Array<{ owned: OwnedTestDatabase; reader: Database }> = [];
beforeEach(() => vi.mocked(broadcast).mockReset());
afterEach(async () => {
  for (const { owned, reader } of harnesses.splice(0)) {
    await owned.writer.barrier();
    reader.close(true);
    await owned.close();
  }
});

function harness() {
  const owned = createOwnedTestDatabase();
  owned.db.prepare("INSERT INTO workspaces (id, name, path, provider_config) VALUES (?, ?, ?, ?)").run("workspace-1", "Fixture", "/fixture", "{}");
  owned.db.prepare("INSERT INTO workspaces (id, name, path, provider_config) VALUES (?, ?, ?, ?)").run("workspace-2", "Other fixture", "/other-fixture", "{}");
  const reader = openReadOnlyDatabase(owned.db.filename);
  harnesses.push({ owned, reader });
  const repo = new ThreadStartupRepo(reader, owned.writer);
  let time = Date.parse("2026-09-02T10:00:00.000Z");
  const service = new ThreadStartupService(repo, owned.writer, () => new Date(time++));
  const startupId = NodeCrypto.randomUUID();
  const input = { startupId, workspaceId: "workspace-1", kind: "direct" as const };
  const creation: ThreadStartupThreadCreation = {
    args: ["workspace-1", "Fixture thread", "direct", "main", false, "codex", undefined, undefined, undefined],
  };
  return { ...owned, reader, repo, service, startupId, input, creation };
}

function recoveryFixture(seen: boolean) {
  const { db, service } = harness();
  const store = new ThreadStartupStore(db);
  const thread = (title: string) => {
    const id = NodeCrypto.randomUUID();
    db.prepare("INSERT INTO threads (id, workspace_id, title, branch) VALUES (?, ?, ?, ?)").run(id, "workspace-1", title, "main");
    return id;
  };
  const steps = [{ phase: "thread", state: "completed" }, { phase: "agent", state: "completed" }] as const;
  const completed = createMockThreadStartup({ state: "completed", phase: "agent", steps: [...steps] });
  const blocked = createMockThreadStartup({
    state: "blocked",
    phase: "fetch",
    steps: [steps[0], { phase: "fetch", state: "blocked" }, { phase: "agent", state: "pending" }],
    block: { code: "FETCH_FAILED", message: "Fetch failed", actions: ["retry"] },
  });
  const running = createMockThreadStartup({
    state: "running",
    steps: [{ phase: "thread", state: "running" }, { phase: "agent", state: "pending" }],
  });
  const failed = createMockThreadStartup({
    state: "failed",
    threadId: thread("Failed"),
    steps: [{ phase: "thread", state: "failed" }, { phase: "agent", state: "pending" }],
    error: { code: "CREATE_FAILED", message: "Thread creation failed", retryable: true },
  });
  store.insert(blocked);
  store.insert(running);
  const failedSnapshot = { ...failed, failureSeenAt: seen ? "2026-01-01T00:00:01.000Z" : null };
  store.insert(failedSnapshot);
  const interruptedSetup = createMockThreadStartup({
    kind: "managed-worktree",
    state: "interrupted",
    phase: "setup",
    threadId: thread("Interrupted setup"),
    failureSeenAt: "2026-01-01T00:00:01.000Z",
    steps: [steps[0], { phase: "worktree", state: "completed" }, { phase: "setup", state: "interrupted" }, { phase: "agent", state: "pending" }],
  });
  store.insert(interruptedSetup);
  const supersededThreadId = thread("Completed");
  store.insert({ ...failed, startupId: NodeCrypto.randomUUID(), threadId: supersededThreadId });
  store.insert({ ...completed, threadId: supersededThreadId, updatedAt: "2026-01-02T00:00:00.000Z" });
  store.insert({ ...failed, startupId: NodeCrypto.randomUUID(), threadId: undefined });

  const recentIds = Array.from({ length: 120 }, (_, index) => {
    const startupId = NodeCrypto.randomUUID();
    const updatedAt = new Date(Date.UTC(2026, 1, 1, 0, 0, 119 - index)).toISOString();
    store.insert({ ...completed, startupId, updatedAt });
    return startupId;
  });
  const olderIds = [blocked.startupId, running.startupId, interruptedSetup.startupId];
  if (!seen) olderIds.push(failed.startupId);
  return { service, recentIds: recentIds.slice(0, 100), olderIds: olderIds.sort().reverse() };
}

describe("ThreadStartupService with the actual SQLite owner", () => {
  it.each([false, true])("recovers live startups, unresolved setups and unseen failures outside the 100 recent records (failure seen: %s)", (seen) => {
    const { service, recentIds, olderIds } = recoveryFixture(seen);
    expect(service.list("workspace-1").map(({ startupId }) => startupId)).toEqual([...recentIds, ...olderIds]);
    expect(service.list("workspace-2")).toEqual([]);
  });

  it("acknowledges a failure once and publishes its committed revision", async () => {
    const { service, startupId, input } = harness();
    await service.start(input);
    await service.advance(startupId, "thread");
    const running = await service.advance(startupId, "agent");
    vi.mocked(broadcast).mockClear();
    expect(await service.acknowledgeFailure(startupId, running.revision)).toEqual(running);
    expect(await service.acknowledgeFailure(NodeCrypto.randomUUID(), 1)).toBeNull();
    expect(broadcast).not.toHaveBeenCalled();

    const failed = await service.fail(startupId, { code: "AGENT_FAILED", message: "Agent failed", retryable: true });
    vi.mocked(broadcast).mockReset();
    vi.mocked(broadcast).mockImplementation((method, value) => {
      if (method === "thread.startup.updated") expect(service.get(startupId)).toEqual(value);
    });
    const acknowledged = await service.acknowledgeFailure(startupId, failed.revision);
    expect(acknowledged).toEqual({
      ...failed, failureSeenAt: "2026-09-02T10:00:00.006Z", updatedAt: "2026-09-02T10:00:00.006Z", revision: failed.revision + 1,
    });
    expect(broadcast).toHaveBeenCalledExactlyOnceWith("thread.startup.updated", acknowledged);
    expect(await service.acknowledgeFailure(startupId, failed.revision)).toEqual(acknowledged);
    expect(broadcast).toHaveBeenCalledTimes(1);

    await service.retryAgent(startupId);
    const completed = await service.complete(startupId);
    vi.mocked(broadcast).mockClear();
    expect(await service.acknowledgeFailure(startupId, completed.revision)).toEqual(completed);
    expect(service.get(startupId)).toEqual(completed);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("serializes identical starts, preserves conflict identity, and publishes only committed revisions", async () => {
    const { service, repo, reader, input, startupId, writer } = harness();
    vi.mocked(broadcast).mockImplementation((method, value) => {
      if (method === "thread.startup.updated") expect(repo.findById(startupId)).toEqual(value);
    });
    expect(() => reader.run("DELETE FROM thread_startups")).toThrow(/readonly/i);
    const results = await Promise.all([service.start(input, "request-a"), service.start(input, "request-a")]);
    expect(results[0]).toEqual(results[1]);
    expect(results[0].createdAt).toBe("2026-09-02T10:00:00.000Z");
    expect(broadcast).toHaveBeenCalledTimes(1);
    const reopened = new ThreadStartupService(repo, writer);
    await expect(reopened.start(input, "request-b")).rejects.toBeInstanceOf(ThreadStartupConflictError);
    await expect(service.start({ ...input, workspaceId: "workspace-2" })).rejects.toBeInstanceOf(ThreadStartupConflictError);
    expect(service.get(startupId)).toEqual(results[0]);
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it("rolls back a failed transition without publication and continues processing the next write", async () => {
    const { db, service, input, startupId } = harness();
    const original = await service.start(input);
    vi.mocked(broadcast).mockClear();
    db.run("CREATE TRIGGER reject_startup_transition BEFORE UPDATE ON thread_startups BEGIN SELECT RAISE(ABORT, 'forced transition failure'); END");
    await expect(service.advance(startupId, "thread")).rejects.toThrow("forced transition failure");
    expect(service.get(startupId)).toEqual(original);
    expect(broadcast).not.toHaveBeenCalled();
    db.run("DROP TRIGGER reject_startup_transition");
    const running = await service.advance(startupId, "thread");
    expect(running).toMatchObject({ state: "running", revision: 2 });
    expect(broadcast).toHaveBeenCalledWith("thread.startup.updated", running);
    await expect(service.complete(startupId)).rejects.toThrow("final phase");
    expect(service.get(startupId)).toEqual(running);
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it("rolls back thread creation when binding fails, then commits and reuses exactly one bound thread", async () => {
    const { db, reader, service, input, startupId, creation } = harness();
    const startup = await service.start(input);
    vi.mocked(broadcast).mockClear();
    db.run("CREATE TRIGGER reject_startup_binding BEFORE UPDATE OF thread_id ON thread_startups WHEN NEW.thread_id IS NOT NULL BEGIN SELECT RAISE(ABORT, 'forced binding failure'); END");
    await expect(service.createAndBindThread(startupId, creation)).rejects.toThrow("forced binding failure");
    expect(reader.query("SELECT id FROM threads").all()).toHaveLength(0);
    expect(service.get(startupId)).toEqual(startup);
    expect(broadcast).not.toHaveBeenCalled();
    db.run("DROP TRIGGER reject_startup_binding");
    const thread = await service.createAndBindThread(startupId, { ...creation, worktreePath: "/fixture/.worktrees/test" });
    expect(thread.worktree_path).toBe("/fixture/.worktrees/test");
    expect(service.get(startupId)).toMatchObject({ threadId: thread.id, revision: 2 });
    expect(await service.createAndBindThread(startupId, creation)).toEqual(thread);
    expect(reader.query("SELECT id FROM threads").all()).toHaveLength(1);
    expect(broadcast).toHaveBeenCalledTimes(1);
    const otherWorkspaceCreation: ThreadStartupThreadCreation = { ...creation, args: [...creation.args] };
    otherWorkspaceCreation.args[0] = "workspace-2";
    await expect(service.createAndBindThread(startupId, otherWorkspaceCreation)).rejects.toBeInstanceOf(ThreadStartupConflictError);
  });

  it("rejects over-budget commands and invalid snapshots while retaining bounded output", async () => {
    const { service, repo, input, startupId, creation } = harness();
    const original = await service.start(input);
    vi.mocked(broadcast).mockClear();
    await expect(service.appendOutput(startupId, "x".repeat(THREAD_STARTUP_TRANSCRIPT_ENTRY_MAX_CHARS + 1))).rejects.toThrow();
    await expect(service.createAndBindThread(startupId, { ...creation, worktreePath: "x".repeat(17 * 1024 * 1024) })).rejects.toBeInstanceOf(DatabaseWriterAdmissionFull);
    await expect(repo.update({ ...original, steps: Array.from({ length: 5 }, () => original.steps[0]) })).rejects.toThrow();
    await expect(repo.update({ ...original, steps: [original.steps[0], original.steps[0]] })).rejects.toThrow();
    expect(service.get(startupId)).toEqual(original);
    expect(broadcast).not.toHaveBeenCalled();
    for (let index = 0; index < 6; index += 1) await service.appendOutput(startupId, String(index).padEnd(THREAD_STARTUP_TRANSCRIPT_ENTRY_MAX_CHARS, "x"));
    const transcript = service.get(startupId)?.transcript ?? [];
    expect(transcript).toHaveLength(4);
    expect(transcript[0].content.startsWith("2")).toBe(true);
    expect(transcript.reduce((total, entry) => total + entry.content.length, 0)).toBe(THREAD_STARTUP_TRANSCRIPT_MAX_CHARS);
  });

  it("recovers multiple bounded pages without leaving pending records or repeating publication", async () => {
    const { service, reader, db } = harness();
    const inputs = Array.from({ length: 105 }, () => ({ startupId: NodeCrypto.randomUUID(), workspaceId: "workspace-1", kind: "direct" as const }));
    await Promise.all(inputs.map((input) => service.start(input)));
    const malformedId = "00000000-0000-4000-8000-000000000001";
    await service.start({ startupId: malformedId, workspaceId: "workspace-1", kind: "direct" });
    db.prepare("UPDATE thread_startups SET steps_json = '[]' WHERE startup_id = ?").run(malformedId);
    vi.mocked(broadcast).mockClear();
    const interrupted = await service.interruptNonterminalOnStartup();
    expect(interrupted).toHaveLength(105);
    expect(interrupted.every((record) => record.state === "interrupted" && record.revision === 2)).toBe(true);
    expect(reader.query("SELECT startup_id FROM thread_startups WHERE state IN ('pending', 'running')").all()).toEqual([{ startup_id: malformedId }]);
    expect(broadcast).toHaveBeenCalledTimes(105);
    expect(await service.interruptNonterminalOnStartup()).toEqual([]);
    expect(broadcast).toHaveBeenCalledTimes(105);
  });
});
