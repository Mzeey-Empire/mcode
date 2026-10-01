import { describe, expect, it } from "vitest";
import {
  AgentEventEnvelopeSchema,
  CanonicalAgentEventSchema,
  ProviderSchema,
} from "../compat/agent-model.js";
import { AgentEventSchema } from "../events/agent-event.js";
import { TurnExecutionIdSchema } from "../models/turn-runtime.js";
import { WS_CHANNELS } from "../ws/channels.js";

describe("agent-model compatibility boundary", () => {
  it("keeps the current provider event wire shape", () => {
    const result = AgentEventSchema().safeParse({
      type: "turnStarted",
      threadId: "thread-1",
    });

    expect(result.success).toBe(true);
  });

  it("exposes canonical contracts without changing the current channel", () => {
    const provider = ProviderSchema.parse({
      id: "codex",
      capabilities: [{ name: "build", support: "supported" }],
    });
    const envelopeSchema = AgentEventEnvelopeSchema(CanonicalAgentEventSchema);

    expect(provider.id).toBe("codex");
    expect(envelopeSchema).toBeDefined();
    expect(TurnExecutionIdSchema.safeParse("00000000-0000-4000-8000-000000000001").success).toBe(true);
  });

  it("validates accepted progress frames on the canonical channel", () => {
    const frame = {
      phase: "accepted",
      threadId: "thread-1",
      epoch: "epoch-1",
      from: 0,
      through: 1,
      events: [{
        eventId: "event-1",
        routing: {
          threadId: "thread-1",
          turnId: "turn-1",
          executionId: "00000000-0000-4000-8000-000000000001",
        },
        sourceProviderId: "codex",
        sourceIdentities: [],
        acceptedSequence: 1,
        progressPosition: { epoch: "epoch-1", sequence: 1 },
        serverTimestamps: { acceptedAt: "2026-08-09T20:00:00.000Z" },
        payload: {
          type: "turn.started",
          startedAt: "2026-08-09T20:00:00.000Z",
        },
      }],
    };

    expect(WS_CHANNELS["agent.canonical"].safeParse(frame).success).toBe(true);
    expect(WS_CHANNELS["agent.canonical"].safeParse({ ...frame, events: [] }).success).toBe(false);
  });
});
