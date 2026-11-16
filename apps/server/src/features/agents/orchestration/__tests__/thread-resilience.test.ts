import { afterEach, describe, expect, it, vi } from "vitest";
import * as NodeTimersPromises from "node:timers/promises";
import type { AgentEvent } from "@mcode/contracts/events/agent-event";
import { WriterFaultPlan, terminalWrite, threadWrite, writerFailures } from "./faulty-writer-worker.js";
import { expectInvariant, knownStall } from "./known-stall.js";
import { openWorkerServiceFixture } from "./worker-turn-fixture.js";

vi.mock("../../../../application/transport/push.js", () => ({ broadcast: vi.fn(), subscribedThreadIds: () => new Set<string>() }));

type Fixture = Awaited<ReturnType<typeof openWorkerServiceFixture>>;
const K = 5;
let fixture: Fixture | undefined;
let clearFault: (() => void) | undefined;

type Settlement<T> = { status: "pending" } | { status: "fulfilled"; value: T } | { status: "rejected"; error: unknown };

async function settleWithinTicks<T>(active: Fixture, promise: Promise<T>, maxSteps = K): Promise<Settlement<T>> {
  const outcome: { result: Settlement<T> } = { result: { status: "pending" } };
  void promise.then(
    (value) => { outcome.result = { status: "fulfilled", value }; },
    (error: unknown) => { outcome.result = { status: "rejected", error }; },
  );
  // Next sends await file evidence collection's SNAPSHOT_CAPTURE_BUDGET_MS timer.
  for (let step = 0; step < maxSteps && outcome.result.status === "pending"; step += 1) {
    await vi.advanceTimersByTimeAsync(30_001);
    await active.writer.barrier();
    await NodeTimersPromises.setImmediate();
    await active.writer.barrier();
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

async function finish(active: Fixture, event: (input: AgentEvent) => AgentEvent, unsaved = false) {
  await active.deliver(event({ type: "turnComplete", threadId: active.thread.id, reason: "end_turn", costUsd: null, tokensIn: 0, tokensOut: 0, providerId: "codex" }));
  if (!unsaved) {
    await retryTicks(active);
    await active.workers.progress?.waitForSaved(active.thread.id);
  }
  await active.deliver(event({ type: "ended", threadId: active.thread.id }));
}

async function refusedFinish() {
  const context = await start();
  const { active, plan, turn, event } = context;
  await active.emit(event({ type: "textDelta", threadId: active.thread.id, delta: "A deterministic reply", isFinalResponse: true }));
  const fault = plan.refuse(terminalWrite(active.thread.id, turn.turnId), writerFailures.identity, { times: "always" });
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
  clearFault?.();
  if (fixture) {
    await retryTicks(fixture);
    await fixture.workers.progress?.waitForSaved(fixture.thread.id);
    await fixture.close();
  }
  fixture = undefined;
  clearFault = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("thread resilience without model tokens", { timeout: 30_000 }, () => {
  it("S1 ends a refused terminal save and admits another send", async () => {
    await knownStall("refused save leaves the turn Running", async () => {
      const { active, turn } = await refusedFinish();
      await retryTicks(active);
      const saved = active.canonical.loadTurnByExecution(turn.turnExecutionId);
      const next = await settleWithinTicks(active, send(active));
      const admitted = next.status === "fulfilled";
      expectInvariant(terminal(active, turn.turnExecutionId) && saved?.ending && admitted,
        `Refused save: status=${saved?.status}, ending=${JSON.stringify(saved?.ending)}, nextSend=${next.status}, error=${next.status === "rejected" ? String(next.error) : "none"}`);
    });
  });

  it("S2 accepts Stop after an unsaved finish", async () => {
    await knownStall("Stop refused after an unsaved finish", async () => {
      const { active, turn } = await refusedFinish();
      const stop = await settleWithinTicks(active, active.requestStop());
      expectInvariant(stop.status === "fulfilled" && stop.value.status !== "error" && terminal(active, turn.turnExecutionId),
        `Stop: status=${stop.status}, result=${stop.status === "fulfilled" ? JSON.stringify(stop.value) : "none"}, error=${stop.status === "rejected" ? String(stop.error) : "none"}, turn=${active.canonical.loadTurnByExecution(turn.turnExecutionId)?.status}`);
    });
  });

  it("S3 recovers from three busy text writes without duplicating text", async () => {
    const { active, plan, turn, event } = await start();
    const fault = plan.refuse(threadWrite(active.thread.id), writerFailures.busy, { times: 3 });
    clearFault = fault.clear;
    await active.deliver(event({ type: "textDelta", threadId: active.thread.id, delta: "Saved exactly once", isFinalResponse: true }));
    await finish(active, event);
    await fault.reached;
    expect(active.canonical.loadTurnByExecution(turn.turnExecutionId)?.status).toBe("Completed");
    expect(active.messages.listByThread(active.thread.id, 100).messages.filter((message) => message.role === "assistant").map((message) => message.content)).toEqual(["Saved exactly once"]);
    const next = await settleWithinTicks(active, send(active));
    expect(next).toMatchObject({ status: "fulfilled" });
  });

  it("S4 replaces rejected content and admits another send", async () => {
    const { active, plan, turn, event } = await start();
    const fault = plan.refuse(threadWrite(active.thread.id), writerFailures.content, { times: 1 });
    clearFault = fault.clear;
    await active.deliver(event({ type: "textDelta", threadId: active.thread.id, delta: "Rejected text", isFinalResponse: true }));
    await finish(active, event);
    await fault.reached;
    expect(active.canonical.loadTurnByExecution(turn.turnExecutionId)?.status).toBe("Completed");
    const next = await settleWithinTicks(active, send(active));
    expect(next).toMatchObject({ status: "fulfilled" });
  });

  it("S5 rethrows harness errors", async () => {
    const error = new Error("Harness broke");
    await expect(knownStall("example", async () => { throw error; })).rejects.toBe(error);
  });

  it("S5 rejects a fixed stall", async () => {
    await expect(knownStall("example", async () => undefined)).rejects.toThrow('Known stall is fixed: remove knownStall("example")');
  });
});
