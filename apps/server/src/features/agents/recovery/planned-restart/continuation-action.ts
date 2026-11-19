/** Identity of a saved turn interrupted by a planned stop. */
export type RecordedTurn = { threadId: string; turnId: string; executionId: string };
/** One continuation per thread. */
export type ContinuationAction =
  | { kind: "resume"; turn: RecordedTurn }
  | { kind: "wake"; threadId: string; anchorTurnId: string; commandIds?: string[] };
