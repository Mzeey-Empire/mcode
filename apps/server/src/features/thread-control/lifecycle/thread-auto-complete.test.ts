import "reflect-metadata";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockThread, createMockThreadPullRequest } from "@mcode/contracts/testing";
import { getDefaultSettings, type Settings } from "@mcode/contracts/models/settings";
import type { ThreadAttention } from "@mcode/contracts/models/thread-attention";
import type { ThreadPullRequest } from "@mcode/contracts/models/thread-pull-request";
import { ThreadRepo } from "../persistence/thread-repo.js";
import { ThreadAttentionService } from "../attention/thread-attention-service.js";
import { ThreadControlMutationReservationService } from "../authority/thread-control-mutation-reservation-service.js";
import { CleanupJobRepo } from "../cleanup/persistence/cleanup-job-repo.js";
import { createThreadPersistenceTestRuntime } from "../testing/thread-persistence-test-runtime.js";
import { WorkspaceRepo } from "../../projects/persistence/workspace-repo.js";
import { PullRequestLinkFunnel } from "../../pull-requests/links/pull-request-link-funnel.js";
import { CanonicalParentTurnWrite } from "../../agents/canonical/canonical-parent-turn-write.js";
import { ThreadCompletionService } from "./thread-completion-service.js";
import { autoCompleteState, ThreadAutoCompleteService, type AutoCompleteStateInput } from "./thread-auto-complete.js";
import { broadcast } from "../../../application/transport/push.js";

vi.mock("../../../application/transport/push.js", () => ({ broadcast: vi.fn() }));

const AT = "2030-01-01T10:00:00.000Z";
const MERGED = createMockThreadPullRequest({ state: "merged" });

function quietAttention(): ThreadAttention {
  return { threadId: "thread", waiting: null, lastTurn: null,
    seen: { sequence: null, at: null }, hasUnfinishedDelegatedTasks: false };
}

function decisionInput(overrides: Partial<AutoCompleteStateInput> = {}): AutoCompleteStateInput {
  return { ...createMockThread({ pull_requests: [MERGED] }), attention: quietAttention(), completeOnPrMerge: true, ...overrides };
}

