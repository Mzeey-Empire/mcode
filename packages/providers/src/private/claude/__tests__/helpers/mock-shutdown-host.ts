import type { ProviderHostPorts } from "@mcode/providers";
import { ProviderRuntimeEventSchema, type ProviderRuntimeEvent } from "@mcode/contracts";

/** Supplies the complete provider host contract without external processes or credentials. */
export function mockShutdownHost(onEvent: (event: ProviderRuntimeEvent) => void): ProviderHostPorts {
  return {
    runtime: { platform: "linux", architecture: "x64", nodeAbi: "127" },
    environment: { snapshot: () => ({}) },
    processes: { attach: () => {}, terminateTree: async () => {} },
    browser: {
      stage: () => ({ leaseId: "shutdown-test", expiresAt: Date.now() + 60_000 }),
      releaseSession: () => 0, isConfigured: () => false, issue: () => null,
      refresh: (leaseId) => ({ ok: false, leaseId, reason: "unconfigured" }),
      release: (leaseId) => ({ leaseId, released: false }), revokeCredential: () => false,
    },
    threadControl: { bootstrap: async () => null, close: async () => {} },
    grants: { consume: () => false },
    events: {
      submit: async (batch) => {
        for (const draft of batch.events) {
          if (draft.payload.type !== "item.recorded" || draft.payload.item.payload.projection !== "providerRuntimeEvent") continue;
          onEvent(ProviderRuntimeEventSchema().parse(draft.payload.item.payload.runtimeEvent));
        }
        return {
          commit: {
            outcome: "committed", conversationRevision: 0, rosterRevision: 0,
            acceptedThrough: 0, durableThrough: 0, eventCount: batch.events.length,
          },
          delivery: { ingress: "queued" },
        };
      },
    },
  };
}
