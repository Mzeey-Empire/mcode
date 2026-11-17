import { afterEach, describe, expect, it, vi } from "vitest";
import * as NodeFS from "node:fs";
import * as NodeTimersPromises from "node:timers/promises";
import type { AgentEvent } from "@mcode/contracts/events/agent-event";
import { isThreadSaveBlocked } from "../../canonical/accepted-save-failure.js";
import { WriterFaultPlan, originalWrite, terminalWrite, threadWrite, writerFailures } from "./faulty-writer-worker.js";
import { InvariantViolation, expectInvariant, knownStall } from "./known-stall.js";
import { openWorkerServiceFixture, openWorkerTurnFixture } from "./worker-turn-fixture.js";

vi.mock("../../../../application/transport/push.js", () => ({ broadcast: vi.fn(), subscribedThreadIds: () => new Set<string>() }));

type Fixture = Awaited<ReturnType<typeof openWorkerServiceFixture>>;
const K = 5;
let fixture: Fixture | undefined;
let clearFault: (() => void) | undefined;

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

async function refusedFinish() {
  const context = await start();
  const { active, plan, turn, event } = context;
  await active.emit(event({ type: "textDelta", threadId: active.thread.id, delta: "A deterministic reply", isFinalResponse: true }));
  const fault = plan.refuse(terminalWrite(active.thread.id, turn.turnId), writerFailures.identity, { times: "always", pinOperation: true });
  clearFault = fault.clear;
  await finish(active, event, true);
  await fault.reached;
  return context;
}

function terminal(active: Fixture, executionId: string) {
  const turn = active.canonical.loadTurnByExecution(executionId);
  return turn && turn.status !== "Pending" && turn.status !== "Running";
}

afterEach(async () => {
  try {
    clearFault?.();
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
    clearFault = undefined;
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
    await knownStall("refused save leaves the turn Running", /turn Running with no ending; next send refused as save-blocked/, async () => {
      const { active, turn } = await refusedFinish();
      await retryTicks(active);
      const next = settled("next send", await settleWithinTicks(active, send(active)));
      // Any other refusal is not this stall, so it surfaces as the failure it is. The send's refusal reaches the
      // caller rebuilt across the execution worker, so it is recognised by its code, not its class.
      if (next.status === "rejected" && !isThreadSaveBlocked(next.error)) throw next.error;
      const saved = active.canonical.loadTurnByExecution(turn.turnExecutionId);
      expectInvariant(terminal(active, turn.turnExecutionId) && saved?.ending && next.status === "fulfilled",
        `Refused save: turn ${saved?.status} with${saved?.ending ? "" : " no"} ending; next send ${next.status === "rejected" ? "refused as save-blocked" : "admitted"}`);
    });
  });

  it("S2 accepts Stop after an unsaved finish", async () => {
    await knownStall("Stop refused after an unsaved finish", /Stop answered already-terminal while the database turn is Running/, async () => {
      const { active, turn } = await refusedFinish();
      const stop = settled("Stop", await settleWithinTicks(active, active.requestStop()));
      if (stop.status === "rejected") throw stop.error;
      expectInvariant(terminal(active, turn.turnExecutionId),
        `Stop answered ${stop.value.status} while the database turn is ${active.canonical.loadTurnByExecution(turn.turnExecutionId)?.status}`);
    });
  });

  it("S3 recovers from three busy text writes without duplicating text", async () => {
    const { active, plan, turn, event } = await start();
    const fault = plan.refuse(threadWrite(active.thread.id), writerFailures.busy, { times: 3 });
    clearFault = fault.clear;
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
    const fault = plan.refuse(originalWrite(terminalWrite(active.thread.id, turn.turnId)), writerFailures.content, { times: "always", pinOperation: true });
    clearFault = fault.clear;
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
