import { describe, expect, it, vi } from "vitest";
import { AgentEventType, providerRuntimeEvent } from "@mcode/contracts";
import type { ProviderEventSinkPort, ProviderEventSubmissionReceipt } from "@mcode/providers";
import { CanonicalLiveEventPublisher } from "../canonical-live-event-publisher.js";

const routing = { threadId: "thread-1", turnId: "turn-1", executionId: "00000000-0000-4000-8000-000000000001", deliveryAttempt: 1 };
const event = providerRuntimeEvent({ type: AgentEventType.System, threadId: routing.threadId, subtype: "notice" });
const receipt: ProviderEventSubmissionReceipt = {
  commit: { outcome: "accepted", acceptedThrough: 1, eventCount: 1, progressPosition: { epoch: "00000000-0000-4000-8000-000000000001", sequence: 1 } },
  delivery: { ingress: "not-required" },
};

const factories = (["claude", "copilot", "opencode"] as const).map((name) => ({
  name,
  create: (sink: ProviderEventSinkPort) => {
    const publisher = new CanonicalLiveEventPublisher(name, sink);
    return { publish: () => publisher.publish(routing, event, []), publishPeer: () => publisher.publish({ ...routing, executionId: "00000000-0000-4000-8000-000000000002" }, event, []), drain: () => publisher.stopAdmissionAndDrain() };
  },
}));

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
    publisher.publish();
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
