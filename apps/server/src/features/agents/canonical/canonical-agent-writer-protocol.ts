import type { CanonicalAgentEventEnvelope } from "@mcode/contracts";
import type { CanonicalAgentCommitInput, CanonicalAgentCommitResult, CanonicalAgentEventDraft } from "./canonical-agent-boundary.js";

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

interface Correlation {
  requestId: string;
  operationId: string;
  executionId: string;
}

export type CanonicalWriterRequest =
  | (Correlation & { kind: "open"; dbPath: string })
  | (Correlation & { kind: "commit"; input: CanonicalProviderWriteInput })
  | (Correlation & { kind: "close" });

export type CanonicalWriterResponse =
  | (Correlation & { kind: "opened" })
  | (Correlation & { kind: "committed"; receipt: CanonicalProviderWriteReceipt })
  | (Correlation & { kind: "closed" })
  | (Correlation & { kind: "failed"; reason: "open-failed" | "write-failed" });
