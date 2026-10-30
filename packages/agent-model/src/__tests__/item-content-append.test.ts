import { describe, expect, it } from "vitest";
import {
  type AgentModelState,
  CanonicalAgentSemanticEnvelopeSchema,
  createAgentModelState,
  reduceAgentEvent,
  reduceAgentEventBatch,
} from "../index.js";

const NOW = "2026-10-29T12:00:00.000Z";
const executionId = "00000000-0000-4000-8000-000000000001";
const itemId = `assistant-response-text:${executionId}`;
const routing = { threadId: "thread-1", turnId: "turn-1", executionId, itemId };

function envelope(acceptedSequence: number, payload: unknown, eventId = `event-${acceptedSequence}`) {
  return CanonicalAgentSemanticEnvelopeSchema.parse({
    eventId,
    routing,
    sourceProviderId: "codex",
    sourceIdentities: [],
    acceptedSequence,
    serverTimestamps: { acceptedAt: NOW },
    payload,
  });
}

function recorded(acceptedSequence: number, content: string) {
  return envelope(acceptedSequence, {
    type: "item.recorded",
    item: {
      id: itemId, threadId: "thread-1", turnId: "turn-1", kind: "message", providerIdentities: [],
      payload: { projection: "assistantText", content, isStreaming: true }, createdAt: NOW, updatedAt: NOW,
    },
  });
}

function appended(acceptedSequence: number, offset: number, text: string) {
  return envelope(acceptedSequence, { type: "item.content-appended", offset, text, updatedAt: NOW });
}

function reduceAll(events: ReturnType<typeof envelope>[]): AgentModelState {
  const reduction = reduceAgentEventBatch(createAgentModelState(), events);
  if (reduction.outcome !== "applied") throw new Error(`rejected ${reduction.eventId}: ${reduction.reason}`);
  return reduction.state;
}

function compactIdentity(state: AgentModelState): AgentModelState {
  return { ...state, appliedEventIds: {}, acceptedInputEventIds: {} };
}

function contentOf(state: AgentModelState): unknown {
  return state.items[itemId]?.payload.content;
}

describe("item content append", () => {
  it("extends content at its current length and keeps the rest of the payload", () => {
    const state = reduceAll([recorded(1, "Part"), appended(2, 4, "ial")]);

    expect(state.items[itemId]?.payload).toEqual({ projection: "assistantText", content: "Partial", isStreaming: true });
  });

  it("treats a replay of the newest append after identity compaction as a duplicate", () => {
    const state = compactIdentity(reduceAll([recorded(1, "Part"), appended(2, 4, "ial")]));

    const replay = reduceAgentEvent(state, appended(2, 4, "ial"));

    expect(replay.outcome).toBe("duplicate");
    expect(contentOf(replay.state)).toBe("Partial");
  });

  it("rejects an older replay after identity compaction by sequence, before any offset check", () => {
    const state = compactIdentity(reduceAll([recorded(1, "Part"), appended(2, 4, "ial"), appended(3, 7, "ly")]));

    const replay = reduceAgentEvent(state, appended(2, 4, "ial"));

    expect(replay.outcome).toBe("sequence-conflict");
    expect(contentOf(replay.state)).toBe("Partially");
  });

  it("rejects an append onto a different base as a routing conflict", () => {
    const state = reduceAll([recorded(1, "Part")]);

    expect(reduceAgentEvent(state, appended(2, 3, "ial")).outcome).toBe("routing-conflict");
    expect(reduceAgentEvent(state, appended(2, 5, "ial")).outcome).toBe("routing-conflict");
    expect(reduceAgentEvent(state, appended(2, 2, "xx")).outcome).toBe("routing-conflict");
  });

  it("rejects an append to a missing item or one in another turn", () => {
    expect(reduceAgentEvent(createAgentModelState(), appended(1, 0, "a")).outcome).toBe("routing-conflict");

    const state = reduceAll([recorded(1, "Part")]);
    const otherTurn = CanonicalAgentSemanticEnvelopeSchema.parse({
      ...appended(2, 4, "ial"), routing: { ...routing, turnId: "turn-2" },
    });
    expect(reduceAgentEvent(state, otherTurn).outcome).toBe("routing-conflict");
  });

  it("rejects an append to an item whose content is not a string", () => {
    const state = reduceAll([envelope(1, {
      type: "item.recorded",
      item: { id: itemId, threadId: "thread-1", turnId: "turn-1", kind: "message", providerIdentities: [],
        payload: { projection: "message", message: { content: "Done" } }, createdAt: NOW, updatedAt: NOW },
    })]);

    expect(reduceAgentEvent(state, appended(2, 0, "a")).outcome).toBe("routing-conflict");
  });

  it("still reduces a stream stored as whole item.recorded replacements, then continues it by append", () => {
    const state = reduceAll([recorded(1, "P"), recorded(2, "Part"), recorded(3, "Partial"), appended(4, 7, "ly")]);

    expect(contentOf(state)).toBe("Partially");
  });

  it("joins chunks that split a surrogate pair into the original code points", () => {
    const answer = "ok \u{1F600} done";
    const split = answer.indexOf("\u{1F600}") + 1;

    const state = reduceAll([recorded(1, answer.slice(0, split)), appended(2, split, answer.slice(split))]);

    expect(contentOf(state)).toBe(answer);
    expect([...String(contentOf(state))]).toContain("\u{1F600}");
  });

  it("rejects an empty append text at the schema", () => {
    expect(() => appended(2, 4, "")).toThrow();
  });
});
