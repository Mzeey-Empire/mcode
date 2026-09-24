import { describe, expect, it, vi } from "vitest";
import type { CanonicalAgentEventEnvelope } from "@mcode/contracts";

import { createProviderHostPorts } from "../provider-host-ports.js";

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
      diagnostics: {},
      publishCanonicalEvents: vi.fn(),
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
    const commit = vi.fn(async () => {
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
    const recordProviderCommitDiagnostics = vi.fn(() => deliveryOrder.push("diagnostics"));
    const publishCanonicalEvents = vi.fn(() => deliveryOrder.push("publication"));
    const acceptCommitted = vi.fn(() => deliveryOrder.push("ingress"));
    const acknowledgeOperation = vi.fn(async () => { deliveryOrder.push("acknowledge"); });
    const ports = createProviderHostPorts({
      runtime: { platform: "linux", architecture: "x64", nodeAbi: "127" },
      envService: { getEnv: () => ({ PATH: "test" }) },
      jobObject: { isWindowsJob: false },
      browser: {},
      threadControl: {},
      grants: {},
      events: { commit, acknowledgeOperation },
      diagnostics: { recordProviderCommitDiagnostics },
      publishCanonicalEvents,
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
    expect(commit).toHaveBeenCalledWith(expect.any(String), { ...batch, nativeCursor: undefined });
    expect(recordProviderCommitDiagnostics).toHaveBeenCalledWith(events);
    expect(publishCanonicalEvents).toHaveBeenCalledWith(events);
    expect(acceptCommitted).toHaveBeenCalledWith(events);
    expect(acknowledgeOperation).toHaveBeenCalledWith(EXECUTION_ID, expect.any(String));
    expect(deliveryOrder).toEqual(["commit", "diagnostics", "publication", "ingress", "acknowledge"]);
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
      events: { commit, acknowledgeOperation: vi.fn() },
      diagnostics: { recordProviderCommitDiagnostics: vi.fn() },
      publishCanonicalEvents: vi.fn(),
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

  it("uses one operation identity for a retry and distinct identities for other phases", async () => {
    const commit = vi.fn(async () => ({
      outcome: "duplicate" as const,
      conversationRevision: 1,
      rosterRevision: 0,
      acceptedThrough: 1,
      durableThrough: 1,
      events: [],
    }));
    const ports = createProviderHostPorts({
      runtime: { platform: "linux", architecture: "x64", nodeAbi: "127" },
      envService: { getEnv: () => ({}) },
      jobObject: { isWindowsJob: false },
      browser: {},
      threadControl: {},
      grants: {},
      events: { commit, acknowledgeOperation: vi.fn() },
      diagnostics: { recordProviderCommitDiagnostics: vi.fn() },
      publishCanonicalEvents: vi.fn(),
      ingress: { acceptCommitted: vi.fn() },
    } as never);
    const batch = { threadId: "thread-1", turnId: "turn-1", executionId: EXECUTION_ID, phase: "streaming", events: [] };

    await ports.events.submit(batch);
    await ports.events.submit(batch);
    await ports.events.submit({ ...batch, phase: "completed" });
    const operationIds = commit.mock.calls.map(([operationId]) => operationId);
    expect(operationIds[0]).toBe(operationIds[1]);
    expect(operationIds[2]).not.toBe(operationIds[0]);
  });

  it("retains the receipt when publication fails after a durable commit", async () => {
    const events = [committedRuntimeEnvelope()];
    const acknowledgeOperation = vi.fn();
    const acceptCommitted = vi.fn();
    const ports = createProviderHostPorts({
      runtime: { platform: "linux", architecture: "x64", nodeAbi: "127" },
      envService: { getEnv: () => ({}) },
      jobObject: { isWindowsJob: false },
      browser: {},
      threadControl: {},
      grants: {},
      events: {
        commit: vi.fn(async () => ({
          outcome: "committed",
          conversationRevision: 1,
          rosterRevision: 0,
          acceptedThrough: 1,
          durableThrough: 1,
          events,
        })),
        acknowledgeOperation,
      },
      diagnostics: { recordProviderCommitDiagnostics: vi.fn() },
      publishCanonicalEvents: () => { throw new Error("push unavailable"); },
      ingress: { acceptCommitted },
    } as never);

    await expect(ports.events.submit({
      threadId: "thread-1", turnId: "turn-1", executionId: EXECUTION_ID,
      phase: "streaming", events: [],
    })).resolves.toMatchObject({ commit: { outcome: "committed" } });
    expect(acceptCommitted).toHaveBeenCalledWith(events);
    expect(acknowledgeOperation).not.toHaveBeenCalled();
  });
});
