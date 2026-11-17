import { afterEach, describe, expect, it, vi } from "vitest";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";
import { Database } from "bun:sqlite";
import type { AgentEvent } from "@mcode/contracts/events/agent-event";
import { MessageSchema } from "@mcode/contracts/models/message";
import { isThreadSaveBlocked } from "../../canonical/accepted-save-failure.js";
import type { WriterFailure } from "../../canonical/canonical-agent-writer-protocol.js";
import { listTurnFileEvidence } from "../../turns/persistence/turn-file-evidence-store.js";
import { WriterFaultPlan, endingWrite, originalWrite, terminalWrite, threadWrite, writerFailures } from "./faulty-writer-worker.js";
import { InvariantViolation, expectInvariant, knownStall } from "./known-stall.js";
import { openWorkerServiceFixture, openWorkerTurnFixture } from "./worker-turn-fixture.js";

vi.mock("../../../../application/transport/push.js", () => ({ broadcast: vi.fn(), subscribedThreadIds: () => new Set<string>() }));

type Fixture = Awaited<ReturnType<typeof openWorkerServiceFixture>>;
const K = 5;
let fixture: Fixture | undefined;
let clearFaults: (() => void)[] = [];

type Settlement<T> = { status: "pending" } | { status: "fulfilled"; value: T } | { status: "rejected"; error: unknown };
type Tracked<T> = { result: Settlement<T> };

/** Records the outcome from the moment the promise exists, so a rejection before the test awaits it is not unhandled. */
function track<T>(promise: Promise<T>): Tracked<T> {
  const outcome: Tracked<T> = { result: { status: "pending" } };
  void promise.then(
    (value) => { outcome.result = { status: "fulfilled", value }; },
    (error: unknown) => { outcome.result = { status: "rejected", error }; },
  );
  return outcome;
}

function settleWithinTicks<T>(active: Fixture, promise: Promise<T>, maxSteps = K): Promise<Settlement<T>> {
  return settleTrackedWithinTicks(active, track(promise), maxSteps);
}

async function settleTrackedWithinTicks<T>(active: Fixture, outcome: Tracked<T>, maxSteps = K): Promise<Settlement<T>> {
  // The next send waits for the previous turn's file-evidence collection, which runs a real git process.
  // Each step also gives real time so a healthy send does not look stuck and a fixed known stall does not stay marked.
  for (let step = 0; step < maxSteps && outcome.result.status === "pending"; step += 1) {
    await vi.advanceTimersByTimeAsync(30_001);
    await active.writer.barrier();
    await NodeTimersPromises.setImmediate();
    await active.writer.barrier();
    await vi.waitFor(() => {
      if (outcome.result.status === "pending") throw new Error("pending");
    }, { timeout: 1_000, interval: 10 }).catch(() => undefined);
  }
  return outcome.result;
}

async function retryTicks(active: Fixture, count = K): Promise<void> {
  for (let tick = 0; tick < count; tick += 1) {
    await vi.advanceTimersByTimeAsync(30_001);
    await active.writer.barrier();
    // Worker messages run on the real event loop even when retry timers use fake time.
    await NodeTimersPromises.setImmediate();
    await active.writer.barrier();
  }
}

async function start() {
  const plan = new WriterFaultPlan();
  const active = await openWorkerServiceFixture("codex", undefined, plan.createWorker);
  fixture = active;
  await send(active);
  await vi.waitFor(() => expect(active.sent).toHaveLength(1));
  const turn = active.sent[0];
  if (!turn) throw new Error("Provider dispatch did not provide a turn");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const event = (input: AgentEvent): AgentEvent => ({ ...input, threadId: active.thread.id, turnExecutionId: turn.turnExecutionId });
  return { active, plan, turn, event };
}

function send(active: Fixture) {
  return active.service.sendMessage({ threadId: active.thread.id, content: "Continue", provider: "codex", model: "gpt-5", permissionMode: "default" });
}

function deliverTurnComplete(active: Fixture, event: (input: AgentEvent) => AgentEvent) {
  return active.deliver(event({ type: "turnComplete", threadId: active.thread.id, reason: "end_turn", costUsd: null, tokensIn: 0, tokensOut: 0, providerId: "codex" }));
}

function deliverEnded(active: Fixture, event: (input: AgentEvent) => AgentEvent) {
  return active.deliver(event({ type: "ended", threadId: active.thread.id }));
}

async function finish(active: Fixture, event: (input: AgentEvent) => AgentEvent, unsaved = false) {
  await deliverTurnComplete(active, event);
  if (!unsaved) {
    await retryTicks(active);
    await waitForSavedWithinBound(active, "finish save");
  }
  await deliverEnded(active, event);
}

/** A bounded wait that never settled is a broken harness, not a reproduced stall. */
function settled<T>(operation: string, result: Settlement<T>): Exclude<Settlement<T>, { status: "pending" }> {
  if (result.status === "pending") throw new Error(`harness: ${operation} did not settle within the bound`);
  return result;
}

/** A save that never settles fails here by name instead of as the 30 s test timeout. */
async function waitForSavedWithinBound(active: Fixture, operation: string): Promise<void> {
  const progress = active.workers.progress;
  if (!progress) return;
  const saved = settled(operation, await settleWithinTicks(active, progress.waitForSaved(active.thread.id)));
  if (saved.status === "rejected") throw saved.error;
}

function assistantReplies(active: Fixture): string[] {
  return active.messages.listByThread(active.thread.id, 100).messages
    .filter((message) => message.role === "assistant").map((message) => message.content);
}

