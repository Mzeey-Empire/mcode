import { describe, expect, it, vi } from "vitest";
import { AgentEventType } from "@mcode/contracts/events/agent-event";
import { ProviderRuntimeEventSchema, providerRuntimeEvent } from "@mcode/contracts/events/provider-runtime-event";
import { CanonicalLiveEventPublisher } from "../canonical-live-event-publisher.js";
import type { ProviderEventSinkPort, ProviderEventSubmissionReceipt } from "../../host-ports.js";
import { CodexCanonicalEventPublisher } from "../codex/codex-canonical-event-publisher.js";

const routing = { threadId: "thread-1", turnId: "turn-1", executionId: "00000000-0000-4000-8000-000000000001", deliveryAttempt: 1 };
const event = providerRuntimeEvent({ type: AgentEventType.System, threadId: routing.threadId, subtype: "notice" });
const terminal = providerRuntimeEvent({ type: AgentEventType.Ended, threadId: routing.threadId,
  turnExecutionId: routing.executionId, outcome: "errored" });
const receipt: ProviderEventSubmissionReceipt = {
  commit: { outcome: "accepted", acceptedThrough: 1, eventCount: 1, progressPosition: { epoch: "00000000-0000-4000-8000-000000000001", sequence: 1 } },
  delivery: { ingress: "not-required" },
};

const factories = [
  { name: "Codex", create: (sink: ProviderEventSinkPort) => {
    const publisher = new CodexCanonicalEventPublisher(sink);
    return { publish: () => publisher.publish(routing, event), publishTerminal: () => publisher.publish(routing, terminal), publishPeer: () => publisher.publish({ ...routing, executionId: "00000000-0000-4000-8000-000000000002" }, event), drain: () => publisher.stopAdmissionAndDrain() };
  } },
  { name: "Cursor", create: (sink: ProviderEventSinkPort) => {
    const publisher = new CanonicalLiveEventPublisher("cursor", sink, undefined, "execution");
    return { publish: () => publisher.publish(routing, event, []), publishTerminal: () => publisher.publish(routing, terminal, []), publishPeer: () => publisher.publish({ ...routing, executionId: "00000000-0000-4000-8000-000000000002" }, event, []), drain: () => publisher.stopAdmissionAndDrain() };
  } },
  { name: "Devin", create: (sink: ProviderEventSinkPort) => {
    const publisher = new CanonicalLiveEventPublisher("devin", sink, undefined, "execution");
    return { publish: () => publisher.publish(routing, event, []), publishTerminal: () => publisher.publish(routing, terminal, []), publishPeer: () => publisher.publish({ ...routing, executionId: "00000000-0000-4000-8000-000000000002" }, event, []), drain: () => publisher.stopAdmissionAndDrain() };
  } },
];

describe.each(["claude", "cursor", "devin", "copilot", "opencode"] as const)("%s save backpressure", (providerId) => {
  it("drains more than 1024 held saves in order through the real outcome", async () => {
    const held = Promise.withResolvers<void>();
    const received: string[] = [];
    const publisher = new CanonicalLiveEventPublisher(providerId, { submit: async (batch) => {
      await held.promise;
      for (const draft of batch.events) {
        if (draft.payload.type !== "item.recorded") throw new Error("Missing runtime event");
        const runtime = ProviderRuntimeEventSchema().parse(draft.payload.item.payload.runtimeEvent);
        received.push(runtime.event.type === "textDelta" ? runtime.event.delta : runtime.event.type);
      }
      return receipt;
    } });
    for (let index = 0; index < 2_048; index++) {
      publisher.publish(routing, providerRuntimeEvent({ type: AgentEventType.TextDelta,
        threadId: routing.threadId, delta: String(index) }), []);
    }
    publisher.publish(routing, providerRuntimeEvent({ type: AgentEventType.Ended,
      threadId: routing.threadId, outcome: "completed" }), []);
    let readable = false;
    const capacity = publisher.waitForCapacity(routing.threadId).then(() => { readable = true; });
    const drain = publisher.stopAdmissionAndDrain();
    await Promise.resolve();
    expect(readable).toBe(false);
    expect(received).toEqual([]);
    held.resolve();
    await Promise.all([capacity, drain]);
    expect(received).toEqual([...Array.from({ length: 2_048 }, (_, index) => String(index)), "ended"]);
    expect(readable).toBe(true);
  });

  it("releases a paused reader on Stop without waiting for saving", async () => {
    const held = Promise.withResolvers<void>();
    const publisher = new CanonicalLiveEventPublisher(providerId, { submit: async () => {
      await held.promise;
      return receipt;
    } });
    for (let index = 0; index < 256; index++) publisher.publish(routing, event, []);
    const stop = new AbortController();
    let settled = false;
    const read = publisher.waitForCapacity(routing.threadId, stop.signal).then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    stop.abort();
    await read;
    expect(settled).toBe(true);
    held.resolve();
    await publisher.stopAdmissionAndDrain();
  });
});

