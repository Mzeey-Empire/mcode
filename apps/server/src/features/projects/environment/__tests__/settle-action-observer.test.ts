import { describe, expect, it, vi } from "vitest";
import { CanonicalAgentSemanticEnvelopeSchema } from "@mcode/contracts";
import { logger } from "@mcode/shared";
import type { CanonicalAgentEventEnvelope, WorkspaceEnvironmentAction } from "@mcode/contracts";
import { WorkspaceEnvironmentServiceError } from "../workspace-environment-errors.js";
import { SettleActionObserver, type SettleActionThread, type SettleTimers } from "../settle-action-observer.js";

const AT = "2026-10-20T12:00:00.000Z";
const THREAD = "thread-1";
const executionId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

type Payload = "turn.completed" | "turn.errored" | "turn.cancelled" | "turn.interrupted";

function turnEvent(type: Payload, execution: number, threadId = THREAD): CanonicalAgentEventEnvelope {
  const payload = type === "turn.completed" ? { type, endedAt: AT }
    : type === "turn.errored" ? { type, endedAt: AT, error: "boom" }
      : { type, endedAt: AT, reason: "stopped" };
  return CanonicalAgentSemanticEnvelopeSchema.parse({
    eventId: `event-${type}-${execution}`,
    routing: { threadId, turnId: `turn-${execution}`, executionId: executionId(execution) },
    sourceProviderId: "codex", sourceIdentities: [], acceptedSequence: execution,
    serverTimestamps: { acceptedAt: AT }, payload,
  });
}

class ManualTimers {
  private next = 0;
  readonly pending = new Map<number, { callback: () => void; delayMs: number }>();
  readonly timers: SettleTimers = (callback, delayMs) => {
    const handle = ++this.next;
    this.pending.set(handle, { callback, delayMs });
    return () => { this.pending.delete(handle); };
  };
  fireAll(): void {
    const due = [...this.pending.values()];
    this.pending.clear();
    for (const { callback } of due) callback();
  }
}

const dev: WorkspaceEnvironmentAction = { id: "dev", name: "Dev", command: { default: "vite" }, runOnSettle: true };
const lint: WorkspaceEnvironmentAction = { id: "lint", name: "Lint", command: { default: "lint" }, runOnSettle: true };
const startupOnly: WorkspaceEnvironmentAction = { id: "install", name: "Install", command: { default: "bun i" }, runOnStartup: true };

function harness(overrides: {
  actions?: WorkspaceEnvironmentAction[];
  thread?: Partial<SettleActionThread> | null;
  running?: string[];
  waiting?: boolean;
  pathExists?: boolean;
  onLaunch?: (state: { running: string[]; waiting: boolean }) => void;
  launchError?: Error;
  launchRuns?: boolean;
} = {}) {
  const timers = new ManualTimers();
  let listener: (events: readonly CanonicalAgentEventEnvelope[]) => void = () => undefined;
  const state = { running: overrides.running ?? [], waiting: overrides.waiting ?? false };
  const launched: Array<{ slot: unknown; options: unknown }> = [];
  const launch = vi.fn(async (slot: { threadId: string; actionId: string }, options: { trigger: "manual" | "startup"; skipUnapproved?: boolean }) => {
    launched.push({ slot, options });
    overrides.onLaunch?.(state);
    if (overrides.launchError && launched.length === 1) throw overrides.launchError;
    return overrides.launchRuns ? ({ runId: "run" } as never) : null;
  });
  const thread: SettleActionThread | null = overrides.thread === null ? null : {
    id: THREAD, workspace_id: "workspace", mode: "local", worktree_path: null, ...overrides.thread,
  };
  const observer = new SettleActionObserver({
    // Delivery outlives stop() so a test can replay an event after the timer already fired.
    subscribe: (next) => { listener = next; return () => undefined; },
    threads: { findById: (id) => (thread && id === thread.id ? thread : null) },
    runningThreadIds: () => state.running,
    isWaiting: () => state.waiting,
    environment: { read: async () => ({ document: { actions: overrides.actions ?? [dev, startupOnly] } }) },
    actions: { launch },
    pathExists: async () => overrides.pathExists ?? true,
    timers: timers.timers,
  });
  observer.start();
  return {
    observer, timers, state, launch, launched,
    emit: (...events: CanonicalAgentEventEnvelope[]) => listener(events),
    async settle() { timers.fireAll(); await observer.stop(); },
  };
}

