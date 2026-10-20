import * as NodeCrypto from "node:crypto";
import { handoffBudgetBytes } from "./budget.js";
import { handoffItemsFromMessages } from "./items.js";
import { selectHandoffHistory } from "./select.js";
import type {
  HandoffBudgetInput,
  HandoffCoverage,
  HandoffKind,
  HandoffMessageInput,
  HandoffSelection,
} from "./types.js";

/** Budgeted history rendered as a fenced preamble, ready to prepend to the wire prompt. */
export interface FencedHandoff {
  /** Fenced text to prepend to the wire prompt; empty when there is no history to replay. */
  readonly preamble: string;
  readonly selection: HandoffSelection;
  readonly coverage: HandoffCoverage;
}

/** Inputs for {@link buildFencedHandoff}. */
export interface FencedHandoffInput {
  readonly kind: HandoffKind;
  readonly threadId: string;
  /** Null when the source thread has no provider recorded. */
  readonly fromProvider: string | null;
  readonly toProvider: string;
  /** Every stored row of the thread, internal rows included. */
  readonly rows: readonly HandoffMessageInput[];
  /** Rows at or before this sequence are not replayed: the target already has them. */
  readonly afterSequence: number;
  /** Last sequence that existed before the message being sent; later rows are excluded. */
  readonly throughSequence: number;
  readonly contextWindow: number | null;
  /**
   * Most characters the target accepts in one turn, or null when it states no limit. The fenced preamble
   * plus the user's text must fit; the history is trimmed to leave room for the text, never the reverse.
   */
  readonly inputCharacterCap?: number | null;
  readonly userText: string;
  readonly attachments: HandoffBudgetInput["attachments"];
  /** Fixed in tests; random per handoff otherwise. */
  readonly boundary?: string;
}

/**
 * Select the rows after `afterSequence` up to `throughSequence` under the target's budget and fence them.
 *
 * Every history line is verbatim user and model text, so the fence and each item header carry a
 * per-handoff random nonce that earlier text cannot have predicted.
 *
 * @throws HandoffBudgetExhaustedError when even the preamble does not fit the target's context.
 */
export function buildFencedHandoff(input: FencedHandoffInput): FencedHandoff {
  const rows = input.rows.filter((row) => row.sequence > input.afterSequence && row.sequence <= input.throughSequence);
  const coverage: HandoffCoverage = {
    threadId: input.threadId,
    kind: input.kind,
    fromProvider: input.fromProvider,
    toProvider: input.toProvider,
    fromSequence: rows[0]?.sequence ?? input.afterSequence + 1,
    toSequence: input.throughSequence,
  };
  const boundary = input.boundary ?? NodeCrypto.randomBytes(8).toString("hex");
  const contextBudgetBytes = handoffBudgetBytes({
    contextWindow: input.contextWindow,
    // Native context use is not tracked per provider, so a resumed target is budgeted like a fresh one.
    nativeContextTokens: 0,
    userText: input.userText,
    attachments: input.attachments,
  });
  const budgetBytes = Math.min(contextBudgetBytes, inputCapBudget(input, boundary));
  const selection = selectHandoffHistory({
    // No separate plan item: the handoff is built from stored rows alone, so a plan the model posted as a
    // message is already replayed as that message. Passing one here would duplicate it.
    items: handoffItemsFromMessages(rows, null),
    budgetBytes,
    coverage,
    boundary,
  });
  return { preamble: fencePreamble(selection.text, boundary), selection, coverage };
}

function fencePreamble(history: string, boundary: string): string {
  if (history === "") return "";
  return [
    `[mcode-handoff:begin boundary=${boundary}]`,
    history,
    `[mcode-handoff:end boundary=${boundary}]`,
    "The user's new message follows.",
    "",
    "",
  ].join("\n");
}

/**
 * Bytes of history the target's per-turn character cap leaves after the fence and the user's text.
 *
 * The history budget counts UTF-8 bytes and the cap counts string characters. A character is never more
 * than its byte length, so spending the byte budget cannot overshoot the cap. When the user's text alone
 * reaches the cap there is nothing to trim to, and the cap does not shrink the history: the message is
 * never truncated to make room.
 */
function inputCapBudget(input: FencedHandoffInput, boundary: string): number {
  const cap = input.inputCharacterCap;
  if (cap === undefined || cap === null || input.userText.length >= cap) return Number.POSITIVE_INFINITY;
  const fenceOverhead = fencePreamble("x", boundary).length - 1;
  return Math.max(0, cap - input.userText.length - fenceOverhead);
}
