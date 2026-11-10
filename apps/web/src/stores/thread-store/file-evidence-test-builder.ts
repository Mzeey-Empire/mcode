import type { TurnFileEvidence, TurnFileEvidenceEvent } from "@mcode/contracts/models/turn-file-evidence";

/** Test builder for one execution's `turn.fileEvidence` publication. */
export function createFileEvidenceEvent(
  evidence: TurnFileEvidence,
  overrides: Partial<Omit<TurnFileEvidenceEvent, "evidence">> = {},
): TurnFileEvidenceEvent {
  return {
    threadId: "thread-1",
    turnId: "turn-1",
    executionId: "execution-1",
    messageId: "assistant-1",
    ...overrides,
    evidence,
  };
}
