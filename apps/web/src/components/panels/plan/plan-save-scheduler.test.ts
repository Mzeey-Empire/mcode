import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanSaveVersion, PlanVersion } from "@mcode/contracts";
import { RpcError, RpcTimeoutError } from "@/transport/ws-transport";
import { PlanSaveScheduler } from "./plan-save-scheduler";

const THREAD = "thread-plan";
const READY_ID = "00000000-0000-4000-8000-000000000002";
const MINTED_ID = "00000000-0000-4000-8000-0000000000a1";
const SECOND_MINTED_ID = "00000000-0000-4000-8000-0000000000a2";
const OTHER_DRAFT_ID = "00000000-0000-4000-8000-0000000000b1";
const AGENT_ID = "00000000-0000-4000-8000-000000000004";

function version(overrides: Partial<PlanVersion> = {}): PlanVersion {
  return {
    id: READY_ID,
    threadId: THREAD,
    messageId: "message-2",
    version: 2,
    title: "Plan",
    contentMd: "# Plan\n",
    status: "ready",
    author: "agent",
    providerId: "codex",
    captureSource: "fence",
    baseVersionId: null,
    revision: 0,
    createdAt: "2026-10-09T00:00:00.000Z",
    updatedAt: "2026-10-09T00:00:00.000Z",
    acceptedAt: null,
    acceptedMessageId: null,
    ...overrides,
  };
}

const ready = version();

function draft(id: string, revision: number, contentMd: string): PlanVersion {
  return version({ id, version: 3, status: "draft", author: "user", providerId: null, messageId: null,
    captureSource: "edit", baseVersionId: READY_ID, revision, contentMd });
}

function conflictError(latest: PlanVersion): RpcError {
  return new RpcError("Plan changed", "plan_conflict", { latestVersion: latest });
}

interface PendingSave {
  readonly payload: PlanSaveVersion;
  readonly resolve: (version: PlanVersion) => void;
  readonly reject: (error: unknown) => void;
}

function setup() {
  const saves: PendingSave[] = [];
  const versions: PlanVersion[] = [];
  const ids = [MINTED_ID, SECOND_MINTED_ID];
  const scheduler = new PlanSaveScheduler(THREAD, {
    save: (payload) => new Promise((resolve, reject) => saves.push({ payload, resolve, reject })),
    onVersion: (saved) => versions.push(saved),
    newId: () => ids.shift() ?? "unexpected-id",
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (handle) => clearTimeout(handle),
  });
  const payloads = () => saves.map((save) => save.payload);
  return { scheduler, saves, versions, payloads };
}

// Settles the promise callbacks the scheduler chained on a save.
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

