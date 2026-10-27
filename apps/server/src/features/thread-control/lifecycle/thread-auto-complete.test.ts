import "reflect-metadata";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockThread, createMockThreadPullRequest } from "@mcode/contracts/testing";
import { getDefaultSettings, type Settings } from "@mcode/contracts/models/settings";
import type { ThreadAttention } from "@mcode/contracts/models/thread-attention";
import { ThreadRepo } from "../persistence/thread-repo.js";
import { ThreadAttentionService } from "../attention/thread-attention-service.js";
import { ThreadControlMutationReservationService } from "../authority/thread-control-mutation-reservation-service.js";
import { CleanupJobRepo } from "../cleanup/persistence/cleanup-job-repo.js";
import { createThreadPersistenceTestRuntime } from "../testing/thread-persistence-test-runtime.js";
import { WorkspaceRepo } from "../../projects/persistence/workspace-repo.js";
import { PullRequestLinkFunnel } from "../../pull-requests/links/pull-request-link-funnel.js";
import { CanonicalParentTurnWrite } from "../../agents/canonical/canonical-parent-turn-write.js";
import { ThreadCompletionService } from "./thread-completion-service.js";
import { autoCompleteDecision, ThreadAutoCompleteService, type AutoCompleteDecisionInput } from "./thread-auto-complete.js";
import { broadcast } from "../../../application/transport/push.js";

vi.mock("../../../application/transport/push.js", () => ({ broadcast: vi.fn() }));

const AT = "2030-01-01T10:00:00.000Z";
const MERGED = createMockThreadPullRequest({ state: "merged" });

function quietAttention(): ThreadAttention {
  return { threadId: "thread", waiting: null, lastTurn: null,
    seen: { sequence: null, at: null }, hasUnfinishedDelegatedTasks: false };
}

function decisionInput(overrides: Partial<AutoCompleteDecisionInput> = {}): AutoCompleteDecisionInput {
  return { ...createMockThread({ pull_requests: [MERGED] }), attention: quietAttention(), completeOnPrMerge: true, ...overrides };
}

describe("autoCompleteDecision", () => {
  it.each([
    [[], "pull-requests"],
    [[MERGED, createMockThreadPullRequest({ number: 43, state: "merged" })], "complete"],
    [[MERGED, createMockThreadPullRequest({ number: 43, state: "closed" })], "pull-requests"],
    [[MERGED, createMockThreadPullRequest({ number: 43, state: "open" })], "pull-requests"],
    [[MERGED, createMockThreadPullRequest({ number: 43, state: "draft" })], "pull-requests"],
    [[MERGED, createMockThreadPullRequest({ number: 43, state: "unresolved" })], "pull-requests"],
  ] satisfies Array<[AutoCompleteDecisionInput["pull_requests"], string]>)("requires every PR to be merged: %j", (pull_requests, expected) => {
    expect(autoCompleteDecision(decisionInput({ pull_requests }))).toBe(expected);
  });

  it.each(["completed", "errored", "interrupted"] as const)("waits for an unseen %s result, then allows its seen result", (outcome) => {
    const attention: ThreadAttention = { ...quietAttention(), lastTurn: { outcome, endedAt: AT, sequence: 2, changedFileCount: null } };
    expect(autoCompleteDecision(decisionInput({ attention }))).toBe("needs-user");
    expect(autoCompleteDecision(decisionInput({ attention: { ...attention, seen: { sequence: 2, at: AT } } }))).toBe("complete");
  });

  it.each(["approval", "questions", "plan"] as const)("blocks a live %s", (kind) => {
    expect(autoCompleteDecision(decisionInput({ attention: { ...quietAttention(), waiting: { kind, since: AT } } }))).toBe("needs-user");
  });

  it.each([
    [{ auto_complete_on_merge: false }, "disabled"],
    [{ auto_complete_on_merge: true, completeOnPrMerge: false }, "complete"],
    [{ auto_complete_on_merge: null, completeOnPrMerge: false }, "disabled"],
    [{ auto_complete_paused_at: AT }, "paused"],
    [{ user_completed_at: AT }, "inactive"],
    [{ deleted_at: AT }, "inactive"],
    [{ attention: null }, "needs-user"],
    [{ attention: { ...quietAttention(), hasUnfinishedDelegatedTasks: true } }, "needs-user"],
  ] satisfies Array<[Partial<AutoCompleteDecisionInput>, string]>)("honours lifecycle and preference gates: %j", (input, expected) => {
    expect(autoCompleteDecision(decisionInput(input))).toBe(expected);
  });
});

