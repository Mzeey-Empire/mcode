/** The operation receiving stored thread history. */
export type HandoffKind = "switch" | "fork" | "recovery";

/** One indivisible piece of history eligible for replay. */
export interface HandoffSourceItem {
  /** Message sequence; null only for the plan item. */
  readonly sequence: number | null;
  readonly role: "user" | "assistant";
  readonly kind: "message" | "tool_activity" | "plan";
  /** Provider that produced the item; null for user messages without one. */
  readonly provider: string | null;
  readonly text: string;
}

/** Stored message fields needed to extract replayable history. */
export interface HandoffMessageRow {
  readonly sequence: number;
  readonly role: string;
  readonly content: string;
  readonly provider: string | null;
  readonly tool_calls: string | null;
  readonly files_changed: string | null;
  readonly is_internal: number;
}

/** Provenance and sequence range covered by a handoff. */
export interface HandoffCoverage {
  readonly threadId: string;
  readonly kind: HandoffKind;
  readonly fromProvider: string | null;
  readonly toProvider: string;
  readonly fromSequence: number;
  readonly toSequence: number;
}

/** Context already occupied or reserved before history is selected. */
export interface HandoffBudgetInput {
  readonly contextWindow: number | null;
  readonly nativeContextTokens: number | null;
  readonly userText: string;
  readonly attachments: ReadonlyArray<{ readonly kind: "image" | "file" }>;
}

/** Whole history items retained within the caller's byte budget. */
export interface HandoffSelection {
  /** Rendered preamble plus selected items; empty string when there are no items. */
  readonly text: string;
  readonly selectedSequences: readonly number[];
  readonly omittedSequences: readonly number[];
  readonly budgetBytes: number;
}