describe("autoCompleteState", () => {
  it.each([
    [[], "waiting-for-merge"],
    [[MERGED, createMockThreadPullRequest({ number: 43, state: "merged" })], "ready"],
    [[MERGED, createMockThreadPullRequest({ number: 43, state: "closed" })], "waiting-for-merge"],
    [[MERGED, createMockThreadPullRequest({ number: 43, state: "open" })], "waiting-for-merge"],
    [[MERGED, createMockThreadPullRequest({ number: 43, state: "draft" })], "waiting-for-merge"],
    [[MERGED, createMockThreadPullRequest({ number: 43, state: "unresolved" })], "waiting-for-merge"],
  ] satisfies Array<[AutoCompleteStateInput["pull_requests"], string]>)("requires every PR to be merged: %j", (pull_requests, expected) => {
    expect(autoCompleteState(decisionInput({ pull_requests }))).toBe(expected);
  });

  it.each(["completed", "errored", "interrupted"] as const)("waits for an unseen %s result, then allows its seen result", (outcome) => {
    const attention: ThreadAttention = { ...quietAttention(), lastTurn: { outcome, endedAt: AT, sequence: 2, changedFileCount: null } };
    expect(autoCompleteState(decisionInput({ attention }))).toBe("waiting-for-user");
    expect(autoCompleteState(decisionInput({ attention: { ...attention, seen: { sequence: 2, at: AT } } }))).toBe("ready");
  });

  it.each(["approval", "questions", "plan"] as const)("blocks a live %s", (kind) => {
    expect(autoCompleteState(decisionInput({ attention: { ...quietAttention(), waiting: { kind, since: AT } } }))).toBe("waiting-for-user");
  });

  it.each([
    [{ auto_complete_on_merge: false }, "off"],
    [{ auto_complete_on_merge: true, completeOnPrMerge: false }, "ready"],
    [{ auto_complete_on_merge: null, completeOnPrMerge: false }, "off"],
    [{ auto_complete_paused_at: AT }, "held"],
    [{ user_completed_at: AT }, "inactive"],
    [{ deleted_at: AT }, "inactive"],
    [{ attention: null }, "waiting-for-user"],
    [{ attention: { ...quietAttention(), hasUnfinishedDelegatedTasks: true } }, "waiting-for-user"],
  ] satisfies Array<[Partial<AutoCompleteStateInput>, string]>)("honours lifecycle and preference gates: %j", (input, expected) => {
    expect(autoCompleteState(decisionInput(input))).toBe(expected);
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

  it("keeps a reopened thread held with its override intact after a new turn settles", async () => {
    const f = await fixture();
    await f.threads.updateSettings(f.thread.id, { auto_complete_on_merge: true });
    await f.funnel.observe(f.thread.id, [MERGED]);
    await f.service.evaluate(f.thread.id);
    await f.completion.reopen(f.thread.id);
    f.service.start();
    await f.threads.recordTurnOutcome(f.thread.id, "cancelled", "2030-01-01T10:01:00.000Z");
    await f.service.evaluate(f.thread.id);
    expect(f.current()).toMatchObject({ user_completed_at: null, auto_complete_paused_at: AT, auto_complete_on_merge: true });
  });

  it("holds automatic completion after implicit reopen during canonical turn admission", async () => {
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
    expect(autoCompleteState({ ...f.current(), attention: f.attention.get(f.thread.id), completeOnPrMerge: true })).toBe("held");
  });

  const holdEvents: HoldEvent[] = [
    { event: "turn activity", released: false, apply: (f) => f.threads.advanceActivity(f.thread.id, "2030-01-01T10:01:00.000Z") },
    { event: "settled turn", released: false, apply: (f) => f.threads.recordTurnOutcome(f.thread.id, "cancelled", "2030-01-01T10:01:00.000Z") },
    { event: "setting enabled", released: false, apply: (f) => f.threads.updateSettings(f.thread.id, { auto_complete_on_merge: true }) },
    { event: "setting disabled", released: false, apply: (f) => f.threads.updateSettings(f.thread.id, { auto_complete_on_merge: false }) },
    { event: "repeated snapshot", released: false, apply: (f) => f.funnel.observe(f.thread.id, [MERGED]) },
    { event: "title change", released: false, apply: (f) => f.funnel.observe(f.thread.id, [{ ...MERGED, title: "Renamed" }]) },
    {
      event: "null hold snapshot with a title-only change",
      released: false,
      apply: async (f) => {
        f.database.query("UPDATE threads SET auto_complete_hold_pull_requests = NULL WHERE id = ?").run(f.thread.id);
        await f.funnel.observe(f.thread.id, [{ ...MERGED, title: "Renamed" }]);
      },
    },
    {
      event: "null hold snapshot with a new merged PR",
      released: true,
      apply: async (f) => {
        f.database.query("UPDATE threads SET auto_complete_hold_pull_requests = NULL WHERE id = ?").run(f.thread.id);
        await f.funnel.observe(f.thread.id, [createMockThreadPullRequest({ number: 43, state: "merged" })]);
      },
    },
    {
      event: "null hold snapshot with a branch round trip",
      released: false,
      apply: async (f) => {
        f.database.query("UPDATE threads SET auto_complete_hold_pull_requests = NULL WHERE id = ?").run(f.thread.id);
        await f.funnel.forgetBranch(f.thread.id);
        await f.funnel.observe(f.thread.id, [MERGED]);
      },
    },
    {
      event: "unreadable hold snapshot with a branch round trip",
      released: false,
      apply: async (f) => {
        f.database.query("UPDATE threads SET auto_complete_hold_pull_requests = '{not json' WHERE id = ?").run(f.thread.id);
        await f.funnel.forgetBranch(f.thread.id);
        await f.funnel.observe(f.thread.id, [MERGED]);
      },
    },
    {
      event: "unreadable hold snapshot with a title-only change",
      released: false,
      apply: async (f) => {
        f.database.query("UPDATE threads SET auto_complete_hold_pull_requests = '{not json' WHERE id = ?").run(f.thread.id);
        await f.funnel.observe(f.thread.id, [{ ...MERGED, title: "Renamed" }]);
      },
    },
    {
      event: "stale hold snapshot after an older build reopens with a different merged PR",
      released: false,
      apply: async (f) => {
        f.database.query("UPDATE threads SET auto_complete_paused_at = NULL WHERE id = ?").run(f.thread.id);
        await f.funnel.observe(f.thread.id, [createMockThreadPullRequest({ number: 43, state: "merged" })]);
        f.database.query("UPDATE threads SET auto_complete_paused_at = ? WHERE id = ?")
          .run("2030-01-01T10:02:00.000Z", f.thread.id);
        await f.funnel.observe(f.thread.id, [createMockThreadPullRequest({ number: 43, state: "merged", title: "Renamed" })]);
      },
    },
    { event: "URL-only change", released: false, apply: (f) => f.funnel.observe(f.thread.id, [{ ...MERGED, url: "https://github.com/example/repo/pull/42" }]) },
    {
      event: "branch round trip: links forgotten, then the same merged PR re-linked",
      released: false,
      apply: async (f) => {
        await f.funnel.forgetBranch(f.thread.id);
        await f.funnel.observe(f.thread.id, [MERGED]);
      },
    },
    {
      event: "links forgotten, then a different merged PR linked",
      released: true,
      apply: async (f) => {
        await f.funnel.forgetBranch(f.thread.id);
        await f.funnel.observe(f.thread.id, [createMockThreadPullRequest({ number: 43, state: "merged" })]);
      },
    },
    { event: "links forgotten", released: false, apply: (f) => f.funnel.forgetBranch(f.thread.id) },
    { event: "new merged PR", released: true, apply: (f) => f.funnel.observe(f.thread.id, [createMockThreadPullRequest({ number: 43, state: "merged" })]) },
    {
      event: "linked PR state change",
      released: true,
      linkWhileClosed: [createMockThreadPullRequest({ number: 44, state: "open" })],
      apply: (f) => f.funnel.observe(f.thread.id, [createMockThreadPullRequest({ number: 44, state: "merged" })]),
    },
  ];

  it.each(holdEvents)("pins the hold transition for $event", async ({ released, linkWhileClosed, apply }) => {
    const f = await fixture();
    await f.funnel.observe(f.thread.id, [MERGED]);
    await f.service.evaluate(f.thread.id);
    if (linkWhileClosed) await f.funnel.observe(f.thread.id, linkWhileClosed);
    await f.completion.reopen(f.thread.id);
    await apply(f);
    f.service.start();
    if (released) {
      await f.expectCompleted();
      expect(f.current().auto_complete_paused_at).toBeNull();
      expect(f.database.query("SELECT auto_complete_hold_pull_requests FROM threads WHERE id = ?").get(f.thread.id))
        .toEqual({ auto_complete_hold_pull_requests: null });
    } else {
      await f.service.evaluate(f.thread.id);
      expect(f.current().auto_complete_paused_at).not.toBeNull();
      expect(f.current().user_completed_at).toBeNull();
    }
  });
});

type HoldFixture = Awaited<ReturnType<typeof fixture>>;
interface HoldEvent {
  event: string;
  released: boolean;
  linkWhileClosed?: ThreadPullRequest[];
  apply: (f: HoldFixture) => unknown;
}
type Trigger = "startup" | "pull-requests" | "attention" | "override" | "settings";
const inputTriggers = {
  deleted_at: ["startup"],
  user_completed_at: ["startup"],
  auto_complete_on_merge: ["override"],
  auto_complete_paused_at: ["pull-requests"],
  pull_requests: ["startup", "pull-requests"],
  attention: ["attention"],
  completeOnPrMerge: ["settings"],
} satisfies Record<keyof AutoCompleteStateInput, Trigger[]>;

async function prepareTrigger(f: HoldFixture, trigger: Trigger): Promise<void> {
  if (trigger !== "pull-requests") await f.funnel.observe(f.thread.id, [MERGED]);
  if (trigger === "override" || trigger === "settings") f.setGlobal(false);
  if (trigger === "attention") {
    f.database.query("UPDATE threads SET last_turn_outcome = 'completed', last_turn_ended_at = ?, last_turn_sequence = 2 WHERE id = ?").run(AT, f.thread.id);
    f.database.query("INSERT INTO messages (id, thread_id, role, content, sequence, outcome) VALUES ('answer', ?, 'assistant', 'Answer', 2, 'completed')").run(f.thread.id);
  }
  if (trigger === "pull-requests") await f.threads.reopen(f.thread.id, AT);
}

it.each([...new Set(Object.values(inputTriggers).flat())])("wires decision inputs through the real %s trigger", async (trigger) => {
  const f = await fixture();
  await prepareTrigger(f, trigger);
  f.service.start();
  if (trigger === "pull-requests") await f.funnel.observe(f.thread.id, [MERGED]);
  if (trigger === "attention") await f.attention.acknowledgeSeen(f.thread.id, 2);
  if (trigger === "override") await f.threads.updateSettings(f.thread.id, { auto_complete_on_merge: true });
  if (trigger === "settings") f.setGlobal(true);
  await f.expectCompleted();
  expect(f.complete.mock.calls).toEqual([[f.thread.id, 0, "auto"]]);
});
