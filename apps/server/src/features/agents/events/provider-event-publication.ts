import type { AgentEvent, TurnOutcome } from "@mcode/contracts";

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
    deps.recordTurnOutcome(event.threadId, "errored");
    deps.publishThreadStatus({ threadId: event.threadId, status: "errored" });
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

function shouldPublishParentEvent(event: AgentEvent): boolean {
  if (event.type === "generatedAttachment") return false;
  return event.type !== "ended"
    || event.outcome !== undefined
    || event.reason === "provider_lost";
}