describe("PlanSaveScheduler", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("forks a ready version once after the debounce for a single keystroke", async () => {
    const { scheduler, payloads } = setup();

    scheduler.edit("# Plan\nx", ready);
    await vi.advanceTimersByTimeAsync(499);
    expect(payloads()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);

    expect(payloads()).toEqual([
      { threadId: THREAD, versionId: MINTED_ID, baseVersionId: READY_ID, baseRevision: 0, contentMd: "# Plan\nx" },
    ]);
  });

  it("sends thirty quick keystrokes as one save of the final text", async () => {
    const { scheduler, payloads } = setup();

    let text = "# Plan\n";
    for (let key = 0; key < 30; key += 1) {
      text += "a";
      scheduler.edit(text, ready);
      await vi.advanceTimersByTimeAsync(100);
    }
    await vi.advanceTimersByTimeAsync(500);

    expect(payloads()).toEqual([
      { threadId: THREAD, versionId: MINTED_ID, baseVersionId: READY_ID, baseRevision: 0, contentMd: text },
    ]);
  });

  it("holds a second save until the first is acknowledged, then coalesces newer text into one save", async () => {
    const { scheduler, saves, payloads, versions } = setup();
    scheduler.edit("one", ready);
    await vi.advanceTimersByTimeAsync(500);

    scheduler.edit("one two", ready);
    await vi.advanceTimersByTimeAsync(500);
    scheduler.edit("one two three", ready);
    await vi.advanceTimersByTimeAsync(500);
    expect(payloads()).toHaveLength(1);

    saves[0].resolve(draft(MINTED_ID, 1, "one"));
    await settle();

    expect(versions).toEqual([draft(MINTED_ID, 1, "one")]);
    expect(payloads()).toEqual([
      { threadId: THREAD, versionId: MINTED_ID, baseVersionId: READY_ID, baseRevision: 0, contentMd: "one" },
      { threadId: THREAD, versionId: MINTED_ID, baseVersionId: READY_ID, baseRevision: 1, contentMd: "one two three" },
    ]);
  });

  it("resends the identical payload after a lost response, even when newer text exists", async () => {
    const { scheduler, saves } = setup();
    scheduler.edit("first", ready);
    await vi.advanceTimersByTimeAsync(500);
    scheduler.edit("first and more", ready);

    saves[0].reject(new RpcTimeoutError("plan.saveVersion"));
    await settle();
    await vi.advanceTimersByTimeAsync(1_000);
    saves[1].reject(new Error("WebSocket disconnected"));
    await settle();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(saves).toHaveLength(3);
    expect(saves[1].payload).toBe(saves[0].payload);
    expect(saves[2].payload).toBe(saves[0].payload);
    expect(saves[2].payload).toEqual(
      { threadId: THREAD, versionId: MINTED_ID, baseVersionId: READY_ID, baseRevision: 0, contentMd: "first" },
    );
  });

  it("retries a busy save later with the current text and the same base", async () => {
    const { scheduler, saves, payloads } = setup();
    scheduler.edit("first", ready);
    await vi.advanceTimersByTimeAsync(500);

    saves[0].reject(new RpcError("Busy", "plan_busy", { latestVersion: ready }));
    await settle();
    scheduler.edit("first edited", ready);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(payloads()).toEqual([
      { threadId: THREAD, versionId: MINTED_ID, baseVersionId: READY_ID, baseRevision: 0, contentMd: "first" },
      { threadId: THREAD, versionId: MINTED_ID, baseVersionId: READY_ID, baseRevision: 0, contentMd: "first edited" },
    ]);
  });

  it("holds the local text on conflict and stops saving", async () => {
    const { scheduler, saves, versions } = setup();
    const theirs = draft(OTHER_DRAFT_ID, 1, "theirs");
    scheduler.edit("mine", ready);
    await vi.advanceTimersByTimeAsync(500);

    saves[0].reject(conflictError(theirs));
    await settle();
    scheduler.edit("mine again", theirs);
    scheduler.flush();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(scheduler.getSnapshot()).toEqual({ kind: "conflict", text: "mine", latest: theirs, canKeep: true });
    expect(saves).toHaveLength(1);
    expect(versions).toEqual([theirs]);
  });

  it("Keep my text adopts a conflicting draft's id and revision and saves the held text", async () => {
    const { scheduler, saves, payloads } = setup();
    scheduler.edit("mine", ready);
    await vi.advanceTimersByTimeAsync(500);
    saves[0].reject(conflictError(draft(OTHER_DRAFT_ID, 1, "theirs")));
    await settle();

    scheduler.keepMine();

    expect(payloads()[1]).toEqual(
      { threadId: THREAD, versionId: OTHER_DRAFT_ID, baseVersionId: READY_ID, baseRevision: 1, contentMd: "mine" },
    );
  });

  it("Keep my text forks a conflicting ready version under a new id", async () => {
    const { scheduler, saves, payloads } = setup();
    const capture = version({ id: AGENT_ID, version: 4, revision: 0, contentMd: "# Agent\n" });
    scheduler.edit("mine", ready);
    await vi.advanceTimersByTimeAsync(500);
    saves[0].reject(conflictError(capture));
    await settle();

    scheduler.keepMine();

    expect(payloads()[1]).toEqual(
      { threadId: THREAD, versionId: SECOND_MINTED_ID, baseVersionId: AGENT_ID, baseRevision: 0, contentMd: "mine" },
    );
  });

  it("offers only Use saved version when the latest is accepted, keeping the text until then", async () => {
    const { scheduler, saves } = setup();
    const accepted = version({ status: "accepted", acceptedAt: "2026-10-10T00:00:00.000Z" });
    scheduler.edit("mine", ready);
    await vi.advanceTimersByTimeAsync(500);
    saves[0].reject(new RpcError("Read only", "plan_read_only", { latestVersion: accepted }));
    await settle();

    scheduler.keepMine();

    expect(scheduler.getSnapshot()).toEqual({ kind: "conflict", text: "mine", latest: accepted, canKeep: false });
    expect(saves).toHaveLength(1);
  });

  it("Use saved version returns to idle and the next edit adopts the saved draft", async () => {
    const { scheduler, saves, payloads } = setup();
    const theirs = draft(OTHER_DRAFT_ID, 2, "theirs");
    scheduler.edit("mine", ready);
    await vi.advanceTimersByTimeAsync(500);
    saves[0].reject(conflictError(theirs));
    await settle();

    scheduler.useSaved();
    expect(scheduler.getSnapshot()).toEqual({ kind: "idle" });
    scheduler.edit("theirs plus mine", theirs);
    await vi.advanceTimersByTimeAsync(500);

    expect(payloads()[1]).toEqual(
      { threadId: THREAD, versionId: OTHER_DRAFT_ID, baseVersionId: READY_ID, baseRevision: 2, contentMd: "theirs plus mine" },
    );
  });

  it("ends the session on a new agent version only once its text is acknowledged", async () => {
    const { scheduler, saves } = setup();
    const capture = version({ id: AGENT_ID, version: 4 });
    scheduler.edit("mine", ready);
    await vi.advanceTimersByTimeAsync(500);

    scheduler.reconcile(capture);
    expect(scheduler.getSnapshot()).toMatchObject({ kind: "editing", text: "mine" });

    saves[0].resolve(draft(MINTED_ID, 1, "mine"));
    await settle();
    scheduler.reconcile(draft(MINTED_ID, 2, "another window"));
    expect(scheduler.getSnapshot()).toMatchObject({ kind: "editing", text: "mine" });

    scheduler.reconcile(capture);
    expect(scheduler.getSnapshot()).toEqual({ kind: "idle" });
  });

  it("flush sends pending text immediately", () => {
    const { scheduler, payloads } = setup();

    scheduler.edit("now", ready);
    scheduler.flush();

    expect(payloads()).toEqual([
      { threadId: THREAD, versionId: MINTED_ID, baseVersionId: READY_ID, baseRevision: 0, contentMd: "now" },
    ]);
  });
});
