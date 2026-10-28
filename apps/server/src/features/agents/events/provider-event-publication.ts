import { providerFailureOutcome } from "@mcode/contracts/models/turn-failure";
import { type AgentEvent } from "@mcode/contracts/events/agent-event";
import { type TurnOutcome } from "@mcode/contracts/models/turn-outcome";

/** Dependencies used to publish one normalized provider event to the parent UI. */
export interface ParentProviderEventPublicationDeps {
  recordTurnOutcome: (threadId: string, outcome: TurnOutcome) => void;
  publishThreadStatus: (payload: { threadId: string; status: "completed" | "errored" | "interrupted" }) => void;
}

/** Apply the status transition of a publishable normalized provider event. */
export function publishParentProviderEvent(
  event: AgentEvent,
  deps: ParentProviderEventPublicationDeps,
): boolean {
  if (!shouldPublishParentEvent(event)) return false;
  // A semantic writer committed this status before releasing its terminal event.
  // A late replay must not overwrite the status of a newer execution.
  if (event.publicationId !== undefined) return true;
  if (event.type === "turnComplete") {
    deps.recordTurnOutcome(event.threadId, "completed");
    deps.publishThreadStatus({ threadId: event.threadId, status: "completed" });
  } else if (event.type === "error") {
    const outcome = providerFailureOutcome(event.failure);
    deps.recordTurnOutcome(event.threadId, outcome);
    deps.publishThreadStatus({ threadId: event.threadId, status: outcome });
  } else if (event.type === "ended" && event.outcome !== undefined) {
    const status = event.outcome === "completed"
      ? "completed"
      : event.outcome === "errored"
        ? "errored"
        : "interrupted";
    deps.recordTurnOutcome(event.threadId, event.outcome);
    deps.publishThreadStatus({ threadId: event.threadId, status });
  }
  return true;
}

/** An Ended that reports no outcome because the provider lost its stream; a stop or recovery settles the turn instead. */
export function isLostProviderStream(event: AgentEvent): boolean {
  return event.type === "ended" && event.outcome === undefined && event.reason === "provider_lost";
}

function shouldPublishParentEvent(event: AgentEvent): boolean {
  if (event.type === "generatedAttachment") return false;
  return event.type !== "ended"
    || event.outcome !== undefined
    || event.reason === "provider_lost";
}
