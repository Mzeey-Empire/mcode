import { describe, expect, it, vi } from "vitest";
import { AgentEventType, ProviderRuntimeEventSchema, providerRuntimeEvent } from "@mcode/contracts";
import { CanonicalLiveEventPublisher } from "../canonical-live-event-publisher.js";
import type { ProviderEventSinkPort, ProviderEventSubmissionReceipt } from "../../host-ports.js";
import { CodexCanonicalEventPublisher } from "../codex/codex-canonical-event-publisher.js";
import { CursorCanonicalEventPublisher } from "../cursor/cursor-canonical-event-publisher.js";
import { DevinCanonicalEventPublisher } from "../devin/devin-canonical-event-publisher.js";

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
    const publisher = new CursorCanonicalEventPublisher(sink);
    return { publish: () => publisher.publish(routing, event, []), publishTerminal: () => publisher.publish(routing, terminal, []), publishPeer: () => publisher.publish({ ...routing, executionId: "00000000-0000-4000-8000-000000000002" }, event, []), drain: () => publisher.stopAdmissionAndDrain() };
  } },
  { name: "Devin", create: (sink: ProviderEventSinkPort) => {
    const publisher = new DevinCanonicalEventPublisher(sink);
    return { publish: () => publisher.publish(routing, event, []), publishTerminal: () => publisher.publish(routing, terminal, []), publishPeer: () => publisher.publish({ ...routing, executionId: "00000000-0000-4000-8000-000000000002" }, event, []), drain: () => publisher.stopAdmissionAndDrain() };
  } },
];

describe.each(["claude", "cursor"] as const)("%s native plan lifecycle", (providerId) => {
  it("drops a capture with no assistant message instead of inventing one, and rejects captures after retirement", async () => {
    const submit = vi.fn<ProviderEventSinkPort["submit"]>().mockResolvedValue(receipt);
    const publisher = providerId === "cursor"
      ? new CursorCanonicalEventPublisher({ submit }) : new CanonicalLiveEventPublisher(providerId, { submit });
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
