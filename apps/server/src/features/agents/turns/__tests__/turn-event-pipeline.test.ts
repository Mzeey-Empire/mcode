import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@mcode/contracts/events/agent-event";
import { TurnEventPipeline } from "../turn-event-pipeline.js";
import type { ProviderEventIngressEvent } from "../../../providers/composition/provider-event-ingress.js";

function committedText(delta: string): ProviderEventIngressEvent {
  return {
    providerId: "claude",
    sourceKind: "worker-commit",
    event: { type: "textDelta", threadId: "thread-1", turnExecutionId: "execution-1", delta },
    canonicalReceipt: {
      eventId: delta, acceptedSequence: 1, durableRevision: 1,
      serverTimestamps: { acceptedAt: "2026-08-28T12:00:00.000Z" },
    },
  };
}

describe("TurnEventPipeline worker publication", () => {
  it("publishes admitted committed output in delivery order", () => {
    const published: AgentEvent[] = [];
    const pipeline = new TurnEventPipeline(
      { normalize: (event) => event },
      { publishCommitted: (event) => published.push(event) },
    );
    pipeline.handleProjectedCommitted(committedText("first"));
    pipeline.handleProjectedCommitted(committedText("second"));
    expect(published).toEqual([
      { type: "textDelta", threadId: "thread-1", turnExecutionId: "execution-1", delta: "first" },
      { type: "textDelta", threadId: "thread-1", turnExecutionId: "execution-1", delta: "second" },
    ]);
  });

  it("withholds committed output rejected by runtime admission", () => {
    const published: AgentEvent[] = [];
    const pipeline = new TurnEventPipeline(
      { normalize: () => undefined },
      { publishCommitted: (event) => published.push(event) },
    );
    pipeline.handleProjectedCommitted(committedText("retired"));
    expect(published).toEqual([]);
  });
});