describe.each(["claude", "cursor"] as const)("%s native plan lifecycle", (providerId) => {
  it("drops a capture with no assistant message instead of inventing one, and rejects captures after retirement", async () => {
    const submit = vi.fn<ProviderEventSinkPort["submit"]>().mockResolvedValue(receipt);
    const publisher = new CanonicalLiveEventPublisher(providerId, { submit });
    const capture = { markdown: "## Review plan", source: "native" as const };
    publisher.publish(routing, providerRuntimeEvent({ type: AgentEventType.TurnStarted, threadId: routing.threadId }), []);
    publisher.capturePlan(routing, capture);
    publisher.publish(routing, providerRuntimeEvent({ type: AgentEventType.TurnComplete, threadId: routing.threadId,
      reason: "end_turn", providerId, tokensIn: 0, tokensOut: 0, costUsd: null }), []);
    await publisher.waitForExecution(routing);
    const emitted = submit.mock.calls.flatMap(([batch]) => batch.events.flatMap((draft) =>
      draft.payload.type === "item.recorded" && draft.payload.item.payload.projection === "providerRuntimeEvent"
        ? [ProviderRuntimeEventSchema().parse(draft.payload.item.payload.runtimeEvent)] : []));
    expect(emitted.map((runtime) => runtime.event.type)).toEqual(["turnStarted", "turnComplete"]);
    expect(emitted.flatMap((runtime) => runtime.planCapture ? [runtime.planCapture] : [])).toEqual([]);
    publisher.capturePlan(routing, capture);
    publisher.publish(routing, providerRuntimeEvent({ type: AgentEventType.Message, threadId: routing.threadId, content: "Late", tokens: null }), []);
    await publisher.waitForExecution(routing);
    const late = submit.mock.calls.at(-1)?.[0].events[0]?.payload;
    expect(late).toMatchObject({ type: "item.recorded", item: { payload: { runtimeEvent: { event: { content: "Late" } } } } });
    if (late?.type !== "item.recorded") throw new Error("Missing late event");
    expect(ProviderRuntimeEventSchema().parse(late.item.payload.runtimeEvent).planCapture).toBeUndefined();
    await publisher.stopAdmissionAndDrain();
  });
});

describe.each(factories)("$name publisher shutdown", ({ create }) => {
  it("drains every accepted draft and rejects late callbacks", async () => {
    let release!: (value: ProviderEventSubmissionReceipt) => void;
    const submit = vi.fn<ProviderEventSinkPort["submit"]>()
      .mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }))
      .mockResolvedValue(receipt);
    const publisher = create({ submit });
    publisher.publish();
    publisher.publish();
    await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce());
    let drained = false;
    const closing = publisher.drain().then(() => { drained = true; });
    publisher.publish();
    publisher.publishPeer();
    await Promise.resolve();
    expect(drained).toBe(false);
    release(receipt);
    await closing;
    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit.mock.calls.map(([batch]) => batch.events[0]?.sourceSequence)).toEqual([1, 2]);
    await publisher.drain();
    publisher.publish();
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it("waits for a healthy peer before reporting another queue's failure", async () => {
    let releasePeer!: (value: ProviderEventSubmissionReceipt) => void;
    const submit = vi.fn<ProviderEventSinkPort["submit"]>().mockImplementation((batch) => {
      if (batch.executionId === routing.executionId) return Promise.reject(new Error("first queue failed"));
      return new Promise((resolve) => { releasePeer = resolve; });
    });
    const publisher = create({ submit });
    publisher.publishTerminal();
    publisher.publishPeer();
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
    let settled = false;
    const closing = publisher.drain().finally(() => { settled = true; });
    const failed = expect(closing).rejects.toMatchObject({ errors: [expect.objectContaining({ message: "first queue failed" })] });
    await Promise.resolve();
    expect(settled).toBe(false);
    releasePeer(receipt);
    await failed;
  });
});