function refuse(plan: WriterFaultPlan, ...args: Parameters<WriterFaultPlan["refuse"]>) {
  const fault = plan.refuse(...args);
  clearFaults.push(fault.clear);
  return fault;
}

/** The ending's own direct write is armed before the finish, because the exit starts as soon as the finish is refused. */
async function refusedFinish(failure: WriterFailure = writerFailures.identity, endingFailure?: { failure: WriterFailure; times: number | "always" }) {
  const context = await start();
  const { active, plan, turn, event } = context;
  await active.emit(event({ type: "textDelta", threadId: active.thread.id, delta: "A deterministic reply", isFinalResponse: true }));
  const fault = refuse(plan, terminalWrite(active.thread.id, turn.turnId), failure, { times: "always", pinOperation: true });
  const ending = endingFailure ? refuse(plan, endingWrite(active.thread.id), endingFailure.failure, { times: endingFailure.times }) : undefined;
  await finish(active, event, true);
  await fault.reached;
  return { ...context, fault, ending };
}

/** Timeline warnings saved in the canonical history, which is what the client renders. */
function unsavedOutputNotices(active: Fixture): string[] {
  const recovery = active.canonical.recoverThread(active.thread.id,
    { conversationRevision: Number.MAX_SAFE_INTEGER, rosterRevision: Number.MAX_SAFE_INTEGER });
  if (recovery.mode !== "snapshot") throw new Error("harness: thread recovery returned no snapshot");
  return Object.values(recovery.snapshot.state.items).flatMap((item) => {
    if (item.payload.projection !== "message") return [];
    const message = MessageSchema().safeParse(item.payload.message);
    return message.success && message.data.role === "system" && message.data.systemNotice?.kind === "warning"
      && message.data.systemNotice.presentation === "timeline" ? [message.data.content] : [];
  });
}

function canonicalEventCount(active: Fixture, type: string): number {
  return active.db.query<{ count: number }, [string, string]>(
    "SELECT count(*) AS count FROM canonical_agent_events WHERE thread_id = ? AND json_extract(envelope_json, '$.payload.type') = ?")
    .get(active.thread.id, type)?.count ?? 0;
}

