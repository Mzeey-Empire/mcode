import { createMockThread } from "@mcode/contracts/testing";
import { describe, expect, it } from "vitest";
import { WS_CHANNELS } from "../channels.js";
import { WS_METHODS } from "../methods.js";

describe("thread completion transport", () => {
  it("validates complete and reopen operations", () => {
    expect(WS_METHODS()["thread.complete"].params.parse({ threadId: "thread-1" })).toEqual({
      threadId: "thread-1",
    });
    expect(WS_METHODS()["thread.reopen"].params.parse({ threadId: "thread-1" })).toEqual({
      threadId: "thread-1",
    });
    expect(WS_METHODS()["thread.cleanupBlockedCount"].params.parse({})).toEqual({});
    expect(WS_METHODS()["thread.cleanupBlockedCount"].result.parse({ count: 2 })).toEqual({ count: 2 });
    expect(WS_METHODS()["thread.retryCleanup"].params.parse({ threadId: "thread-1" })).toEqual({
      threadId: "thread-1",
    });
    expect(WS_METHODS()["thread.cleanupBlockedCount"].result.safeParse({ count: -1 }).success).toBe(false);
  });

  it("validates the full persisted thread in lifecycle pushes", () => {
    const thread = createMockThread({
      id: "thread-1",
      workspace_id: "workspace-1",
      title: "Completed thread",
      status: "paused",
      mode: "direct",
      branch: "main",
      checkout_state: "named",
      worktree_managed: true,
      created_at: "2026-08-12T08:00:00.000Z",
      updated_at: "2026-08-12T08:00:00.000Z",
      provider: "claude",
      user_completed_at: "2026-08-12T08:00:00.000Z",
      scheduled_deletion_at: "2026-08-15T08:00:00.000Z",
      cleanup_state: "blocked",
      cleanup_reason: "The worktree has uncommitted changes.",
    });

    expect(WS_CHANNELS["thread.lifecycleChanged"].parse({ thread })).toEqual({ thread });
  });

  it("validates automatic deletion pushes", () => {
    expect(WS_CHANNELS["thread.deleted"].parse({ threadId: "thread-1" })).toEqual({
      threadId: "thread-1",
    });
  });
});
