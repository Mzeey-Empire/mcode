import { describe, expect, it } from "vitest";
import {
  THREAD_STARTUP_TRANSCRIPT_ENTRY_MAX_CHARS,
  ThreadStartupSchema,
  ThreadStartupStartInputSchema,
  ThreadStartupStepDetailSchema,
  ThreadStartupErrorSchema,
  ThreadStartupBlockSchema,
} from "../thread-startup.js";

const startupId = "00000000-0000-4000-8000-000000000001";

function directStartup() {
  return {
    startupId,
    workspaceId: "workspace-1",
    kind: "direct" as const,
    state: "pending" as const,
    phase: "thread" as const,
    steps: [
      { phase: "thread" as const, state: "pending" as const },
      { phase: "agent" as const, state: "pending" as const },
    ],
    transcript: [],
    cancellation: "none" as const,
    revision: 1,
    createdAt: "2026-09-02T10:00:00.000Z",
    updatedAt: "2026-09-02T10:00:00.000Z",
  };
}

describe("ThreadStartupSchema", () => {
  it.each([
    ["direct", ["thread", "agent"]],
    ["direct", ["thread", "fetch", "agent"]],
    ["managed-worktree", ["thread", "worktree", "setup", "agent"]],
    ["managed-worktree", ["thread", "fetch", "worktree", "setup", "agent"]],
    ["attached-worktree", ["thread", "worktree", "setup", "agent"]],
    ["pull-request-review", ["thread", "worktree", "agent"]],
  ])("accepts %s ordered phases %j and old records without details or times", (kind, phases) => {
    const record = { ...directStartup(), kind, steps: phases.map((phase) => ({ phase, state: "pending" })) };
    expect(ThreadStartupSchema().parse(record)).toEqual(record);
  });

  it.each([
    ["direct", ["thread", "agent", "fetch"]],
    ["managed-worktree", ["thread", "worktree", "fetch", "setup", "agent"]],
    ["managed-worktree", ["thread", "fetch", "fetch", "setup", "agent"]],
    ["attached-worktree", ["thread", "fetch", "worktree", "setup", "agent"]],
    ["pull-request-review", ["thread", "fetch", "worktree", "agent"]],
  ])("rejects %s invalid phases %j", (kind, phases) => {
    expect(ThreadStartupSchema().safeParse({
      ...directStartup(), kind, steps: phases.map((phase) => ({ phase, state: "pending" })),
    }).success).toBe(false);
  });

  it("parses timed step details and rejects detail on the wrong phase", () => {
    const record = {
      ...directStartup(), kind: "managed-worktree", state: "running", phase: "setup",
      steps: [
        { phase: "thread", state: "completed" },
        { phase: "fetch", state: "completed", detail: { phase: "fetch", ref: "pull/42/head", pullRequestNumber: 42, branch: "feature/pr" } },
        { phase: "worktree", state: "completed", detail: { phase: "worktree", mode: "created", folderName: "checkout", path: "/checkout" } },
        { phase: "setup", state: "running", startedAt: "2026-09-02T10:00:01.000Z", detail: { phase: "setup", exitCode: 1 } },
        { phase: "agent", state: "pending" },
      ],
    };
    expect(ThreadStartupSchema().parse(record)).toEqual(record);
    expect(ThreadStartupSchema().safeParse({ ...record, steps: record.steps.map((step) =>
      step.phase === "setup" ? { ...step, detail: { phase: "fetch", ref: "origin/main" } } : step) }).success).toBe(false);
    expect(ThreadStartupStepDetailSchema().safeParse({ phase: "setup", script: "secret script" }).success).toBe(false);
  });

  it("bounds raw error and block details and validates fetch input", () => {
    const error = { code: "FETCH_FAILED", message: "Git fetch failed", retryable: true };
    const block = { code: "SETUP_FAILED", message: "Setup failed", actions: ["retry"] };
    expect(ThreadStartupErrorSchema().parse({ ...error, detail: "  fatal: offline  " }).detail).toBe("fatal: offline");
    expect(ThreadStartupBlockSchema().parse({ ...block, detail: "  last line  " }).detail).toBe("last line");
    for (const detail of [" ", "x".repeat(2_001)]) {
      expect(ThreadStartupErrorSchema().safeParse({ ...error, detail }).success).toBe(false);
      expect(ThreadStartupBlockSchema().safeParse({ ...block, detail }).success).toBe(false);
    }
    const input = { startupId, workspaceId: "workspace-1", kind: "direct", fetch: { ref: "origin/main" } };
    expect(ThreadStartupStartInputSchema().parse(input)).toEqual(input);
    expect(ThreadStartupStartInputSchema().safeParse({ ...input, kind: "attached-worktree" }).success).toBe(false);
    expect(ThreadStartupStartInputSchema().safeParse({ ...input, fetch: { ref: "x", pullRequestNumber: 0 } }).success).toBe(false);
  });

  it("rejects a completed state before its ordered final phase", () => {
    expect(ThreadStartupSchema().safeParse({
      ...directStartup(),
      state: "completed",
      steps: [
        { phase: "thread", state: "completed" },
        { phase: "agent", state: "pending" },
      ],
    }).success).toBe(false);
  });

  it("rejects output larger than the retained entry bound", () => {
    expect(ThreadStartupSchema().safeParse({
      ...directStartup(),
      transcript: [{
        phase: "thread",
        content: "x".repeat(THREAD_STARTUP_TRANSCRIPT_ENTRY_MAX_CHARS + 1),
        createdAt: "2026-09-02T10:00:00.000Z",
      }],
    }).success).toBe(false);
  });
});