async function expectSavingExit(active: Fixture, executionId: string, fault: { readonly hits: number }) {
  expect(active.canonical.loadTurnByExecution(executionId)).toMatchObject({ status: "Interrupted", ending: { outcome: "interrupted", cause: "saving_stopped" } });
  expect(canonicalEventCount(active, "turn.interrupted")).toBe(1);
  expect(unsavedOutputNotices(active)).toEqual([expect.stringMatching(/wasn't saved/)]);
  expect(active.provider.stopSession).toHaveBeenCalled();
  const hits = fault.hits;
  await retryTicks(active);
  // A dropped batch is never written again, so the fault stops being reached.
  expect(fault.hits).toBe(hits);
  await untilRuntimeReleased(active);
  const next = await settleWithinTicks(active, send(active));
  expect(next).toMatchObject({ status: "fulfilled" });
}

/**
 * The ending is visible in storage before the worker release finishes, and a send in that gap is refused as busy.
 * The wait is bounded, so a release that never finishes still fails the test.
 */
async function untilRuntimeReleased(active: Fixture): Promise<void> {
  await vi.waitFor(() => expect(active.service.runtimeAccess().activeTurnThreadIds()).toEqual([]), { timeout: 10_000, interval: 10 });
}

type OwnedExecution = NonNullable<ReturnType<Fixture["workers"]["owner"]["current"]>>["execution"];

/** The running turn's routing, kept so a test can deliver for it after the exit released it. */
function ownedExecution(active: Fixture): OwnedExecution {
  const owned = active.workers.owner.current(active.thread.id);
  if (!owned) throw new Error("harness: no running execution owns the thread");
  return owned.execution;
}

/** Bypasses the fixture's `deliver`, which drops fenced executions and so cannot show what the server does. */
function deliverLate(active: Fixture, execution: OwnedExecution, event: AgentEvent, sequence: number): Promise<unknown> {
  const itemId = `late:${execution.executionId}:item:${sequence}`;
  const eventId = `late:${execution.executionId}:event:${sequence}`;
  const now = new Date().toISOString();
  return active.host.events.submit({
    ...execution, deliveryAttempt: 1, batchId: eventId, phase: "running",
    events: [{
      eventId, sourceProviderId: active.provider.id, sourceIdentities: [], sourceSequence: 1_000 + sequence,
      providerTimestamp: now, routing: { ...execution, itemId },
      payload: { type: "item.recorded", item: {
        id: itemId, threadId: active.thread.id, turnId: execution.turnId, kind: "system",
        providerIdentities: [], createdAt: now, updatedAt: now,
        payload: { projection: "providerRuntimeEvent", runtimeEvent: { event } },
      } },
    }],
  });
}

/** A Stop sent before the scheduler gives up on the refused save takes the ordinary path, not the exit's. */
async function untilExitStarts(active: Fixture, execution: OwnedExecution): Promise<void> {
  const progress = active.workers.progress;
  if (!progress) throw new Error("harness: worker fixture has no accepted progress owner");
  for (let tick = 0; tick < K && !progress.endingUnsavedTurn(execution); tick += 1) await retryTicks(active, 1);
  if (!progress.endingUnsavedTurn(execution)) throw new Error("harness: the saving exit did not start within the bound");
}

/** Makes reading one execution's turn from storage throw whenever its saved status matches, until restored. */
function failStatusReads(active: Fixture, executionId: string, failing: (status: string) => boolean): { restore: () => void } {
  const read = active.canonical.loadTurnByExecution.bind(active.canonical);
  const spy = vi.spyOn(active.canonical, "loadTurnByExecution").mockImplementation((id) => {
    const turn = read(id);
    if (id === executionId && turn && failing(turn.status)) throw new Error("turn status read failed");
    return turn;
  });
  return { restore: () => spy.mockRestore() };
}

/**
 * Holds the reply to the turn's ordinary worker release until the saving exit asks to release the same execution, so
 * both releases are under way at once. Without the hold this overlap happens only by timing, under CPU load.
 */
function overlapWorkerReleases(active: Fixture): { readonly overlapped: boolean } {
  const { scheduler, owner } = active.workers;
  let openHold!: () => void;
  const exitReleasing = new Promise<void>((resolve) => { openHold = resolve; });
  let held = false;
  let overlapped = false;
  const submit = scheduler.submit.bind(scheduler);
  const holdSpy = vi.spyOn(scheduler, "submit").mockImplementation((input) => {
    const admitted = submit(input);
    const ordinaryRelease = input.command.kind === "release" && !("recovery" in input.command && input.command.recovery);
    if (!ordinaryRelease || admitted.kind !== "admitted") return admitted;
    held = true;
    holdSpy.mockRestore();
    return { ...admitted, completion: exitReleasing.then(() => admitted.completion) };
  });
  const releaseRecovered = owner.releaseRecovered.bind(owner);
  const exitSpy = vi.spyOn(owner, "releaseRecovered").mockImplementation((...args) => {
    exitSpy.mockRestore();
    overlapped = held;
    const released = releaseRecovered(...args);
    openHold();
    return released;
  });
  clearFaults.push(() => { holdSpy.mockRestore(); exitSpy.mockRestore(); openHold(); });
  return { get overlapped() { return overlapped; } };
}

/**
 * Makes the saving exit's worker release start before the turn's ordinary release asks for the same execution.
 * `under-way` holds the exit's release reply until the ordinary release has asked; `finished` makes the ordinary
 * release ask only after the exit's release has freed the worker.
 */
function exitReleasesFirst(active: Fixture, mode: "under-way" | "finished"): { readonly ordered: boolean } {
  const { scheduler, owner } = active.workers;
  let exitStarted!: () => void;
  const exitStart = new Promise<void>((resolve) => { exitStarted = resolve; });
  let exitFinished!: () => void;
  const exitFinish = new Promise<void>((resolve) => { exitFinished = resolve; });
  let ordinaryAsked!: () => void;
  const ordinaryAsk = new Promise<void>((resolve) => { ordinaryAsked = resolve; });
  let ordered = false;
  const submit = scheduler.submit.bind(scheduler);
  const releaseRecovered = owner.releaseRecovered.bind(owner);
  const exitSpy = vi.spyOn(owner, "releaseRecovered").mockImplementation((...args) => {
    exitSpy.mockRestore();
    const holdSpy = vi.spyOn(scheduler, "submit").mockImplementation((input) => {
      holdSpy.mockRestore();
      const admitted = submit(input);
      if (mode !== "under-way" || admitted.kind !== "admitted") return admitted;
      return { ...admitted, completion: ordinaryAsk.then(() => admitted.completion) };
    });
    const released = releaseRecovered(...args);
    holdSpy.mockRestore();
    exitStarted();
    void released.then(exitFinished, exitFinished);
    return released;
  });
  const release = owner.release.bind(owner);
  const ordinarySpy = vi.spyOn(owner, "release").mockImplementation(async (execution) => {
    ordinarySpy.mockRestore();
    await (mode === "under-way" ? exitStart : exitFinish);
    ordered = true;
    const released = release(execution);
    ordinaryAsked();
    return released;
  });
  clearFaults.push(() => { exitSpy.mockRestore(); ordinarySpy.mockRestore(); exitStarted(); exitFinished(); ordinaryAsked(); });
  return { get ordered() { return ordered; } };
}

/** Holds a Stop while it waits for the agent's events to drain, as a slow agent does, until `open` runs. */
function holdStopDrain(active: Fixture): { readonly reached: boolean; open(): void } {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  let reached = false;
  const fence = active.provider.fenceCanonicalTurnEvents;
  const spy = vi.spyOn(active.provider, "fenceCanonicalTurnEvents").mockImplementation(async (routing, options) => {
    if (!options?.discardQueued) return fence(routing, options);
    spy.mockRestore();
    reached = true;
    await gate;
  });
  clearFaults.push(() => { spy.mockRestore(); open(); });
  return { get reached() { return reached; }, open: () => open() };
}

/** Holds the saving exit's worker release reply until Stop asks the worker to stop the same execution. */
function holdExitReleaseUntilStopCommand(active: Fixture): { readonly submitted: boolean } {
  const { scheduler, owner } = active.workers;
  let openHold!: () => void;
  const stopAsked = new Promise<void>((resolve) => { openHold = resolve; });
  let submitted = false;
  const submit = scheduler.submit.bind(scheduler);
  const holdSpy = vi.spyOn(scheduler, "submit").mockImplementation((input) => {
    const admitted = submit(input);
    const exitRelease = input.command.kind === "release" && "recovery" in input.command && input.command.recovery;
    if (!exitRelease || admitted.kind !== "admitted") return admitted;
    holdSpy.mockRestore();
    submitted = true;
    return { ...admitted, completion: stopAsked.then(() => admitted.completion) };
  });
  const stop = owner.stop.bind(owner);
  const stopSpy = vi.spyOn(owner, "stop").mockImplementation((...args) => {
    stopSpy.mockRestore();
    // Opened right after admission: the owner reads the release reply in microtasks, before the worker can answer Stop.
    try { return stop(...args); } finally { openHold(); }
  });
  clearFaults.push(() => { holdSpy.mockRestore(); stopSpy.mockRestore(); openHold(); });
  return { get submitted() { return submitted; } };
}

/**
 * The turn's file-change evidence as clients load it; it stays `tracking` until the turn's ending is saved. The
 * fixture's directory is not a Git repository and the turn changes no files, so saved evidence is `untracked`.
 */
function fileEvidenceState(active: Fixture, executionId: string): string | undefined {
  return listTurnFileEvidence(active.db, { threadId: active.thread.id, executionId })[0]?.evidence.state;
}

async function expectStoppedExit(active: Fixture, executionId: string) {
  expect(active.canonical.loadTurnByExecution(executionId)).toMatchObject({ status: "Cancelled", ending: { outcome: "cancelled", stop: { by: "user" } } });
  expect(unsavedOutputNotices(active)).toEqual([expect.stringMatching(/wasn't saved/)]);
  await untilRuntimeReleased(active);
  const next = await settleWithinTicks(active, send(active));
  expect(next).toMatchObject({ status: "fulfilled" });
}

afterEach(async () => {
  try {
    for (const clear of clearFaults) clear();
    if (fixture) {
      try {
        await retryTicks(fixture);
        await waitForSavedWithinBound(fixture, "teardown save");
      } finally {
        // A failed settle must still release the worker, database, environment overrides and temp directory.
        await fixture.close();
      }
    }
  } finally {
    // A failing close must not leave fake timers or mocks active for the next test.
    fixture = undefined;
    clearFaults = [];
    vi.useRealTimers();
    vi.restoreAllMocks();
  }
});

describe("thread resilience without model tokens", { timeout: 30_000 }, () => {
  it.each([
    { kib: 60, spooled: false },
    { kib: 200, spooled: true },
  ])("saves $kib KiB provider tool output without replacing content", async ({ kib, spooled }) => {
    const active = await openWorkerTurnFixture();
    fixture = active;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const output = "x".repeat(kib * 1024);
    await active.emit({ type: "toolUse", threadId: active.thread.id, toolCallId: "large-output",
      toolName: "command_execution", toolInput: { command: "generate output" } });
    await active.emit({ type: "toolResult", threadId: active.thread.id, toolCallId: "large-output",
      output, isError: false });
    await active.emit({ type: "textDelta", threadId: active.thread.id, delta: "Finished", isFinalResponse: true });
    await active.finish();
    const markers = active.db.query<{ envelope_json: string }, [string]>(
      "SELECT envelope_json FROM canonical_agent_events WHERE thread_id = ? AND envelope_json LIKE '%ingest.content-replaced%'")
      .all(active.thread.id);
    expect.soft(markers).toEqual([]);
    const saved = active.tools.listByMessage(active.assistant()!.id);
    expect.soft(saved.map((tool) => ({ id: tool.id, output: tool.output_summary }))).toEqual([
      { id: "large-output", output: "x".repeat(500) },
    ]);
    const artifactPath = saved[0]?.output_artifact_path ?? null;
    expect.soft(artifactPath !== null).toBe(spooled);
    if (artifactPath) expect.soft(NodeFS.readFileSync(artifactPath, "utf8") === output, "full output readable from its artifact").toBe(true);
    expect(active.canonical.loadTurnByExecution(active.turn.turnExecutionId)?.status).toBe("Completed");
  });

  it("S1 ends a refused terminal save and admits another send", async () => {
    const { active, turn, fault } = await refusedFinish();
    await retryTicks(active);
    expect(active.canonical.loadTurnByExecution(turn.turnExecutionId)?.status).toBe("Interrupted");
    // The reply was saved before the finish was refused, so ending the turn keeps it.
    expect(assistantReplies(active)).toEqual(["A deterministic reply"]);
    await expectSavingExit(active, turn.turnExecutionId, fault);
  });

  it("S1b drops the batches queued behind a refused mid-turn save", async () => {
    const { active, plan, turn, event } = await start();
    await active.emit(event({ type: "textDelta", threadId: active.thread.id, delta: "Saved before the refusal", isFinalResponse: false }));
    const fault = refuse(plan, threadWrite(active.thread.id), writerFailures.identity, { times: "always", pinOperation: true });
    await active.deliver(event({ type: "toolUse", threadId: active.thread.id, toolCallId: "refused-1", toolName: "Bash", toolInput: { command: "ls" } }));
    await active.deliver(event({ type: "toolUse", threadId: active.thread.id, toolCallId: "queued-1", toolName: "Bash", toolInput: { command: "pwd" } }));
    await active.deliver(event({ type: "toolResult", threadId: active.thread.id, toolCallId: "queued-1", output: "/work", isError: false }));
    await fault.reached;
    await retryTicks(active);
    const savedToolItems = active.db.query<{ count: number }, [string]>(
      "SELECT count(*) AS count FROM canonical_agent_events WHERE thread_id = ? AND (envelope_json LIKE '%refused-1%' OR envelope_json LIKE '%queued-1%')")
      .get(active.thread.id)?.count;
    expect(savedToolItems).toBe(0);
    await expectSavingExit(active, turn.turnExecutionId, fault);
  });

  it("S1c ends the turn when a mid-turn save hits a full disk", async () => {
    const { active, plan, turn, event } = await start();
    await active.emit(event({ type: "textDelta", threadId: active.thread.id, delta: "Saved before the disk filled", isFinalResponse: false }));
    const fault = refuse(plan, threadWrite(active.thread.id), writerFailures.full, { times: "always", pinOperation: true });
    // An agent that will not stop is evicted, as a user's Stop does, so the next send starts a fresh session.
    const discardSession = vi.fn(async (_sessionId: string) => undefined);
    Object.assign(active.provider, { discardSession });
    active.provider.stopSession.mockRejectedValueOnce(new Error("stop unavailable"));
    await active.deliver(event({ type: "toolUse", threadId: active.thread.id, toolCallId: "full-1", toolName: "Bash", toolInput: { command: "ls" } }));
    await fault.reached;
    await retryTicks(active);
    expect(discardSession).toHaveBeenCalledWith(`mcode-${active.thread.id}`);
    await expectSavingExit(active, turn.turnExecutionId, fault);
  });

  it("S1d keeps the thread closed until a failing ending write succeeds", async () => {
    const { active, turn, fault, ending } = await refusedFinish(writerFailures.identity, { failure: writerFailures.full, times: 1 });
    if (!ending) throw new Error("harness: ending fault was not armed");
    await ending.reached;
    // No fake time passes here, so the ending's retry has not run and its write is still failing.
    const blocked = track(send(active));
    await vi.waitFor(() => { if (blocked.result.status === "pending") throw new Error("pending"); }, { timeout: 5_000, interval: 10 });
    expect(blocked.result.status).toBe("rejected");
    if (blocked.result.status === "rejected") expect(isThreadSaveBlocked(blocked.result.error)).toBe(true);
    expect(active.canonical.loadTurnByExecution(turn.turnExecutionId)?.status).toBe("Running");
    await retryTicks(active);
    expect(ending.hits).toBe(1);
    await expectSavingExit(active, turn.turnExecutionId, fault);
  });

  it("S1e takes the exit on a real durable predecessor mismatch", async () => {
    const { active, turn, event } = await start();
    await active.emit(event({ type: "textDelta", threadId: active.thread.id, delta: "Saved before the mismatch", isFinalResponse: false }));
    // Another connection moves the thread's durable revision, so the next accepted save no longer follows the saved head.
    const outside = new Database(NodePath.join(active.directory, "app.sqlite"));
    try {
      outside.run("UPDATE canonical_agent_threads SET conversation_revision = conversation_revision + 1 WHERE id = ?", [active.thread.id]);
    } finally {
      outside.close();
    }
    await active.deliver(event({ type: "toolUse", threadId: active.thread.id, toolCallId: "mismatch-1", toolName: "Bash", toolInput: { command: "ls" } }));
    await retryTicks(active);
    await expectSavingExit(active, turn.turnExecutionId, { hits: 0 });
  });

  it("S1f releases a mid-turn exit's worker when the ended turn cannot be read back", async () => {
    const { active, plan, turn, event } = await start();
    await active.emit(event({ type: "textDelta", threadId: active.thread.id, delta: "Saved before the refusal", isFinalResponse: false }));
    const fault = refuse(plan, threadWrite(active.thread.id), writerFailures.identity, { times: "always", pinOperation: true });
    const reads = failStatusReads(active, turn.turnExecutionId, (status) => status === "Interrupted");
    await active.deliver(event({ type: "toolUse", threadId: active.thread.id, toolCallId: "refused-1", toolName: "Bash", toolInput: { command: "ls" } }));
    await fault.reached;
    await retryTicks(active);
    reads.restore();
    await expectSavingExit(active, turn.turnExecutionId, fault);
  });

  it("S1g releases a mid-turn exit's worker when reloading the thread after its ending fails", async () => {
    const { active, plan, turn, event } = await start();
    await active.emit(event({ type: "textDelta", threadId: active.thread.id, delta: "Saved before the refusal", isFinalResponse: false }));
    const fault = refuse(plan, threadWrite(active.thread.id), writerFailures.identity, { times: "always", pinOperation: true });
    const recover = active.canonical.recoverThread.bind(active.canonical);
    let reloadFailed = false;
    vi.spyOn(active.canonical, "recoverThread").mockImplementation((...args) => {
      if (!reloadFailed && active.canonical.loadTurnByExecution(turn.turnExecutionId)?.status === "Interrupted") {
        reloadFailed = true;
        throw new Error("thread reload failed");
      }
      return recover(...args);
    });
    await active.deliver(event({ type: "toolUse", threadId: active.thread.id, toolCallId: "refused-1", toolName: "Bash", toolInput: { command: "ls" } }));
    await fault.reached;
    await retryTicks(active);
    expect(reloadFailed).toBe(true);
    await expectSavingExit(active, turn.turnExecutionId, fault);
  });

  it("S2 answers Stop honestly while the ending cannot be saved, then saves the user's Stop", async () => {
    const { active, turn } = await refusedFinish(writerFailures.full, { failure: writerFailures.full, times: "always" });
    const stop = settled("Stop", await settleWithinTicks(active, active.requestStop()));
    if (stop.status === "rejected") throw stop.error;
    expect(stop.value.status).toBe("ending-not-saved");
    expect(active.canonical.loadTurnByExecution(turn.turnExecutionId)?.status).toBe("Running");
    expect(active.provider.stopSession).toHaveBeenCalled();
    const again = settled("repeated Stop", await settleWithinTicks(active, active.requestStop()));
    expect(again).toMatchObject({ status: "fulfilled", value: { status: "ending-not-saved" } });
    for (const clear of clearFaults) clear();
    await retryTicks(active);
    expect(active.canonical.loadTurnByExecution(turn.turnExecutionId)).toMatchObject({ status: "Cancelled", ending: { outcome: "cancelled", stop: { by: "user" } } });
    expect(unsavedOutputNotices(active)).toEqual([expect.stringMatching(/wasn't saved/)]);
    const next = await settleWithinTicks(active, send(active));
    expect(next).toMatchObject({ status: "fulfilled" });
    expect(active.canonical.loadTurnByExecution(turn.turnExecutionId)?.status).toBe("Cancelled");
  });

  it("S2 labels the runtime cancelled when a Stop is saved as a mid-turn exit's ending", async () => {
    const { active, plan, turn, event } = await start();
    const execution = ownedExecution(active);
    await active.emit(event({ type: "textDelta", threadId: active.thread.id, delta: "Saved before the disk filled", isFinalResponse: false }));
    const fault = refuse(plan, threadWrite(active.thread.id), writerFailures.full, { times: "always", pinOperation: true });
    refuse(plan, endingWrite(active.thread.id), writerFailures.full, { times: "always" });
    await active.deliver(event({ type: "toolUse", threadId: active.thread.id, toolCallId: "full-1", toolName: "Bash", toolInput: { command: "ls" } }));
    await fault.reached;
    await untilExitStarts(active, execution);
    const stop = settled("Stop", await settleWithinTicks(active, active.requestStop()));
    expect(stop).toMatchObject({ status: "fulfilled", value: { status: "ending-not-saved" } });
    for (const clear of clearFaults) clear();
    await retryTicks(active);
    expect(active.canonical.loadTurnByExecution(turn.turnExecutionId)).toMatchObject({ status: "Cancelled", ending: { outcome: "cancelled", stop: { by: "user" } } });
    await vi.waitFor(() => expect(active.service.runtimeAccess().runtimeSnapshots()).toContainEqual(expect.objectContaining({
      threadId: active.thread.id, turnExecutionId: turn.turnExecutionId, phase: "cancelled",
    })));
  });

  it("S2 stops the agent and answers Stop as not saved while the running turn cannot be read", async () => {
    const { active, plan, turn, event } = await start();
    const execution = ownedExecution(active);
    await active.emit(event({ type: "textDelta", threadId: active.thread.id, delta: "Saved before the disk filled", isFinalResponse: false }));
    const fault = refuse(plan, threadWrite(active.thread.id), writerFailures.full, { times: "always", pinOperation: true });
    const reads = failStatusReads(active, turn.turnExecutionId, (status) => status === "Running");
    await active.deliver(event({ type: "toolUse", threadId: active.thread.id, toolCallId: "full-1", toolName: "Bash", toolInput: { command: "ls" } }));
    await fault.reached;
    await untilExitStarts(active, execution);
    const stop = settled("Stop", await settleWithinTicks(active, active.requestStop()));
    expect(stop).toMatchObject({ status: "fulfilled", value: { status: "ending-not-saved" } });
    expect(active.provider.stopSession).toHaveBeenCalled();
    reads.restore();
    for (const clear of clearFaults) clear();
    await retryTicks(active);
    await expectStoppedExit(active, turn.turnExecutionId);
  });

  it("S2 saves a Stop answered before its cancelled ending's save failed as the user's Stop", async () => {
    const { active, plan, turn, event } = await start();
    await active.emit(event({ type: "textDelta", threadId: active.thread.id, delta: "Reply before Stop", isFinalResponse: true }));
    const fault = refuse(plan, terminalWrite(active.thread.id, turn.turnId), writerFailures.full, { times: "always", pinOperation: true });
    const stop = settled("Stop", await settleWithinTicks(active, active.requestStop()));
    expect(stop).toMatchObject({ status: "fulfilled", value: { status: "cancelled" } });
    await fault.reached;
    await retryTicks(active);
    await expectStoppedExit(active, turn.turnExecutionId);
  });

  it("S2 admits the next send when a stopped turn's worker release and its saving exit release it at once", async () => {
    const { active, plan, turn, event } = await start();
    await active.emit(event({ type: "textDelta", threadId: active.thread.id, delta: "Reply before Stop", isFinalResponse: true }));
    const fault = refuse(plan, terminalWrite(active.thread.id, turn.turnId), writerFailures.full, { times: "always", pinOperation: true });
    const releases = overlapWorkerReleases(active);
    const stop = settled("Stop", await settleWithinTicks(active, active.requestStop()));
    expect(stop).toMatchObject({ status: "fulfilled", value: { status: "cancelled" } });
    await fault.reached;
    await retryTicks(active);
    if (!releases.overlapped) throw new Error("harness: the saving exit did not release while the worker release was held");
    await expectStoppedExit(active, turn.turnExecutionId);
  });

  it("S2 admits the next send when a stopped turn's saving exit releases it and its worker release joins", async () => {
    const { active, plan, turn, event } = await start();
    await active.emit(event({ type: "textDelta", threadId: active.thread.id, delta: "Reply before Stop", isFinalResponse: true }));
    const fault = refuse(plan, terminalWrite(active.thread.id, turn.turnId), writerFailures.full, { times: "always", pinOperation: true });
    const releases = exitReleasesFirst(active, "under-way");
    const stop = settled("Stop", await settleWithinTicks(active, active.requestStop()));
    expect(stop).toMatchObject({ status: "fulfilled", value: { status: "cancelled" } });
    await fault.reached;
    await retryTicks(active);
    if (!releases.ordered) throw new Error("harness: the worker release did not join the saving exit's release");
    await expectStoppedExit(active, turn.turnExecutionId);
    await vi.waitFor(() => expect(fileEvidenceState(active, turn.turnExecutionId)).toBe("untracked"));
  });

  it("S2 saves a stopped turn's file evidence when its worker release wins over the saving exit", async () => {
    const { active, plan, turn, event } = await start();
    await active.emit(event({ type: "textDelta", threadId: active.thread.id, delta: "Reply before Stop", isFinalResponse: true }));
    const fault = refuse(plan, terminalWrite(active.thread.id, turn.turnId), writerFailures.full, { times: "always", pinOperation: true });
    const releases = overlapWorkerReleases(active);
    const stop = settled("Stop", await settleWithinTicks(active, active.requestStop()));
    expect(stop).toMatchObject({ status: "fulfilled", value: { status: "cancelled" } });
    await fault.reached;
    await retryTicks(active);
    if (!releases.overlapped) throw new Error("harness: the saving exit did not release while the worker release was held");
    await expectStoppedExit(active, turn.turnExecutionId);
    await vi.waitFor(() => expect(fileEvidenceState(active, turn.turnExecutionId)).toBe("untracked"));
  });

  it("S2 saves a stopped turn's file evidence when its worker was released before the saving exit ended it", async () => {
    const { active, plan, turn, event } = await start();
    await active.emit(event({ type: "textDelta", threadId: active.thread.id, delta: "Reply before Stop", isFinalResponse: true }));
    const fault = refuse(plan, terminalWrite(active.thread.id, turn.turnId), writerFailures.full, { times: "always", pinOperation: true });
    const stop = settled("Stop", await settleWithinTicks(active, active.requestStop()));
    expect(stop).toMatchObject({ status: "fulfilled", value: { status: "cancelled" } });
    await fault.reached;
    // No fake time passes, so the refused save has not given up and the exit has not started.
    await vi.waitFor(() => expect(active.workers.owner.current(active.thread.id)).toBeUndefined(), { timeout: 10_000, interval: 10 });
    await retryTicks(active);
    await expectStoppedExit(active, turn.turnExecutionId);
    await vi.waitFor(() => expect(fileEvidenceState(active, turn.turnExecutionId)).toBe("untracked"));
  });

  it("S2 answers Stop when the saving exit's worker release finished before Stop released the worker", async () => {
    const { active, plan, turn, event } = await start();
    await active.emit(event({ type: "textDelta", threadId: active.thread.id, delta: "Reply before Stop", isFinalResponse: true }));
    const drain = holdStopDrain(active);
    const stop = track(active.requestStop());
    await vi.waitFor(() => expect(drain.reached).toBe(true));
    const fault = refuse(plan, terminalWrite(active.thread.id, turn.turnId), writerFailures.full, { times: "always", pinOperation: true });
    await deliverTurnComplete(active, event);
    await fault.reached;
    await retryTicks(active);
    await untilRuntimeReleased(active);
    drain.open();
    const answered = settled("Stop", await settleTrackedWithinTicks(active, stop));
    if (answered.status === "rejected") throw answered.error;
    expect(answered.value.status).toBe("already-terminal");
    await expectStoppedExit(active, turn.turnExecutionId);
  });

  it("S2 ends a stopped turn whose Stop reaches the worker while the saving exit is releasing it", async () => {
    const { active, plan, turn, event } = await start();
    await active.emit(event({ type: "textDelta", threadId: active.thread.id, delta: "Saved before Stop", isFinalResponse: false }));
    const drain = holdStopDrain(active);
    const stop = track(active.requestStop());
    await vi.waitFor(() => expect(drain.reached).toBe(true));
    const exitRelease = holdExitReleaseUntilStopCommand(active);
    const fault = refuse(plan, threadWrite(active.thread.id), writerFailures.full, { times: "always", pinOperation: true });
    await active.deliver(event({ type: "toolUse", threadId: active.thread.id, toolCallId: "full-1", toolName: "Bash", toolInput: { command: "ls" } }));
    await fault.reached;
    for (let tick = 0; tick < K && !exitRelease.submitted; tick += 1) await retryTicks(active, 1);
    if (!exitRelease.submitted) throw new Error("harness: the saving exit did not release the worker within the bound");
    drain.open();
    const answered = settled("Stop", await settleTrackedWithinTicks(active, stop));
    if (answered.status === "rejected") throw answered.error;
    expect(answered.value.status).toBe("already-terminal");
    await expectStoppedExit(active, turn.turnExecutionId);
  });

  it("S2 answers a stopped turn's Stop that reaches the worker after the saving exit released it", async () => {
    const { active, plan, turn, event } = await start();
    await active.emit(event({ type: "textDelta", threadId: active.thread.id, delta: "Saved before Stop", isFinalResponse: false }));
    const drain = holdStopDrain(active);
    const stop = track(active.requestStop());
    await vi.waitFor(() => expect(drain.reached).toBe(true));
    const fault = refuse(plan, threadWrite(active.thread.id), writerFailures.full, { times: "always", pinOperation: true });
    await active.deliver(event({ type: "toolUse", threadId: active.thread.id, toolCallId: "full-1", toolName: "Bash", toolInput: { command: "ls" } }));
    await fault.reached;
    await retryTicks(active);
    await untilRuntimeReleased(active);
    drain.open();
    const answered = settled("Stop", await settleTrackedWithinTicks(active, stop));
    if (answered.status === "rejected") throw answered.error;
    expect(answered.value.status).toBe("already-terminal");
    await expectStoppedExit(active, turn.turnExecutionId);
  });

  it("S2 keeps a stopped turn ended when the agent's late text and completion arrive after the exit", async () => {
    const { active, plan, turn, event } = await start();
    await active.emit(event({ type: "textDelta", threadId: active.thread.id, delta: "Reply before Stop", isFinalResponse: true }));
    const execution = ownedExecution(active);
    const fault = refuse(plan, terminalWrite(active.thread.id, turn.turnId), writerFailures.full, { times: "always", pinOperation: true });
    const stop = settled("Stop", await settleWithinTicks(active, active.requestStop()));
    expect(stop).toMatchObject({ status: "fulfilled", value: { status: "cancelled" } });
    await fault.reached;
    await retryTicks(active);
    expect(active.canonical.loadTurnByExecution(turn.turnExecutionId)?.status).toBe("Cancelled");
    const late = [
      event({ type: "textDelta", threadId: active.thread.id, delta: "Late reply", isFinalResponse: true }),
      event({ type: "turnComplete", threadId: active.thread.id, reason: "end_turn", costUsd: null, tokensIn: 0, tokensOut: 0, providerId: "codex" }),
      event({ type: "ended", threadId: active.thread.id }),
    ];
    for (const [index, lateEvent] of late.entries()) {
      settled("late delivery", await settleWithinTicks(active, deliverLate(active, execution, lateEvent, index)));
    }
    await retryTicks(active);
    expect(assistantReplies(active)).toEqual(["Reply before Stop"]);
    expect(canonicalEventCount(active, "turn.completed")).toBe(0);
    await expectStoppedExit(active, turn.turnExecutionId);
  });

  it("S2 saves a Stop that waited out a retrying ending save as the user's Stop", async () => {
    const { active, plan, turn, event } = await start();
    await active.emit(event({ type: "textDelta", threadId: active.thread.id, delta: "Reply before Stop", isFinalResponse: true }));
    const fault = refuse(plan, terminalWrite(active.thread.id, turn.turnId), writerFailures.busy, { times: "always", pinOperation: true });
    await finish(active, event, true);
    await fault.reached;
    const stop = track(active.requestStop());
    const answered = settled("Stop", await settleTrackedWithinTicks(active, stop, 2 * K));
    expect(answered).toMatchObject({ status: "fulfilled", value: { status: "cancelled" } });
    await expectStoppedExit(active, turn.turnExecutionId);
  });

  it("S3 recovers from three busy text writes without duplicating text", async () => {
    const { active, plan, turn, event } = await start();
    const fault = refuse(plan, threadWrite(active.thread.id), writerFailures.busy, { times: 3 });
    await active.deliver(event({ type: "textDelta", threadId: active.thread.id, delta: "Saved exactly once", isFinalResponse: true }));
    // Armed before any retry fires: a busy refusal misread as permanent would reject this waiter with ThreadSaveBlockedError.
    const progress = active.workers.progress;
    if (!progress) throw new Error("harness: worker fixture has no accepted progress owner");
    const waiter = track(progress.waitForSaved(active.thread.id));
    await deliverTurnComplete(active, event);
    const saved = settled("save waiter", await settleTrackedWithinTicks(active, waiter));
    expect(saved).toMatchObject({ status: "fulfilled" });
    expect(fault.hits).toBe(3);
    await deliverEnded(active, event);
    expect(active.canonical.loadTurnByExecution(turn.turnExecutionId)?.status).toBe("Completed");
    expect(assistantReplies(active)).toEqual(["Saved exactly once"]);
    const next = await settleWithinTicks(active, send(active));
    expect(next).toMatchObject({ status: "fulfilled" });
  });

  it("S4 replaces rejected content and admits another send", async () => {
    const { active, plan, turn, event } = await start();
    // Content rejection is permanent, so the original finish is refused on every attempt and only its replacement
    // can save. The replacement still keeps the events, so the reply text stays; what it drops is the finish's own
    // contents, and it leaves a marker so the saved history says the operation lost them.
    const fault = refuse(plan, originalWrite(terminalWrite(active.thread.id, turn.turnId)), writerFailures.content, { times: "always", pinOperation: true });
    await active.deliver(event({ type: "textDelta", threadId: active.thread.id, delta: "Rejected text", isFinalResponse: true }));
    await finish(active, event);
    // One refusal, then the replacement: a content rejection retried like a busy one would be refused again.
    expect(fault.hits).toBe(1);
    expect(active.canonical.loadTurnByExecution(turn.turnExecutionId)?.status).toBe("Completed");
    // Exactly once: lost text or a replacement that saved the reply again would both show here.
    expect(assistantReplies(active)).toEqual(["Rejected text"]);
    const markers = active.db.query<{ envelope_json: string }, [string]>(
      "SELECT envelope_json FROM canonical_agent_events WHERE thread_id = ? AND envelope_json LIKE '%ingest.content-replaced%'")
      .all(active.thread.id)
      .map((row) => JSON.parse(row.envelope_json).payload);
    // Writer receipts are not checked: acknowledged receipts are deleted on a timer, so they may already be gone.
    expect(markers).toEqual([
      { type: "ingest.content-replaced", operationId: expect.any(String), reason: writerFailures.content.contentRejection },
    ]);
    const next = await settleWithinTicks(active, send(active));
    expect(next).toMatchObject({ status: "fulfilled" });
  });

  it("S5 rethrows harness errors", async () => {
    const error = new Error("Harness broke");
    await expect(knownStall("example", /./, async () => { throw error; })).rejects.toBe(error);
  });

  it("S5 rethrows an invariant violation that is not the known stall", async () => {
    const violation = new InvariantViolation("A different invariant broke");
    await expect(knownStall("example", /expected signature/, async () => { throw violation; })).rejects.toBe(violation);
  });

  it("S5 accepts the known stall's own violation", async () => {
    await expect(knownStall("example", /expected signature/, async () => { expectInvariant(false, "the expected signature"); })).resolves.toBeUndefined();
  });

  it("S5 rejects a fixed stall", async () => {
    await expect(knownStall("example", /./, async () => undefined)).rejects.toThrow('Known stall is fixed: remove knownStall("example")');
  });
});
