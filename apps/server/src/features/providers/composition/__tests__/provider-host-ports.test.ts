import { describe, expect, it, vi } from "vitest";
import { ProviderIdSchema, type CanonicalAgentEventEnvelope } from "@mcode/contracts";
import type { ProviderEventBatch } from "@mcode/providers";

import {
  createProviderHostPorts,
  type ProviderEventOwnershipRoute,
  type WorkerOwnedProviderEventResult,
} from "../provider-host-ports.js";

const EXECUTION_ID = "00000000-0000-4000-8000-000000000001";

function committedRuntimeEnvelope(): CanonicalAgentEventEnvelope {
  return {
    eventId: "event-1",
    routing: { threadId: "thread-1", turnId: "turn-1", executionId: EXECUTION_ID, itemId: "item-1" },
    sourceProviderId: "cursor",
    sourceIdentities: [],
    acceptedSequence: 1,
    durableRevision: 1,
    serverTimestamps: { acceptedAt: "2026-08-27T12:00:00.000Z" },
    payload: {
      type: "item.recorded",
      item: {
        id: "item-1",
        threadId: "thread-1",
        turnId: "turn-1",
        kind: "system",
        providerIdentities: [],
        payload: {
          projection: "providerRuntimeEvent",
          runtimeEvent: {
            event: { type: "textDelta", threadId: "thread-1", turnExecutionId: EXECUTION_ID, delta: "Cursor output" },
          },
        },
        createdAt: "2026-08-27T12:00:00.000Z",
        updatedAt: "2026-08-27T12:00:00.000Z",
      },
    },
  };
}

function ownedBatch(providerId: "claude" | "cursor", deliveryAttempt: number, sequence: number): ProviderEventBatch {
  const eventId = `${providerId}:${EXECUTION_ID}:attempt:${deliveryAttempt}:event:${sequence}`;
  const itemId = `${providerId}:${EXECUTION_ID}:attempt:${deliveryAttempt}:item:${sequence}`;
  const envelope = committedRuntimeEnvelope();
  if (envelope.payload.type !== "item.recorded") throw new Error("Expected recorded item fixture");
  return {
    threadId: "thread-1",
    turnId: "turn-1",
    executionId: EXECUTION_ID,
    batchId: eventId,
    deliveryAttempt,
    phase: "running",
    events: [{
      eventId,
      routing: { ...envelope.routing, itemId },
      sourceProviderId: providerId,
      sourceIdentities: [],
      sourceSequence: sequence,
      payload: {
        type: "item.recorded",
        item: { ...envelope.payload.item, id: itemId },
      },
    }],
  };
}

function workerCommit(batch: ProviderEventBatch, sequence: number): WorkerOwnedProviderEventResult {
  const [draft] = batch.events;
  if (!draft || !batch.batchId || !batch.deliveryAttempt) throw new Error("Expected owned batch fixture");
  return {
    batchId: batch.batchId,
    deliveryAttempt: batch.deliveryAttempt,
    commit: {
      outcome: "committed",
      conversationRevision: sequence,
      rosterRevision: 0,
      acceptedThrough: sequence,
      durableThrough: sequence,
      eventCount: 1,
    },
    providerEvents: [{
      providerId: ProviderIdSchema.parse(draft.sourceProviderId),
      sourceKind: "canonical-commit",
      event: {
        type: "textDelta",
        threadId: batch.threadId,
        turnExecutionId: batch.executionId,
        delta: `output ${sequence}`,
      },
      canonicalReceipt: {
        eventId: draft.eventId,
        acceptedSequence: sequence,
        durableRevision: sequence,
        serverTimestamps: { acceptedAt: "2026-08-27T12:00:00.000Z" },
      },
    }],
  };
}

