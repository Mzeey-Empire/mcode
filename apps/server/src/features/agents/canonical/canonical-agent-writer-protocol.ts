import type { CanonicalAgentEventEnvelope } from "@mcode/contracts";
import type { ExecutionSemanticOperation, ExecutionWriteReceipt } from "../execution/execution-worker-handler.js";
import type { LostExecutionInterruption } from "./canonical-execution-semantic-writer.js";
import type {
  CanonicalAgentCommitInput,
  CanonicalAgentCommitResult,
  CanonicalAgentEventDraft,
  ParentNarrativeRecoveryCommitInput,
} from "./canonical-agent-boundary.js";

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
  | (Correlation & { kind: "open"; dbPath: string })
  | (Correlation & { kind: "commit"; input: CanonicalProviderWriteInput })
  | (Correlation & { kind: "semantic-transact"; operation: ExecutionSemanticOperation })
  | (Correlation & { kind: "semantic-worker-loss"; input: LostExecutionInterruption })
  | (Correlation & { kind: "record-parent-narrative-recovery"; input: ParentNarrativeRecoveryCommitInput })
  | (Correlation & { kind: "classify-parent-narrative-recovery"; input: ParentNarrativeRecoveryCommitInput })
  | (Correlation & { kind: "ack-operation" })
  | (Correlation & { kind: "close" });

export type CanonicalWriterResponse =
  | (Correlation & { kind: "opened" })
  | (Correlation & { kind: "committed"; receipt: CanonicalProviderWriteReceipt })
  | (Correlation & { kind: "semantic-publication"; events: readonly CanonicalAgentEventEnvelope[] })
  | (Correlation & { kind: "semantic-transacted"; receipt: ExecutionWriteReceipt })
  | (Correlation & { kind: "parent-narrative-recovery-recorded"; receipt: CanonicalParentNarrativeRecoveryReceipt })
  | (Correlation & { kind: "parent-narrative-recovery-classified"; receipt: CanonicalParentNarrativeClassificationReceipt })
  | (Correlation & { kind: "operation-acknowledged" })
  | (Correlation & { kind: "closed" })
  | (Correlation & { kind: "failed"; reason: "open-failed" | "write-failed" | "operation-conflict" | "receipt-capacity" });
