import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { ProviderEventIngress, type ProviderEventIngressEvent, type ProviderEventIngressDiagnostic } from "../provider-event-ingress.js";
import type { ProjectedCommittedProviderEvent } from "../../../agents/execution/execution-worker-handler.js";

function projected(delta: string, threadId = "thread-1"): ProjectedCommittedProviderEvent {
  return {
    providerId: "claude", sourceKind: "canonical-commit", deliveryAttempt: 2,
    event: { type: "textDelta", threadId, turnExecutionId: "00000000-0000-4000-8000-000000000001", delta },
    canonicalReceipt: {
      eventId: threadId + ":" + delta, acceptedSequence: 4, durableRevision: 3,
      serverTimestamps: { acceptedAt: "2026-08-27T12:00:00.000Z" },
    },
  };
}

function createIngress() {
  const received: ProviderEventIngressEvent[] = [];
  const diagnostics: ProviderEventIngressDiagnostic[] = [];
  const ingress = new ProviderEventIngress((diagnostic) => diagnostics.push(diagnostic));
  ingress.start({ resolveAll: () => [] }, {
    handleProjectedCommitted: (event) => received.push(event),
    handleProviderFileMutation: () => undefined,
    handleProviderTurnDiff: () => undefined,
  });
  return { ingress, received, diagnostics };
}

describe("ProviderEventIngress worker commits", () => {
  it("keeps delivery attempt metadata and durable receipt provenance", async () => {
    const { ingress, received } = createIngress();
    ingress.acceptProjectedCommitted([projected("answer")]);
    await ingress.waitForThread("thread-1");
    expect(received).toEqual([{
      providerId: "claude", sourceKind: "worker-commit", deliveryAttempt: 2,
      event: { type: "textDelta", threadId: "thread-1", turnExecutionId: "00000000-0000-4000-8000-000000000001", delta: "answer" },
      canonicalReceipt: {
        eventId: "thread-1:answer", acceptedSequence: 4, durableRevision: 3,
        serverTimestamps: { acceptedAt: "2026-08-27T12:00:00.000Z" },
      },
    }]);
  });

  it("queues projected writer events in order and deduplicates their receipt", async () => {
    const { ingress, received } = createIngress();
    ingress.acceptProjectedCommitted([projected("first"), projected("second"), projected("first")]);
    await ingress.waitForThread("thread-1");
    ingress.acceptProjectedCommitted([projected("first")]);
    await ingress.waitForThread("thread-1");
    expect(received.map((input) => input.canonicalReceipt?.eventId)).toEqual(["thread-1:first", "thread-1:second"]);
  });

  it("does not invoke the consumer on the provider callback stack", async () => {
    const { ingress, received } = createIngress();
    ingress.acceptProjectedCommitted([projected("deferred")]);
    expect(received).toEqual([]);
    await ingress.waitForThread("thread-1");
    expect(received.map((input) => input.event.type)).toEqual(["textDelta"]);
  });

  it("takes turns between seven queued threads while preserving each thread order", async () => {
    const { ingress, received } = createIngress();
    for (let thread = 0; thread < 7; thread += 1) {
      ingress.acceptProjectedCommitted([projected("first", String(thread)), projected("second", String(thread))]);
    }
    await ingress.stopAdmissionAndDrain();
    expect(received.map((input) => input.canonicalReceipt?.eventId)).toEqual([
      "0:first", "1:first", "2:first", "3:first", "4:first", "5:first", "6:first",
      "0:second", "1:second", "2:second", "3:second", "4:second", "5:second", "6:second",
    ]);
  });

  it("drains yielded queues before closing admission", async () => {
    const { ingress, received } = createIngress();
    ingress.acceptProjectedCommitted(Array.from({ length: 130 }, (_, index) => projected(String(index))));
    await ingress.stopAdmissionAndDrain();
    expect(received.map((input) => input.canonicalReceipt?.eventId)).toEqual(
      Array.from({ length: 130 }, (_, index) => "thread-1:" + index),
    );
    expect(() => ingress.acceptProjectedCommitted([projected("late")])).toThrow();
    expect(ingress.queueMetrics()).toMatchObject({ pendingEvents: 0, pendingBytes: 0, queuedThreadCount: 0 });
  });

  it("bounds one thread without rejecting another thread's committed output", async () => {
    const { ingress, received, diagnostics } = createIngress();
    ingress.acceptProjectedCommitted(Array.from({ length: 2_048 }, (_, index) => projected(String(index))));
    expect(() => ingress.acceptProjectedCommitted([projected("overflow")])).toThrow();
    ingress.acceptProjectedCommitted([projected("other", "thread-2")]);
    await ingress.stopAdmissionAndDrain();
    expect(received.filter((input) => input.event.threadId === "thread-1")).toHaveLength(2_048);
    expect(received.filter((input) => input.event.threadId === "thread-2").map((input) => input.canonicalReceipt?.eventId)).toEqual(["thread-2:other"]);
    expect(diagnostics.filter((diagnostic) => diagnostic.reason === "queue-capacity")).toMatchObject([
      { threadId: "thread-1", queueCapacity: "thread", sourceKind: "worker-commit" },
    ]);
  });

  it("reserves ingress capacity for terminal lifecycle events", async () => {
    const { ingress, received } = createIngress();
    ingress.acceptProjectedCommitted(Array.from({ length: 2_048 }, (_, index) => projected(String(index))));
    ingress.acceptProjectedCommitted([{
      ...projected("ended"),
      event: { type: "ended", threadId: "thread-1", turnExecutionId: "00000000-0000-4000-8000-000000000001" },
    }]);
    await ingress.stopAdmissionAndDrain();
    expect(received).toHaveLength(2_049);
    expect(received.at(-1)?.event).toEqual({ type: "ended", threadId: "thread-1", turnExecutionId: "00000000-0000-4000-8000-000000000001" });
  });

  it("bounds retained worker bytes without rejecting another thread", async () => {
    const { ingress, received, diagnostics } = createIngress();
    expect(() => ingress.acceptProjectedCommitted([projected("x".repeat(2 * 1_024 * 1_024))])).toThrow();
    ingress.acceptProjectedCommitted([projected("kept", "thread-2")]);
    await ingress.stopAdmissionAndDrain();
    expect(received.map((input) => input.canonicalReceipt?.eventId)).toEqual(["thread-2:kept"]);
    expect(diagnostics.filter((diagnostic) => diagnostic.reason === "queue-capacity")).toMatchObject([
      { threadId: "thread-1", queueCapacity: "thread-bytes", sourceKind: "worker-commit" },
    ]);
  });

  it("keeps child endings out of the parent's terminal allowance", async () => {
    const { ingress, received } = createIngress();
    ingress.acceptProjectedCommitted(Array.from({ length: 8 }, (_, index) => ({
      ...projected("child-" + index),
      providerId: "codex",
      event: { type: "ended", threadId: "thread-1", turnExecutionId: "00000000-0000-4000-8000-000000000001" },
      runtimeExtension: {
        providerId: "codex", kind: "codex-collaboration",
        child: { nativeThreadId: "child-" + index, nativeTurnId: "turn-" + index, parentCollaborationItemId: "spawn" },
      },
    })));
    await ingress.stopAdmissionAndDrain();
    expect(received.map((input) => input.canonicalReceipt?.eventId)).toEqual([
      "thread-1:child-0", "thread-1:child-1", "thread-1:child-2", "thread-1:child-3",
      "thread-1:child-4", "thread-1:child-5", "thread-1:child-6", "thread-1:child-7",
    ]);
  });

});