describe("execution-lifetime publisher endings", () => {
  it("fails Copilot explicitly past the byte budget without a count limit", async () => {
    const failure = vi.fn();
    const held = Promise.withResolvers<void>();
    const publisher = new CanonicalLiveEventPublisher("copilot", { submit: async () => {
      await held.promise;
      return receipt;
    } }, failure, "execution");
    const large = providerRuntimeEvent({ type: "textDelta", threadId: routing.threadId, delta: "x".repeat(1024 * 1024) });
    for (let index = 0; index < 65; index++) publisher.publish(routing, large, []);
    expect(failure).toHaveBeenCalledExactlyOnceWith(routing, expect.objectContaining({ code: "CANONICAL_BACKLOG_BYTE_BUDGET" }));
    held.resolve();
    await expect(publisher.waitForExecution(routing)).rejects.toMatchObject({ code: "CANONICAL_BACKLOG_BYTE_BUDGET" });
    await publisher.stopAdmissionAndDrain();
  });

  it("rejects child endings after a sink failure while admitting the parent ending", async () => {
    const submit = vi.fn<ProviderEventSinkPort["submit"]>()
      .mockRejectedValueOnce(new Error("sink unavailable"))
      .mockResolvedValue(receipt);
    const publisher = new CanonicalLiveEventPublisher("copilot", { submit }, undefined, "execution");
    publisher.publish(routing, event, []);
    await expect(publisher.flushForExecution(routing)).rejects.toThrow();
    publisher.publish(routing, providerRuntimeEvent(terminal.event, { providerId: "copilot", kind: "child-thread",
      childThread: { role: "child", path: ["task"] } }), []);
    publisher.publish(routing, terminal, []);
    await expect(publisher.waitForExecution(routing)).rejects.toThrow();
    expect(submit.mock.calls.map(([batch]) => batch.events[0]?.payload)).toMatchObject([
      { type: "item.recorded", item: { payload: { runtimeEvent: event } } },
      { type: "item.recorded", item: { payload: { runtimeEvent: terminal } } },
    ]);
  });

  it("preserves child and parent endings past the former queue limit", async () => {
    const submit = vi.fn<ProviderEventSinkPort["submit"]>().mockResolvedValue(receipt);
    const publisher = new CanonicalLiveEventPublisher("copilot", { submit }, undefined, "execution");
    for (let index = 0; index < 1_020; index += 1) publisher.publish(routing, event, []);
    for (let index = 0; index < 6; index += 1) {
      publisher.publish(routing, providerRuntimeEvent(index % 2 === 0 ? terminal.event : {
        type: "turnComplete", threadId: routing.threadId, reason: "end_turn", tokensIn: 0, tokensOut: 0, costUsd: null,
      }, { providerId: "copilot", kind: "child-thread", childThread: { role: "child", path: [`task-${index}`] } }), []);
    }
    publisher.publish(routing, providerRuntimeEvent({ type: "turnComplete", threadId: routing.threadId,
      reason: "end_turn", tokensIn: 0, tokensOut: 0, costUsd: null }), []);
    publisher.publish(routing, terminal, []);
    await publisher.waitForExecution(routing);
    const emitted = submit.mock.calls.flatMap(([batch]) => batch.events.flatMap((draft) =>
      draft.payload.type === "item.recorded"
        ? [ProviderRuntimeEventSchema().parse(draft.payload.item.payload.runtimeEvent)] : []));
    expect(emitted).toHaveLength(1_028);
    expect(emitted.slice(1_020).map((runtime) => [runtime.event.type, runtime.extension?.kind === "child-thread"
      ? runtime.extension.childThread.path : null])).toEqual([
      ["ended", ["task-0"]], ["turnComplete", ["task-1"]], ["ended", ["task-2"]],
      ["turnComplete", ["task-3"]], ["ended", ["task-4"]], ["turnComplete", ["task-5"]],
      ["turnComplete", null], ["ended", null],
    ]);
  });
});

describe("Codex optional observation shutdown", () => {
  it("contains an optional failure and drains the following mandatory terminal", async () => {
    const submit = vi.fn<ProviderEventSinkPort["submit"]>()
      .mockRejectedValueOnce(new Error("optional observation failed"))
      .mockResolvedValue(receipt);
    const failed = vi.fn();
    const publisher = new CodexCanonicalEventPublisher({ submit });
    publisher.setFailureHandler(failed);
    publisher.publish(routing, event);
    publisher.publish(routing, terminal);
    await expect(publisher.stopAdmissionAndDrain()).resolves.toBeUndefined();
    expect(failed).not.toHaveBeenCalled();
    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit.mock.calls[1]?.[0].events[0]?.payload).toMatchObject({ type: "item.recorded",
      item: { payload: { projection: "providerRuntimeEvent", runtimeEvent: terminal } } });
  });
});
