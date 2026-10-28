import "reflect-metadata";
import type { CanonicalAgentEventEnvelope } from "@mcode/contracts/compat/agent-model";
import { vi } from "vitest";
import { AgentEventSchema, type AgentEvent } from "@mcode/contracts/events/agent-event";
import { CanonicalAgentProgressFrameSchema } from "@mcode/contracts/models/canonical-agent-progress";
import * as push from "../../../../application/transport/push.js";

export function observeWorkerPublications(
  publish: (event: AgentEvent) => void,
  threadIds: () => string[],
  saved?: (events: readonly CanonicalAgentEventEnvelope[]) => void,
): () => void {
  const broadcast = push.broadcast;
  const forward = vi.isMockFunction(broadcast) ? broadcast.getMockImplementation() : broadcast;
  const broadcastSpy = vi.spyOn(push, "broadcast").mockImplementation((...args: Parameters<typeof push.broadcast>) => {
    if (args[0] === "agent.canonical") {
      const frame = CanonicalAgentProgressFrameSchema().parse(args[1]);
      if (frame.phase === "saved") saved?.(frame.events);
      if (frame.phase === "accepted") {
        for (const envelope of frame.events) {
          if (envelope.payload.type === "publication.recorded" && envelope.payload.event.type !== "turnStarted") {
            publish(AgentEventSchema().parse(envelope.payload.event));
          }
        }
      }
    }
    forward?.(...args);
  });
  const subscriptions = vi.spyOn(push, "subscribedThreadIds").mockImplementation(() => new Set(threadIds()));
  return () => {
    subscriptions.mockRestore();
    broadcastSpy.mockRestore();
  };
}