describe("SettleActionObserver", () => {
  it("launches only runOnSettle actions as unattended manual runs after a completed Turn", async () => {
    const h = harness({ actions: [dev, startupOnly, lint] });
    h.emit(turnEvent("turn.completed", 1));
    expect(h.launch).not.toHaveBeenCalled();
    await h.settle();
    expect(h.launched).toEqual([
      { slot: { threadId: THREAD, actionId: "dev" }, options: { trigger: "manual", skipUnapproved: true } },
      { slot: { threadId: THREAD, actionId: "lint" }, options: { trigger: "manual", skipUnapproved: true } },
    ]);
  });

  it("fires once for a repeated execution id", async () => {
    const h = harness();
    h.emit(turnEvent("turn.completed", 1));
    h.emit(turnEvent("turn.completed", 1));
    expect(h.timers.pending.size).toBe(1);
    await h.settle();
    h.emit(turnEvent("turn.completed", 1));
    await h.settle();
    expect(h.launch).toHaveBeenCalledOnce();
  });

  it.each(["turn.errored", "turn.cancelled", "turn.interrupted"] as const)("does nothing after %s", async (type) => {
    const h = harness();
    h.emit(turnEvent(type, 1));
    expect(h.timers.pending.size).toBe(0);
    await h.settle();
    expect(h.launch).not.toHaveBeenCalled();
  });

  it("lets a newer completion replace the pending timer so a burst launches once", async () => {
    const h = harness();
    h.emit(turnEvent("turn.completed", 1));
    h.emit(turnEvent("turn.completed", 2));
    expect(h.timers.pending.size).toBe(1);
    await h.settle();
    expect(h.launch).toHaveBeenCalledOnce();
  });

  it("keeps separate timers for separate threads", async () => {
    const h = harness();
    h.emit(turnEvent("turn.completed", 1), turnEvent("turn.completed", 2, "thread-2"));
    expect(h.timers.pending.size).toBe(2);
  });

  it("launches nothing when the thread started another Turn during the delay", async () => {
    const h = harness();
    h.emit(turnEvent("turn.completed", 1));
    h.state.running = [THREAD];
    await h.settle();
    expect(h.launch).not.toHaveBeenCalled();
  });

  it("launches nothing while the thread waits on the user", async () => {
    const h = harness({ waiting: true });
    h.emit(turnEvent("turn.completed", 1));
    await h.settle();
    expect(h.launch).not.toHaveBeenCalled();
  });

  it("stops launching later actions once the thread becomes busy", async () => {
    const h = harness({ actions: [dev, lint], onLaunch: (state) => { state.running = [THREAD]; } });
    h.emit(turnEvent("turn.completed", 1));
    await h.settle();
    expect(h.launched.map(({ slot }) => slot)).toEqual([{ threadId: THREAD, actionId: "dev" }]);
  });

  it.each([
    ["deleted", { deleted_at: AT }],
    ["completed by the user", { user_completed_at: AT }],
    ["missing", null],
  ] as const)("skips a thread that is %s", async (_label, thread) => {
    const h = harness({ thread });
    h.emit(turnEvent("turn.completed", 1));
    await h.settle();
    expect(h.launch).not.toHaveBeenCalled();
  });

  it("skips a worktree thread whose directory is gone and still runs for a live one", async () => {
    const gone = harness({ thread: { mode: "worktree", worktree_path: "/gone" }, pathExists: false });
    gone.emit(turnEvent("turn.completed", 1));
    await gone.settle();
    expect(gone.launch).not.toHaveBeenCalled();

    const live = harness({ thread: { mode: "worktree", worktree_path: "/live" }, pathExists: true });
    live.emit(turnEvent("turn.completed", 1));
    await live.settle();
    expect(live.launch).toHaveBeenCalledOnce();
  });

  it("keeps observing after one launch throws", async () => {
    const h = harness({ actions: [dev, lint], launchError: new Error("boom") });
    h.emit(turnEvent("turn.completed", 1));
    await h.settle();
    expect(h.launched.map(({ slot }) => slot)).toEqual([
      { threadId: THREAD, actionId: "dev" }, { threadId: THREAD, actionId: "lint" },
    ]);
  });

  it("reports a service refusal once as a skip and a surprise as an error", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => logger);
    const error = vi.spyOn(logger, "error").mockImplementation(() => logger);
    const refusal = new WorkspaceEnvironmentServiceError("WORKSPACE_ENVIRONMENT_NOT_FOUND", "Thread not found");
    const refused = harness({ launchError: refusal });
    refused.emit(turnEvent("turn.completed", 1));
    await refused.settle();
    expect(warn).toHaveBeenCalledOnce();
    expect(error).not.toHaveBeenCalled();

    const surprised = harness({ launchError: new Error("boom") });
    surprised.emit(turnEvent("turn.completed", 1));
    await surprised.settle();
    expect(error).toHaveBeenCalledOnce();
    vi.restoreAllMocks();
  });
});
