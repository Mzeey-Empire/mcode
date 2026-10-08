import { describe, it, expect } from "vitest";
import { getStatusDisplay, getNotificationDot } from "@/lib/thread-status";
import type { Thread } from "@/transport/types";

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: "t1",
    workspace_id: "ws1",
    title: "Test",
    status: "active",
    mode: "direct",
    worktree_path: null,
    branch: "main",
    checkout_state: "named",
    base_branch: null,
    worktree_managed: false,
    issue_number: null,
    pr_number: null,
    pr_status: null,
    sdk_session_id: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    model: null,
    provider: "claude",
    deleted_at: null,
    user_completed_at: null,
    scheduled_deletion_at: null,
    cleanup_state: null,
    cleanup_reason: null,
    last_context_tokens: null,
    context_window: null,
    reasoning_level: null,
    interaction_mode: null,
    orchestration_mode: null,
    permission_mode: null,
    context_window_mode: null,
    thinking: null,
    codex_fast_mode: null,
    devin_mode: null,
    parent_thread_id: null,
    forked_from_message_id: null,
    last_compact_summary: null,
    default_open_in_app: null,
    has_file_changes: false,
    ...overrides,
  };
}

describe("getStatusDisplay", () => {
  it("isActuallyRunning=true returns no label and pulsing primary dot", () => {
    const result = getStatusDisplay(makeThread(), true);
    expect(result.label).toBe("");
    expect(result.color).toBe("text-primary/90");
    expect(result.dotClass).toContain("bg-primary");
    expect(result.dotClass).toContain("status-pulse");
  });

  it("errored status returns Errored with error color", () => {
    const result = getStatusDisplay(makeThread({ status: "errored" }), false);
    expect(result.label).toBe("Errored");
    expect(result.color).toContain("error");
  });

  it("completed status returns no label with success dot", () => {
    const result = getStatusDisplay(makeThread({ status: "completed" }), false);
    expect(result.label).toBe("");
    expect(result.dotClass).toContain("success");
  });

  it("default status returns empty label", () => {
    const result = getStatusDisplay(makeThread({ status: "active" }), false);
    expect(result.label).toBe("");
  });

  it("shows amber ring with pulse when thread has a pending permission and is running", () => {
    const result = getStatusDisplay(makeThread(), true, true);
    expect(result.shape).toBe("ring");
    expect(result.dotClass).toContain("ring-primary");
    expect(result.dotClass).toContain("status-pulse");
    expect(result.dotClass).toContain("bg-transparent");
    expect(result.color).toBe("text-primary");
  });

  it("returns ring shape when thread has pending permission even if not running", () => {
    const result = getStatusDisplay(makeThread({ status: "active" }), false, true);
    expect(result.shape).toBe("ring");
    expect(result.dotClass).toContain("ring-primary");
  });

  it("returns solid shape when running without a pending permission", () => {
    const result = getStatusDisplay(makeThread(), true, false);
    expect(result.shape).toBe("solid");
  });

  it("returns solid shape for completed threads", () => {
    const result = getStatusDisplay(makeThread({ status: "completed" }), false);
    expect(result.shape).toBe("solid");
  });

  it("returns solid shape for errored threads", () => {
    const result = getStatusDisplay(makeThread({ status: "errored" }), false);
    expect(result.shape).toBe("solid");
  });

  it("returns solid shape for idle threads", () => {
    const result = getStatusDisplay(makeThread({ status: "active" }), false);
    expect(result.shape).toBe("solid");
  });

  it("interrupted status returns Interrupted label and primary dot with pulse", () => {
    const result = getStatusDisplay(makeThread({ status: "interrupted" }), false);
    expect(result.label).toBe("Interrupted");
    expect(result.color).toContain("primary");
    expect(result.dotClass).toContain("primary");
    expect(result.dotClass).toContain("status-pulse");
    expect(result.shape).toBe("solid");
  });

  it("interrupted thread shows running indicator when agent is live (resume in progress)", () => {
    const result = getStatusDisplay(makeThread({ status: "interrupted" }), true);
    expect(result.dotClass).toContain("bg-primary");
    expect(result.dotClass).toContain("status-pulse");
  });
});

describe("getNotificationDot", () => {
  it("returns primary with pulse for running thread", () => {
    const result = getNotificationDot(makeThread(), true);
    expect(result).not.toBeNull();
    expect(result!.dotClass).toContain("bg-primary");
    expect(result!.animate).toBe(true);
  });

  it("returns success for completed thread", () => {
    const result = getNotificationDot(makeThread({ status: "completed" }), false);
    expect(result).not.toBeNull();
    expect(result!.dotClass).toContain("success");
    expect(result!.animate).toBe(false);
  });

  it("returns error for errored thread", () => {
    const result = getNotificationDot(makeThread({ status: "errored" }), false);
    expect(result).not.toBeNull();
    expect(result!.dotClass).toContain("error");
    expect(result!.animate).toBe(false);
  });

  it("returns primary pulse for interrupted thread (including PR rows)", () => {
    const result = getNotificationDot(makeThread({ status: "interrupted", pr_number: 42 }), false);
    expect(result).not.toBeNull();
    expect(result!.dotClass).toContain("primary");
    expect(result!.animate).toBe(true);
  });

  it("returns null for idle thread", () => {
    const result = getNotificationDot(makeThread({ status: "active" }), false);
    expect(result).toBeNull();
  });

  it("returns null for paused thread", () => {
    const result = getNotificationDot(makeThread({ status: "paused" }), false);
    expect(result).toBeNull();
  });

  it("returns ring shape with amber for thread with pending permission", () => {
    const result = getNotificationDot(makeThread(), true, true);
    expect(result).not.toBeNull();
    expect(result!.shape).toBe("ring");
    expect(result!.dotClass).toContain("ring-primary");
    expect(result!.dotClass).toContain("bg-transparent");
    expect(result!.animate).toBe(true);
  });

  it("returns solid shape for running PR thread without pending permission", () => {
    const result = getNotificationDot(makeThread(), true, false);
    expect(result).not.toBeNull();
    expect(result!.shape).toBe("solid");
  });

  it("returns solid shape for completed PR thread", () => {
    const result = getNotificationDot(makeThread({ status: "completed" }), false);
    expect(result).not.toBeNull();
    expect(result!.shape).toBe("solid");
  });
});
