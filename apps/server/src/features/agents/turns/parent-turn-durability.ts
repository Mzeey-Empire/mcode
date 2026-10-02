import type {
  Message,
  NarrativeEntry,
  ParentNarrativeRecoveryItem,
  ProviderIdentity,
  TurnOutcome,
} from "@mcode/contracts";
import type { CanonicalAgentBoundary } from "../canonical/canonical-agent-boundary.js";

/** The parent-turn records needed to begin one provider execution. */
export interface ParentTurnStartInput {
  thread: {
    id: string;
    workspaceId: string;
    providerId: string;
    createdAt: string;
  };
  turnId: string;
  executionId: string;
  permissionMode: "supervised" | "full";
  approvalReviewMode?: "manual" | "automatic";
  approvalReviewReason?: string;
  providerIdentities: readonly ProviderIdentity[];
  retryOfExecutionId?: string;
  projectUserMessage: () => Message;
}

/** The durable result of a parent-turn commit. */
export interface ParentTurnCommitResult {
  outcome: "committed" | "duplicate" | "conflict" | "terminal-outcome-confirmed" | "ingest-overflow";
}

/** The compatibility projection committed with a terminal parent turn. */
export interface ParentTurnProjection {
  message: Message | null;
  narrative: readonly NarrativeEntry[];
}

/** The terminal records needed to finish one parent execution. */
export interface ParentTurnFinishInput {
  threadId: string;
  turnId: string;
  executionId: string;
  providerId: string;
  providerIdentities: readonly ProviderIdentity[];
  outcome: TurnOutcome;
  error?: string;
  projectTurn: () => ParentTurnProjection;
  finalizeCompatibility?: () => void;
}

/** The durable checkpoint state used to fence parent terminalization. */
export interface ParentTurnCheckpoint {
  terminalOutcome: TurnOutcome | null;
}

/** The durable terminal projection used to replay post-commit effects. */
export interface ParentTurnTerminalProjection {
  message: Message | null;
  toolCallCount: number;
}

/** The structured narrative state stored before its source event reaches the renderer. */
export interface ParentNarrativeRecoveryCommit {
  executionId: string;
  items: readonly ParentNarrativeRecoveryItem[];
  discardedItemIds?: readonly string[];
}

/** The recovery inputs for an unfinished parent execution. */
export interface ParentTurnInterruptionInput {
  executionId: string;
  reason: string;
  recoveryIncidentId?: string;
  endedAt?: string;
  stagedAssistant?: Message;
  finalizeCompatibility?: (
    assistant: Message,
    narrative: readonly ParentNarrativeRecoveryItem[],
  ) => void;
  recoveredNarrative?: readonly ParentNarrativeRecoveryItem[];
}

/** Durable parent-turn operations that orchestration can receive by construction. */
export type ParentTurnDurability = Pick<CanonicalAgentBoundary,
  "startParentTurn" | "finishParentTurnBatched" | "interruptUnfinishedExecution"
  | "loadTurnByExecution" | "loadParentTurnUserMessage" | "loadThread" | "loadCheckpoint" | "loadTerminalProjection"
  | "recordNativeCursor" | "recordParentNarrativeRecovery" | "classifyParentNarrativeRecovery" | "recordProviderDiagnostic"
  | "recordSynthesizedPublications">;

/** Injection token for parent-turn durability. */
export const PARENT_TURN_DURABILITY = Symbol("ParentTurnDurability");