describe("createProviderHostPorts", () => {
  it("adapts the server browser grant to the Provider contract", () => {
    const ports = createProviderHostPorts({
      runtime: { platform: "linux", architecture: "x64", nodeAbi: "127" },
      envService: { getEnv: () => ({}) },
      jobObject: { isWindowsJob: false },
      browser: {
        issue: vi.fn(() => ({
          leaseId: "lease-1",
          mcpUrl: "http://127.0.0.1:1234/mcp",
          token: "opaque-token",
          credentialId: "credential-1",
          expiresAt: 123,
          allowedOperations: ["inspect"],
        })),
      },
      threadControl: {},
      grants: {},
      events: {},
      ingress: {},
    } as never);

    expect(ports.browser.issue({ leaseId: "lease-1", expiresAt: 123 })).toEqual({
      leaseId: "lease-1",
      mcpUrl: "http://127.0.0.1:1234/mcp",
      token: "opaque-token",
      credentialId: "credential-1",
      expiresAt: 123,
      allowedOperations: ["inspect"],
    });
  });

  it("hands a committed canonical batch directly to ingress after durable acceptance", async () => {
    const events = [committedRuntimeEnvelope()];
    const deliveryOrder: string[] = [];
    const commit = vi.fn(() => {
      deliveryOrder.push("commit");
      return {
        outcome: "committed" as const,
        conversationRevision: 1,
        rosterRevision: 0,
        acceptedThrough: 1,
        durableThrough: 1,
        events,
      };
    });
    const acceptCommitted = vi.fn(() => deliveryOrder.push("ingress"));
    const ports = createProviderHostPorts({
      runtime: { platform: "linux", architecture: "x64", nodeAbi: "127" },
      envService: { getEnv: () => ({ PATH: "test" }) },
      jobObject: { isWindowsJob: false },
      browser: {},
      threadControl: {},
      grants: {},
      events: { commit },
      ingress: { acceptCommitted },
    } as never);
    const batch = { threadId: "thread-1", turnId: "turn-1", executionId: EXECUTION_ID, phase: "streaming", events: [] };

    await expect(ports.events.submit(batch)).resolves.toEqual({
      commit: {
        outcome: "committed",
        conversationRevision: 1,
        rosterRevision: 0,
        acceptedThrough: 1,
        durableThrough: 1,
        eventCount: 1,
      },
      delivery: { ingress: "queued" },
    });
    expect(commit).toHaveBeenCalledWith({ ...batch, nativeCursor: undefined });
    expect(acceptCommitted).toHaveBeenCalledWith(events);
    expect(deliveryOrder).toEqual(["commit", "ingress"]);
  });

  it("does not hand duplicate or failed commits to ingress", async () => {
    const events = [committedRuntimeEnvelope()];
    const acceptCommitted = vi.fn();
    const commit = vi
      .fn()
      .mockReturnValueOnce({
        outcome: "duplicate",
        conversationRevision: 1,
        rosterRevision: 0,
        acceptedThrough: 1,
        durableThrough: 1,
        events,
      })
      .mockImplementationOnce(() => { throw new Error("commit failed"); });
    const ports = createProviderHostPorts({
      runtime: { platform: "linux", architecture: "x64", nodeAbi: "127" },
      envService: { getEnv: () => ({ PATH: "test" }) },
      jobObject: { isWindowsJob: false },
      browser: {},
      threadControl: {},
      grants: {},
      events: { commit },
      ingress: { acceptCommitted },
    } as never);
    const batch = { threadId: "thread-1", turnId: "turn-1", executionId: EXECUTION_ID, phase: "streaming", events: [] };

    await expect(ports.events.submit(batch)).resolves.toMatchObject({
      commit: { outcome: "duplicate" },
      delivery: { ingress: "not-required" },
    });
    await expect(ports.events.submit(batch)).rejects.toThrow("commit failed");
    expect(acceptCommitted).not.toHaveBeenCalled();
  });

  it.each(["claude", "cursor"] as const)("delivers %s worker batches only after ordered commit replies", async (providerId) => {
    const commit = vi.fn();
    const accepted: string[] = [];
    let acknowledge: ((value: WorkerOwnedProviderEventResult) => void) | undefined;
    const firstReply = new Promise<WorkerOwnedProviderEventResult>((resolve) => { acknowledge = resolve; });
    const submit = vi.fn()
      .mockImplementationOnce(() => firstReply)
      .mockImplementation((batch: ProviderEventBatch) => Promise.resolve(workerCommit(batch, 2)));
    const route: ProviderEventOwnershipRoute = {
      kind: "worker",
      threadId: "thread-1",
      turnId: "turn-1",
      executionId: EXECUTION_ID,
      deliveryAttempt: 2,
      submit,
    };
    const ports = createProviderHostPorts({
      events: { commit },
      ingress: { acceptProjectedCommitted: (events: WorkerOwnedProviderEventResult["providerEvents"]) =>
        accepted.push(...events.map((event) => event.canonicalReceipt.eventId)) },
      eventOwnership: { resolve: () => route },
    } as never);
    const first = ownedBatch(providerId, 2, 1);
    const second = ownedBatch(providerId, 2, 2);

    const pending = ports.events.submit(first);
    expect(commit).not.toHaveBeenCalled();
    expect(accepted).toEqual([]);
    acknowledge?.(workerCommit(first, 1));
    await expect(pending).resolves.toMatchObject({
      commit: { outcome: "committed", acceptedThrough: 1 },
      delivery: { ingress: "queued" },
    });
    await ports.events.submit(second);
    expect(accepted).toEqual([first.events[0]?.eventId, second.events[0]?.eventId]);
    expect(submit).toHaveBeenCalledTimes(2);
    expect(commit).not.toHaveBeenCalled();
  });

  it("rejects a stale attempt or mismatched receipt without falling back to the legacy writer", async () => {
    const batch = ownedBatch("claude", 1, 1);
    const commit = vi.fn();
    const acceptProjectedCommitted = vi.fn();
    const submit = vi.fn(() => Promise.resolve({ ...workerCommit(batch, 1), deliveryAttempt: 2 }));
    const route: ProviderEventOwnershipRoute = {
      kind: "worker",
      threadId: batch.threadId,
      turnId: batch.turnId,
      executionId: batch.executionId,
      deliveryAttempt: 2,
      submit,
    };
    const ports = createProviderHostPorts({
      events: { commit },
      ingress: { acceptProjectedCommitted },
      eventOwnership: { resolve: () => route },
    } as never);

    await expect(ports.events.submit(batch)).rejects.toThrow("does not match execution ownership");
    expect(submit).not.toHaveBeenCalled();
    route.deliveryAttempt = 1;
    await expect(ports.events.submit(batch)).rejects.toThrow("receipt does not match submitted batch");
    batch.batchId = undefined;
    await expect(ports.events.submit(batch)).rejects.toThrow("does not match execution ownership");
    expect(commit).not.toHaveBeenCalled();
    expect(acceptProjectedCommitted).not.toHaveBeenCalled();
  });

  it("propagates a worker commit conflict without publishing or using the legacy writer", async () => {
    const batch = ownedBatch("cursor", 1, 1);
    const commit = vi.fn();
    const acceptProjectedCommitted = vi.fn();
    const result = workerCommit(batch, 1);
    const ports = createProviderHostPorts({
      events: { commit },
      ingress: { acceptProjectedCommitted },
      eventOwnership: { resolve: () => ({
        kind: "worker",
        threadId: batch.threadId,
        turnId: batch.turnId,
        executionId: batch.executionId,
        deliveryAttempt: 1,
        submit: () => Promise.resolve({
          ...result,
          commit: { ...result.commit, outcome: "conflict" },
          providerEvents: [],
        }),
      }) },
    } as never);

    await expect(ports.events.submit(batch)).rejects.toThrow("Canonical worker batch failed: conflict");
    expect(commit).not.toHaveBeenCalled();
    expect(acceptProjectedCommitted).not.toHaveBeenCalled();
  });

  it("propagates worker failure and rejected ownership without a legacy commit", async () => {
    const batch = ownedBatch("cursor", 1, 1);
    const commit = vi.fn();
    const submit = vi.fn(() => Promise.reject(new Error("worker unavailable")));
    let route: ProviderEventOwnershipRoute = {
      kind: "worker",
      threadId: batch.threadId,
      turnId: batch.turnId,
      executionId: batch.executionId,
      deliveryAttempt: 1,
      submit,
    };
    const ports = createProviderHostPorts({
      events: { commit },
      ingress: { acceptProjectedCommitted: vi.fn() },
      eventOwnership: { resolve: () => route },
    } as never);

    await expect(ports.events.submit(batch)).rejects.toThrow("worker unavailable");
    route = { kind: "rejected" };
    await expect(ports.events.submit(batch)).rejects.toThrow("no longer admitted");
    expect(submit).toHaveBeenCalledTimes(1);
    expect(commit).not.toHaveBeenCalled();
  });
});
