import type { CanonicalAgentEventEnvelope, CanonicalAgentRevision } from "@mcode/contracts";
import type { SavedProgressReceipt } from "../execution/thread-progress-types.js";
import type { CanonicalProviderProjection } from "./canonical-provider-projection.js";
import type { CanonicalAcceptedWriteInput } from "./canonical-accepted-write.js";
import type { ExecutionSemanticOperation, ExecutionWriteReceipt } from "../execution/execution-worker-handler.js";
import type { LostExecutionInterruption } from "./canonical-execution-semantic-writer.js";
import type {
  CanonicalAgentCommitInput,
  CanonicalAgentCommitResult,
  CanonicalAgentEventDraft,
  ParentNarrativeRecoveryCommitInput,
} from "./canonical-agent-boundary.js";

/** Upper bound for one committed semantic publication message. */
export const SEMANTIC_PUBLICATION_PAGE_SIZE = 64;

/** Cloneable provider batch accepted by the SQLite writer. Compatibility callbacks stay with their owner. */
export type CanonicalProviderWriteInput = Pick<
  CanonicalAgentCommitInput,
  "threadId" | "turnId" | "executionId" | "phase" | "nativeCursor"
> & { events: readonly CanonicalAgentEventDraft[] };

/** Acknowledgement returned only after the canonical SQLite transaction has committed. */
export interface CanonicalProviderWriteReceipt {
  outcome: CanonicalAgentCommitResult["outcome"];
  conversationRevision: number;
  rosterRevision: number;
  acceptedThrough: number;
  durableThrough: number;
  events: readonly CanonicalAgentEventEnvelope[];
  providerProjection?: CanonicalProviderProjection;
}

/** A provider-facing commit also certifies worker-local interpretation of its native events. */
export type CanonicalProjectedProviderWriteReceipt = CanonicalProviderWriteReceipt & {
  providerProjection: CanonicalProviderProjection;
};

/** Only a committed append may certify the saved position of an accepted batch. */
export interface CanonicalAcceptedWriteReceipt {
  readonly receipt: SavedProgressReceipt;
  readonly revision: CanonicalAgentRevision;
  readonly events: readonly CanonicalAgentEventEnvelope[];
}

/** Acknowledges completed recovery writes; false means the execution was not found. */
export interface CanonicalParentNarrativeRecoveryReceipt {
  recorded: boolean;
}

/** Both writes are acknowledged only after their shared transaction commits. */
export interface CanonicalParentNarrativeClassificationReceipt {
  recorded: true;
  reset: true;
}

interface Correlation {
  requestId: string;
  operationId: string;
  executionId: string;
}

export type CanonicalWriterRequest =
  | (Correlation & { kind: "open"; dbPath: string; bootstrap?: boolean })
  | (Correlation & { kind: "commit"; input: CanonicalProviderWriteInput; projectProviderEvents?: true })
  | (Correlation & { kind: "append-accepted"; input: CanonicalAcceptedWriteInput })
  | (Correlation & { kind: "semantic-transact"; operation: ExecutionSemanticOperation })
  | (Correlation & { kind: "semantic-worker-loss"; input: LostExecutionInterruption })
  | (Correlation & { kind: "record-parent-narrative-recovery"; input: ParentNarrativeRecoveryCommitInput })
  | (Correlation & { kind: "classify-parent-narrative-recovery"; input: ParentNarrativeRecoveryCommitInput })
  | (Correlation & { kind: "ack-operation" })
  | (Correlation & { kind: "close" });

export type CanonicalWriterResponse =
  | (Correlation & { kind: "opened" })
  | (Correlation & { kind: "committed"; receipt: CanonicalProviderWriteReceipt })
  | (Correlation & { kind: "accepted-appended"; result: CanonicalAcceptedWriteReceipt })
  | (Correlation & { kind: "semantic-publication"; events: readonly CanonicalAgentEventEnvelope[] })
  | (Correlation & { kind: "semantic-transacted"; receipt: ExecutionWriteReceipt })
  | (Correlation & { kind: "parent-narrative-recovery-recorded"; receipt: CanonicalParentNarrativeRecoveryReceipt })
  | (Correlation & { kind: "parent-narrative-recovery-classified"; receipt: CanonicalParentNarrativeClassificationReceipt })
  | (Correlation & { kind: "operation-acknowledged" })
  | (Correlation & { kind: "closed" })
  | (Correlation & { kind: "failed"; reason: "open-failed" | "write-failed" | "operation-conflict" | "receipt-capacity";
      failure?: { name: string; message: string; code?: string } });
