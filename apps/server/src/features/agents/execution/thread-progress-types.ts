import type { CanonicalAgentEventDraft } from "../canonical/canonical-agent-boundary.js";
import type { ExecutionIdentity } from "./execution-mailbox-protocol.js";

/** One position in a runtime's immutable, thread-ordered progress stream. */
export interface ThreadProgressPosition {
  readonly epoch: string;
  readonly sequence: number;
}

/** Semantic acceptance carries no claim that a disk write has happened. */
export interface AcceptedProgressEvent {
  readonly draft: CanonicalAgentEventDraft;
  readonly acceptedSequence: number;
  readonly position: ThreadProgressPosition;
  readonly acceptedAt: string;
}

/** Data retained once for live delivery, saving, retry, and reconnect. */
export interface AcceptedProgressBatch<WriteIntent> {
  readonly operationId: string;
  readonly execution: ExecutionIdentity;
  readonly contentHash: string;
  readonly predecessor: ThreadProgressPosition;
  readonly through: ThreadProgressPosition;
  readonly events: readonly AcceptedProgressEvent[];
  readonly write: WriteIntent;
  readonly byteLength: number;
  readonly admission: "progress" | "control";
}

/** A receipt acknowledges this exact operation after its transaction commits. */
export interface SavedProgressReceipt {
  readonly operationId: string;
  readonly contentHash: string;
  readonly predecessor: ThreadProgressPosition;
  readonly through: ThreadProgressPosition;
  readonly durableRevision: number;
}

/** Saving health never changes the execution's provider outcome. */
export type ThreadProgressSavingState =
  | { readonly kind: "saved"; readonly through: ThreadProgressPosition; readonly durableRevision: number }
  | { readonly kind: "saving"; readonly saved: ThreadProgressPosition; readonly accepted: ThreadProgressPosition; readonly durableRevision: number }
  | { readonly kind: "delayed" | "failed"; readonly saved: ThreadProgressPosition; readonly accepted: ThreadProgressPosition; readonly durableRevision: number; readonly operationId: string; readonly error: Error };

/** Retention capacity includes queued, in-flight, retrying, and failed writes. */
export interface ProgressRetentionLimits {
  readonly maxEvents: number;
  readonly maxBytes: number;
  readonly reservedControlEvents: number;
  readonly reservedControlBytes: number;
}

/** A reservation remains owned until the contiguous saved prefix passes it. */
export interface ProgressRetentionReservation {
  release(): void;
}

/** Shared admission accounting prevents every thread from filling its own limit. */
export interface ProgressRetentionBudget {
  reserve(events: number, bytes: number, admission: "progress" | "control"): ProgressRetentionReservation | undefined;
}

/** A save error remains an error; retry policy classifies it without replacing it. */
export interface ProgressSaveFailure {
  readonly operationId: string;
  readonly error: Error;
  readonly exhausted: boolean;
}
