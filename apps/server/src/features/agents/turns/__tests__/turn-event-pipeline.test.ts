import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { AgentEventType, type AgentEvent } from "@mcode/contracts";

import {
  TurnEventPipeline,
  TURN_EVENT_QUEUE_RETAINED_LIMITS,
  type TurnEventApplication,
  type TurnEventIngressFence,
  type TurnLifecycleControl,
} from "../turn-event-pipeline.js";
import type { ProviderEventIngressEvent } from "../../../providers/composition/provider-event-ingress.js";
import { PARENT_ASSISTANT_TEXT_RETAINED_LIMITS } from "../parent-assistant-text-checkpoint-service.js";

const EXECUTION_ID = "00000000-0000-4000-8000-000000000001";

function textDelta(delta: string, threadId = "thread-1"): ProviderEventIngressEvent {
  return {
    providerId: "claude",
    sourceKind: "canonical-bridge",
    canonicalReceipt: {
      eventId: `event-${delta}`,
      acceptedSequence: 1,
      durableRevision: 1,
      serverTimestamps: { acceptedAt: "2026-08-28T12:00:00.000Z" },
    },
    event: {
      type: AgentEventType.TextDelta,
      threadId,
      turnExecutionId: EXECUTION_ID,
      delta,
    },
  };
}

function toolResult(output: string): ProviderEventIngressEvent {
  return {
    ...textDelta("tool-result"),
    event: {
      type: AgentEventType.ToolResult,
      threadId: "thread-1",
      turnExecutionId: EXECUTION_ID,
      toolCallId: "tool-1",
      output,
      isError: false,
      exitCode: 0,
      outputTruncated: true,
      outputTotalBytes: 1_048_607,
      outputArtifactPath: "/artifacts/tool-1.txt",
    },
  };
}

function createPipeline(
  apply: TurnEventApplication["apply"],
  finalize = vi.fn(async () => true),
  previousFileFinalization: TurnEventApplication["previousFileFinalization"] = () => undefined,
  rejectForQueueCapacity = vi.fn(),
  ingressFence?: TurnEventIngressFence,
): {
  pipeline: TurnEventPipeline;
  finalize: ReturnType<typeof vi.fn>;
  rejectForQueueCapacity: ReturnType<typeof vi.fn>;
  publishCommitted: ReturnType<typeof vi.fn>;
} {
  const lifecycle: TurnLifecycleControl = {
    normalize: (event) => event,
    finalize,
  };
  const publishCommitted = vi.fn();
  const application: TurnEventApplication = {
    apply,
    publishCommitted,
    observeFileMutation: vi.fn(),
    rejectForQueueCapacity,
    previousFileFinalization,
    beginResumedFileTracking: vi.fn(),
    observeToolUse: vi.fn(),
    observeToolResult: vi.fn(),
  };
  return { pipeline: new TurnEventPipeline(lifecycle, application, undefined, ingressFence), finalize, rejectForQueueCapacity, publishCommitted };
}