const services: ThreadAutoCompleteService[] = [];
afterEach(() => {
  for (const service of services.splice(0)) service.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function fixture() {
  const runtime = createThreadPersistenceTestRuntime();
  const threads = new ThreadRepo(runtime.reader, runtime.writer);
  const workspace = await new WorkspaceRepo(runtime.reader, runtime.writer).create("Auto-complete", "/fixture");
  const thread = await threads.create(workspace.id, "Feature", "direct", "main");
  const attention = new ThreadAttentionService(runtime.reader, runtime.writer, [],
    { coordinatorsWithUnfinishedTasks: () => new Set() }, () => {});
  const funnel = new PullRequestLinkFunnel(runtime.writer, () => {}, () => {});
  const reservations = new ThreadControlMutationReservationService();
  let settings = getDefaultSettings();
  const listeners = new Set<(next: Settings) => void>();
  const settingsSource = {
    get: () => settings,
    on: (_event: "change", listener: (next: Settings) => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
  const running: string[] = [];
  const completion = new ThreadCompletionService(threads, { runtimeAccess: () => ({ activeThreadIds: () => running }) },
    { listPendingApprovals: () => [] }, { teardownThread: async () => {} }, reservations, settingsSource,
    () => new Date(AT), new CleanupJobRepo(runtime.reader, runtime.writer));
  const service = new ThreadAutoCompleteService(threads, attention, completion, funnel, settingsSource);
  services.push(service);
  const complete = vi.spyOn(completion, "complete");
  const setGlobal = (enabled: boolean) => {
    settings = { ...settings, thread: { ...settings.thread,
      completion: { ...settings.thread.completion, completeOnPrMerge: enabled } } };
    for (const listener of listeners) listener(settings);
  };
  const current = () => {
    const value = threads.findById(thread.id);
    if (!value) throw new Error("Thread missing");
    return value;
  };
  const expectCompleted = async () => {
    await vi.waitFor(() => expect(current().user_completed_at).toBe(AT));
  };
  return { ...runtime, threads, thread, attention, funnel, reservations, completion, service,
    complete, setGlobal, current, expectCompleted, running };
}

describe("ThreadAutoCompleteService", () => {
  it("completes when the user sees a qualifying result", async () => {
    const f = await fixture();
    f.database.query("INSERT INTO messages (id, thread_id, role, content, sequence, outcome) VALUES ('answer', ?, 'assistant', 'Answer', 2, 'completed')").run(f.thread.id);
    await f.threads.recordTurnOutcome(f.thread.id, "completed", AT);
    await f.funnel.observe(f.thread.id, [MERGED]);
    f.service.start();
    expect(f.current().user_completed_at).toBeNull();
    await f.attention.acknowledgeSeen(f.thread.id, 2);
    await f.expectCompleted();
    expect(f.complete.mock.calls).toEqual([[f.thread.id, 0, "auto"]]);
  });

  it("coalesces concurrent hints into one completion with no hold", async () => {
    const f = await fixture();
    await f.funnel.observe(f.thread.id, [MERGED]);
    await Promise.all([f.service.evaluate(f.thread.id), f.service.evaluate(f.thread.id)]);
    expect(f.current().user_completed_at).toBe(AT);
    expect(f.complete.mock.calls).toEqual([[f.thread.id, 0, "auto"]]);
  });

  it("marks its lifecycle push as an automatic completion", async () => {
    vi.mocked(broadcast).mockClear();
    const f = await fixture();
    await f.funnel.observe(f.thread.id, [MERGED]);
    await f.service.evaluate(f.thread.id);
    const pushes = vi.mocked(broadcast).mock.calls.filter(([channel]) => channel === "thread.lifecycleChanged");
    expect(pushes).toEqual([["thread.lifecycleChanged", { thread: f.current(), completedBy: "auto" }]]);
  });

  it.each(["busy", "running"] as const)("waits for another hint after a %s refusal", async (refusal) => {
    const f = await fixture();
    await f.funnel.observe(f.thread.id, [MERGED]);
    const token = refusal === "busy" ? f.reservations.reserve(f.thread.id, "reopening") : null;
    if (refusal === "running") f.running.push(f.thread.id);
    await f.service.evaluate(f.thread.id);
    expect(f.current().user_completed_at).toBeNull();
    if (token) f.reservations.release(f.thread.id, token);
    f.running.length = 0;
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.complete.mock.calls).toEqual([[f.thread.id, 0, "auto"]]);
    vi.useRealTimers();
    await f.service.evaluate(f.thread.id);
    expect(f.current().user_completed_at).toBe(AT);
    expect(f.complete.mock.calls).toEqual([[f.thread.id, 0, "auto"], [f.thread.id, 0, "auto"]]);
  });

  it("keeps a reopened thread paused with its override intact until a new turn settles", async () => {
    const f = await fixture();
    await f.threads.updateSettings(f.thread.id, { auto_complete_on_merge: true });
    await f.funnel.observe(f.thread.id, [MERGED]);
    await f.service.evaluate(f.thread.id);
    await f.completion.reopen(f.thread.id);
    await f.service.evaluate(f.thread.id);
    expect(f.current()).toMatchObject({ user_completed_at: null, auto_complete_paused_at: AT, auto_complete_on_merge: true });
    f.service.start();
    await f.threads.recordTurnOutcome(f.thread.id, "cancelled", "2030-01-01T10:01:00.000Z");
    await f.expectCompleted();
    expect(f.current().auto_complete_paused_at).toBeNull();
  });

  it("pauses implicit reopen during canonical turn admission", async () => {
    const f = await fixture();
    await f.funnel.observe(f.thread.id, [MERGED]);
    await f.service.evaluate(f.thread.id);
    new CanonicalParentTurnWrite(f.database, () => {}).start({
      thread: { id: f.thread.id, workspaceId: f.thread.workspace_id, providerId: "claude", createdAt: AT },
      turnId: "new-turn", executionId: "00000000-0000-4000-8000-000000000001",
      permissionMode: "supervised", providerIdentities: [], reopenThread: true,
      userMessage: { kind: "create", content: "More work", sequence: 1 },
    });
    await f.service.evaluate(f.thread.id);
    expect(f.current().user_completed_at).toBeNull();
    expect(autoCompleteDecision({ ...f.current(), attention: f.attention.get(f.thread.id), completeOnPrMerge: true })).toBe("paused");
  });

  it("keeps the reopen pause for repeated snapshots and metadata, clearing it for new PR state without activity", async () => {
    const f = await fixture();
    await f.funnel.observe(f.thread.id, [MERGED]);
    await f.service.evaluate(f.thread.id);
    await f.completion.reopen(f.thread.id);
    const activity = f.current().last_activity_at;
    f.service.start();
    await f.funnel.observe(f.thread.id, [MERGED]);
    await f.funnel.observe(f.thread.id, [{ ...MERGED, title: "Renamed" }]);
    expect(f.current()).toMatchObject({ user_completed_at: null, auto_complete_paused_at: AT });
    await f.funnel.observe(f.thread.id, [createMockThreadPullRequest({ number: 43, state: "merged" })]);
    await f.expectCompleted();
    expect(f.current().last_activity_at).toBe(activity);
    expect(f.current().auto_complete_paused_at).toBeNull();
  });
});

type Trigger = "startup" | "pull-requests" | "attention" | "override" | "activity" | "settings";
const inputTriggers = {
  deleted_at: ["startup"],
  user_completed_at: ["startup"],
  auto_complete_on_merge: ["override"],
  auto_complete_paused_at: ["activity", "pull-requests", "override"],
  pull_requests: ["startup", "pull-requests"],
  attention: ["attention"],
  completeOnPrMerge: ["settings"],
} satisfies Record<keyof AutoCompleteDecisionInput, Trigger[]>;

async function prepareTrigger(f: Awaited<ReturnType<typeof fixture>>, trigger: Trigger): Promise<void> {
  if (trigger !== "pull-requests") await f.funnel.observe(f.thread.id, [MERGED]);
  if (trigger === "override" || trigger === "settings") f.setGlobal(false);
  if (trigger === "attention") {
    f.database.query("UPDATE threads SET last_turn_outcome = 'completed', last_turn_ended_at = ?, last_turn_sequence = 2 WHERE id = ?").run(AT, f.thread.id);
    f.database.query("INSERT INTO messages (id, thread_id, role, content, sequence, outcome) VALUES ('answer', ?, 'assistant', 'Answer', 2, 'completed')").run(f.thread.id);
  }
  if (trigger === "activity" || trigger === "override") await f.threads.reopen(f.thread.id, AT);
}

it.each([...new Set(Object.values(inputTriggers).flat())])("wires decision inputs through the real %s trigger", async (trigger) => {
  const f = await fixture();
  await prepareTrigger(f, trigger);
  f.service.start();
  if (trigger === "pull-requests") await f.funnel.observe(f.thread.id, [MERGED]);
  if (trigger === "attention") await f.attention.acknowledgeSeen(f.thread.id, 2);
  if (trigger === "override") await f.threads.updateSettings(f.thread.id, { auto_complete_on_merge: true });
  if (trigger === "activity") await f.threads.advanceActivity(f.thread.id, "2030-01-01T10:01:00.000Z");
  if (trigger === "settings") f.setGlobal(true);
  await f.expectCompleted();
  expect(f.complete.mock.calls).toEqual([[f.thread.id, 0, "auto"]]);
});
