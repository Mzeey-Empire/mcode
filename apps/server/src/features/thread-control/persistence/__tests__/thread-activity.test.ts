import { createMockThreadPullRequest } from "@mcode/contracts/testing";
import "reflect-metadata";
import { PullRequestLinkFunnel } from "../../../pull-requests/links/pull-request-link-funnel.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceRepo } from "../../../projects/persistence/workspace-repo.js";
import { canonicalRuntimeWriteOperations } from "../../../agents/canonical/canonical-runtime-write-operations.js";
import { CanonicalParentTurnWrite } from "../../../agents/canonical/canonical-parent-turn-write.js";
import * as push from "../../../../application/transport/push.js";
import { createThreadPersistenceTestRuntime } from "../../testing/thread-persistence-test-runtime.js";
import { ThreadRepo } from "../thread-repo.js";
import { advanceThreadActivity, notifyCommittedThreadActivity } from "../thread-activity.js";

const ADMITTED = "2030-01-01T10:00:00.000Z";
const SETTLED = "2030-01-01T10:01:00.000Z";

async function fixture() {
  const runtime = createThreadPersistenceTestRuntime();
  const threads = new ThreadRepo(runtime.reader, runtime.writer);
  const workspace = await new WorkspaceRepo(runtime.reader, runtime.writer).create("Activity", "/fixture");
  const thread = await threads.create(workspace.id, "Activity", "direct", "main");
  return { ...runtime, threads, thread };
}

afterEach(() => vi.restoreAllMocks());

describe("thread activity", () => {
  it("advances for admission and settle, with no push for equal or older activity", async () => {
    const { threads, thread } = await fixture();
    const broadcast = vi.spyOn(push, "broadcast");
    await threads.advanceActivity(thread.id, ADMITTED);
    expect(threads.findById(thread.id)?.last_activity_at).toBe(ADMITTED);
    await threads.recordTurnOutcome(thread.id, "completed", SETTLED);
    await threads.advanceActivity(thread.id, ADMITTED);
    await threads.advanceActivity(thread.id, SETTLED);
    expect(threads.findById(thread.id)?.last_activity_at).toBe(SETTLED);
    expect(broadcast.mock.calls.filter(([channel]) => channel === "thread.activity")).toEqual([
      ["thread.activity", { threadId: thread.id, at: ADMITTED }],
      ["thread.activity", { threadId: thread.id, at: SETTLED }],
    ]);
  });

  it("does not count settings, PRs, titles, completion, reopen or tokens as activity", async () => {
    const { threads, thread, writer } = await fixture();
    await threads.advanceActivity(thread.id, ADMITTED);
    const broadcast = vi.spyOn(push, "broadcast");
    await threads.updateSettings(thread.id, { model: "another-model" });
    await new PullRequestLinkFunnel(writer, () => undefined, () => undefined).observe(thread.id, [createMockThreadPullRequest({ state: "merged" })], "sync");
    await threads.updateTitle(thread.id, "Renamed");
    await threads.complete(thread.id, SETTLED, null);
    await threads.reopen(thread.id, SETTLED);
    await threads.updateContextUsage(thread.id, 100, 200);
    expect(threads.findById(thread.id)?.last_activity_at).toBe(ADMITTED);
    expect(broadcast.mock.calls.filter(([channel]) => channel === "thread.activity")).toEqual([]);
  });

  it("reads the latest activity, legacy settle or creation timestamp without backfill", async () => {
    const { database, threads, thread } = await fixture();
    const update = database.prepare("UPDATE threads SET last_activity_at = ?, last_turn_ended_at = ?, created_at = ? WHERE id = ?");
    update.run(null, ADMITTED, SETTLED, thread.id);
    expect(threads.findById(thread.id)?.last_activity_at).toBe(SETTLED);
    update.run(null, SETTLED, ADMITTED, thread.id);
    expect(threads.findById(thread.id)?.last_activity_at).toBe(SETTLED);
    update.run(ADMITTED, SETTLED, ADMITTED, thread.id);
    expect(threads.findById(thread.id)?.last_activity_at).toBe(SETTLED);
  });

  it("publishes exactly one advance when the canonical writer settles without ThreadRepo", async () => {
    const { database, writer, threads, thread } = await fixture();
    const executionId = "00000000-0000-4000-8000-000000000001";
    new CanonicalParentTurnWrite(database, () => {}).start({
      thread: { id: thread.id, workspaceId: thread.workspace_id, providerId: "claude", createdAt: ADMITTED },
      turnId: "turn-activity", executionId, permissionMode: "supervised", providerIdentities: [],
      userMessage: { kind: "create", content: "Work", sequence: 1 },
    });
    const broadcast = vi.spyOn(push, "broadcast");
    await writer.execute(canonicalRuntimeWriteOperations.interruptLostExecution, {
      threadId: thread.id, turnId: "turn-activity", executionId, reason: "Worker lost",
      cause: "provider_exited", recoveryIncidentId: "activity-recovery", endedAt: SETTLED,
    });
    expect(threads.findById(thread.id)).toMatchObject({ status: "interrupted", last_activity_at: SETTLED });
    expect(broadcast.mock.calls.filter(([channel]) => channel === "thread.activity")).toEqual([
      ["thread.activity", { threadId: thread.id, at: SETTLED }],
    ]);
  });

  it("discards activity rolled back by the containing transaction", async () => {
    const { database, thread, threads } = await fixture();
    expect(() => database.transaction(() => {
      advanceThreadActivity(database, thread.id, SETTLED);
      throw new Error("rollback");
    })()).toThrow();
    const notifications: Array<{ threadId: string; at: string }> = [];
    notifyCommittedThreadActivity(database, (activity) => notifications.push(activity));
    expect(notifications).toEqual([]);
    expect(threads.findById(thread.id)?.last_activity_at).toBe(thread.created_at);
  });
});