describe("TurnEventPipeline", () => {
  it("publishes projected worker output without legacy event application", () => {
    const apply = vi.fn(() => true);
    const { pipeline, publishCommitted } = createPipeline(apply);
    const input = { ...textDelta("durable"), sourceKind: "worker-commit" as const };

    pipeline.handleProjectedCommitted(input);

    expect(publishCommitted).toHaveBeenCalledWith(input.event);
    expect(apply).not.toHaveBeenCalled();
  });

  it("keeps canonical receipt provenance and FIFO order while an earlier checkpoint delays publication", () => {
    let checkpointReady = false;
    const received: Array<{ input: ProviderEventIngressEvent; event: AgentEvent }> = [];
    const { pipeline } = createPipeline((input, event) => {
      received.push({ input, event });
      return checkpointReady;
    });

    const first = textDelta("first");
    const second = textDelta("second");
    pipeline.handleProviderEvent(first);
    pipeline.handleProviderEvent(second);

    expect(received.map(({ event }) => (event as Extract<AgentEvent, { type: "textDelta" }>).delta)).toEqual([
      "first",
      "first",
    ]);
    expect(received[0]?.input.canonicalReceipt).toEqual(first.canonicalReceipt);

    checkpointReady = true;
    pipeline.resume("thread-1");

    expect(received.slice(-2).map(({ event }) => (event as Extract<AgentEvent, { type: "textDelta" }>).delta)).toEqual([
      "first",
      "second",
    ]);
  });

  it("does not materialize a terminal turn until a blocked event queue drains", async () => {
    let checkpointReady = false;
    const { pipeline, finalize } = createPipeline(() => checkpointReady);

    pipeline.handleProviderEvent(textDelta("durable first"));
    const finalization = pipeline.finalizeTurn({
      threadId: "thread-1",
      executionId: EXECUTION_ID,
      outcome: "completed",
      source: "provider",
    });

    await Promise.resolve();
    expect(finalize).not.toHaveBeenCalled();

    checkpointReady = true;
    pipeline.resume("thread-1");
    await expect(finalization).resolves.toBe(true);

    expect(finalize).toHaveBeenCalledOnce();
  });

  it("waits for an asynchronous application without holding another thread", async () => {
    let acknowledge!: (accepted: boolean) => void;
    const durable = new Promise<boolean>((resolve) => { acknowledge = resolve; });
    const applied: string[] = [];
    const { pipeline, finalize } = createPipeline((_input, event) => {
      const delta = (event as Extract<AgentEvent, { type: "textDelta" }>).delta;
      applied.push(delta);
      return delta === "first" ? durable : true;
    });

    pipeline.handleProviderEvent(textDelta("first"));
    pipeline.handleProviderEvent(textDelta("second"));
    pipeline.handleProviderEvent(textDelta("other", "thread-2"));
    const finalization = pipeline.finalizeTurn({
      threadId: "thread-1",
      executionId: EXECUTION_ID,
      outcome: "completed",
      source: "provider",
    });

    expect(applied).toEqual(["first", "other"]);
    expect(finalize).not.toHaveBeenCalled();
    acknowledge(true);
    await expect(finalization).resolves.toBe(true);
    expect(applied).toEqual(["first", "other", "second"]);
  });

  it("waits for an in-flight acknowledgement before finalizing Stop", async () => {
    let acknowledge!: (accepted: boolean) => void;
    const durable = new Promise<boolean>((resolve) => { acknowledge = resolve; });
    const apply = vi.fn(() => durable);
    const { pipeline, finalize } = createPipeline(apply);

    pipeline.handleProviderEvent(textDelta("in flight"));
    pipeline.handleProviderEvent(textDelta("discarded"));
    const finalization = pipeline.finalizeTurn({
      threadId: "thread-1",
      executionId: EXECUTION_ID,
      outcome: "cancelled",
      source: "user-stop",
    });

    expect(finalize).not.toHaveBeenCalled();
    acknowledge(true);
    await expect(finalization).resolves.toBe(true);
    expect(apply).toHaveBeenCalledOnce();
    expect(finalize).toHaveBeenCalledOnce();
  });

  it("keeps an asynchronous blocked event at the queue head until resume", async () => {
    let acknowledge!: (accepted: boolean) => void;
    const durable = new Promise<boolean>((resolve) => { acknowledge = resolve; });
    const applied: string[] = [];
    let ready = false;
    const { pipeline } = createPipeline((_input, event) => {
      const delta = (event as Extract<AgentEvent, { type: "textDelta" }>).delta;
      applied.push(delta);
      return delta === "first" && !ready ? durable : true;
    });

    pipeline.handleProviderEvent(textDelta("first"));
    pipeline.handleProviderEvent(textDelta("second"));
    acknowledge(false);
    await Promise.resolve();
    expect(applied).toEqual(["first"]);

    ready = true;
    pipeline.resume("thread-1");
    expect(applied).toEqual(["first", "first", "second"]);
  });

  it("does not let a discarded acknowledgement consume the next execution's event", async () => {
    const firstExecution = "00000000-0000-4000-8000-000000000010";
    const nextExecution = "00000000-0000-4000-8000-000000000011";
    let acknowledge!: (accepted: boolean) => void;
    const durable = new Promise<boolean>((resolve) => { acknowledge = resolve; });
    const applied: string[] = [];
    const { pipeline } = createPipeline((_input, event) => {
      applied.push(`${event.turnExecutionId}:${event.type}`);
      return event.type === AgentEventType.TextDelta && event.turnExecutionId === firstExecution
        ? durable
        : true;
    });

    pipeline.handleProviderEvent(turnStarted(firstExecution));
    pipeline.handleProviderEvent({
      ...textDelta("old"),
      event: { ...textDelta("old").event, turnExecutionId: firstExecution },
    });
    pipeline.discard("thread-1", firstExecution);
    pipeline.handleProviderEvent(turnStarted(nextExecution));
    expect(applied).toEqual([`${firstExecution}:turnStarted`, `${firstExecution}:textDelta`]);

    acknowledge(true);
    await vi.waitFor(() => {
      expect(applied).toEqual([
        `${firstExecution}:turnStarted`,
        `${firstExecution}:textDelta`,
        `${nextExecution}:turnStarted`,
      ]);
    });
  });

  it("does not finalize after an asynchronous application fails", async () => {
    let fail!: (error: Error) => void;
    const durable = new Promise<boolean>((_resolve, reject) => { fail = reject; });
    const apply = vi.fn(() => durable);
    const { pipeline, finalize } = createPipeline(apply);

    pipeline.handleProviderEvent(textDelta("write failure"));
    const finalization = pipeline.finalizeTurn({
      threadId: "thread-1",
      executionId: EXECUTION_ID,
      outcome: "completed",
      source: "provider",
    });

    fail(new Error("checkpoint failed"));
    await expect(finalization).rejects.toThrow("checkpoint failed");
    pipeline.resume("thread-1");
    expect(apply).toHaveBeenCalledOnce();
    expect(finalize).not.toHaveBeenCalled();
  });

  it("does not turn a failed checkpoint into a successful later Stop", async () => {
    const { pipeline, finalize } = createPipeline(() => Promise.reject(new Error("checkpoint failed")));

    pipeline.handleProviderEvent(textDelta("write failure"));
    await Promise.resolve();
    await expect(pipeline.finalizeTurn({
      threadId: "thread-1",
      executionId: EXECUTION_ID,
      outcome: "cancelled",
      source: "user-stop",
    })).rejects.toThrow("checkpoint failed");
    expect(finalize).not.toHaveBeenCalled();
  });

  it("holds finalization until its thread-affine ingress worker is idle", async () => {
    let releaseIngress!: () => void;
    const ingressIdle = new Promise<void>((resolve) => { releaseIngress = resolve; });
    const ingressFence: TurnEventIngressFence = { waitForThread: () => ingressIdle };
    const { pipeline, finalize } = createPipeline(() => true, undefined, undefined, undefined, ingressFence);

    const finalization = pipeline.finalizeTurn({
      threadId: "thread-1",
      executionId: EXECUTION_ID,
      outcome: "completed",
      source: "provider",
    });

    await Promise.resolve();
    expect(finalize).not.toHaveBeenCalled();
    releaseIngress();
    await expect(finalization).resolves.toBe(true);
    expect(finalize).toHaveBeenCalledOnce();
  });

  it("keeps more than one text write batch ordered while checkpoint recovery delays the turn", () => {
    let checkpointReady = false;
    const applied: string[] = [];
    const { pipeline, rejectForQueueCapacity } = createPipeline((_input, event) => {
      applied.push((event as Extract<AgentEvent, { type: "textDelta" }>).delta);
      return checkpointReady;
    });
    const deltas = Array.from(
      { length: 64 },
      (_, index) => `durable response event ${index + 1}`,
    );

    for (const delta of deltas) pipeline.handleProviderEvent(textDelta(delta));

    expect(rejectForQueueCapacity).not.toHaveBeenCalled();

    checkpointReady = true;
    pipeline.resume("thread-1");

    expect(applied.slice(-deltas.length)).toEqual(deltas);
  });

  it("interrupts only when one event exceeds the retained queue bytes", () => {
    const apply = vi.fn(() => true);
    const { pipeline, rejectForQueueCapacity } = createPipeline(apply);

    pipeline.handleProviderEvent(textDelta("x".repeat(PARENT_ASSISTANT_TEXT_RETAINED_LIMITS.maxBytes)));

    expect(apply).not.toHaveBeenCalled();
    expect(rejectForQueueCapacity).toHaveBeenCalledOnce();
  });

  it("signals the overflowed turn without blocking another thread", () => {
    const appliedThreads: string[] = [];
    const { pipeline, rejectForQueueCapacity } = createPipeline((_input, event) => {
      appliedThreads.push(event.threadId);
      return event.threadId === "healthy-thread";
    });
    const blocked = textDelta("blocked", "overflowed-thread");
    const overflow = textDelta("overflow", "overflowed-thread");

    pipeline.handleProviderEvent(blocked);
    pipeline.handleProviderIngressOverflow(overflow);
    pipeline.handleProviderEvent(textDelta("healthy", "healthy-thread"));

    expect(rejectForQueueCapacity).toHaveBeenCalledWith(overflow.event);
    expect(appliedThreads).toEqual(["overflowed-thread", "healthy-thread"]);
  });

  it("compacts an oversized tool result so its completion reaches the queue", () => {
    const applied: Array<{ input: ProviderEventIngressEvent; event: AgentEvent }> = [];
    const { pipeline, rejectForQueueCapacity } = createPipeline((input, event) => {
      applied.push({ input, event });
      return true;
    });

    pipeline.handleProviderEvent(toolResult("x".repeat(PARENT_ASSISTANT_TEXT_RETAINED_LIMITS.maxBytes)));

    expect(rejectForQueueCapacity).not.toHaveBeenCalled();
    const result = applied[0]?.event as Extract<AgentEvent, { type: "toolResult" }>;
    expect(result).toMatchObject({
      type: AgentEventType.ToolResult,
      toolCallId: "tool-1",
      isError: false,
      exitCode: 0,
      outputTruncated: true,
      outputTotalBytes: 1_048_607,
      outputArtifactPath: "/artifacts/tool-1.txt",
    });
    expect(result.output.length).toBeLessThan(PARENT_ASSISTANT_TEXT_RETAINED_LIMITS.maxBytes);
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(
      TURN_EVENT_QUEUE_RETAINED_LIMITS.maxBytes,
    );
    expect(applied[0]?.input.event).toEqual(result);
  });

  it("replays a file-barrier-deferred event with its original publication intent and provenance", async () => {
    let release!: () => void;
    const previous = new Promise<boolean>((resolve) => { release = () => resolve(true); });
    const received: Array<{ input: ProviderEventIngressEvent; publish: boolean }> = [];
    const { pipeline } = createPipeline((input, _event, publish) => {
      received.push({ input, publish });
      return true;
    }, undefined, () => previous);
    const started: ProviderEventIngressEvent = {
      ...textDelta("resumed"),
      event: { type: AgentEventType.TurnStarted, threadId: "thread-1", turnExecutionId: EXECUTION_ID },
    };

    pipeline.handleProviderEvent(started);
    expect(received).toEqual([]);
    release();
    await vi.waitFor(() => {
      expect(received).toEqual([{ input: started, publish: true }]);
    });
  });

  it("invalidates a deferred file-barrier event when the turn is discarded", async () => {
    let release!: () => void;
    const previous = new Promise<boolean>((resolve) => { release = () => resolve(true); });
    const apply = vi.fn(() => true);
    const { pipeline } = createPipeline(apply, undefined, () => previous);
    pipeline.handleProviderEvent({
      ...textDelta("resumed"),
      event: { type: AgentEventType.TurnStarted, threadId: "thread-1", turnExecutionId: EXECUTION_ID },
    });

    pipeline.discard("thread-1");
    release();
    await Promise.resolve();

    expect(apply).not.toHaveBeenCalled();
  });

  it("cancels a stopped deferred execution without letting an older finalizer erase a newer lifecycle", async () => {
    const executionA = "00000000-0000-4000-8000-000000000010";
    const executionB = "00000000-0000-4000-8000-000000000011";
    const executionC = "00000000-0000-4000-8000-000000000012";
    let releasePrevious!: () => void;
    let releaseFinalization!: () => void;
    const previous = new Promise<boolean>((resolve) => { releasePrevious = () => resolve(true); });
    const pendingFinalization = new Promise<boolean>((resolve) => { releaseFinalization = () => resolve(true); });
    const received: string[] = [];
    const { pipeline } = createPipeline(
      (_input, event) => {
        received.push(event.turnExecutionId!);
        return true;
      },
      vi.fn(() => pendingFinalization),
      () => previous,
    );
    const finalizeA = pipeline.finalizeTurn({
      threadId: "thread-1",
      executionId: executionA,
      outcome: "completed",
      source: "provider",
    });

    pipeline.handleProviderEvent(turnStarted(executionB));
    const finalizeB = pipeline.finalizeTurn({
      threadId: "thread-1",
      executionId: executionB,
      outcome: "cancelled",
      source: "user-stop",
    });
    pipeline.handleProviderEvent(turnStarted(executionC));

    expect(finalizeB).toBe(finalizeA);
    releaseFinalization();
    await expect(finalizeA).resolves.toBe(true);
    pipeline.discard("thread-1", executionA);
    releasePrevious();

    await vi.waitFor(() => {
      expect(received).toEqual([executionC]);
    });
  });

});

function turnStarted(executionId: string): ProviderEventIngressEvent {
  return {
    ...textDelta(executionId),
    event: {
      type: AgentEventType.TurnStarted,
      threadId: "thread-1",
      turnExecutionId: executionId,
    },
  };
}
