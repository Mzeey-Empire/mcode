import * as NodeCrypto from "node:crypto";
import type { IAgentProvider } from "@mcode/contracts";
import { CODEX_INLINE_INPUT_MAX_CHARS } from "../artifacts/handoff-builder.js";
import { handoffBudgetBytes } from "./budget.js";
import { handoffItemsFromMessages } from "./items.js";
import { selectHandoffHistory } from "./select.js";
import type { HandoffBudgetInput, HandoffCoverage, HandoffMessageInput, HandoffSelection } from "./types.js";

/**
 * Most user turns a resumed native session may have missed before replaying a delta stops being
 * cheaper than starting fresh with the full history.
 */
export const MAX_DELTA_TURNS = 20;

/** Whether the target keeps its native session or starts over. */
export type SwitchHandoffMode = "delta" | "fresh";

/** History sent with the first message after a provider switch or fork. */
export interface SwitchHandoffPlan {
  readonly mode: SwitchHandoffMode;
  /** Fenced text to prepend to the wire prompt; empty when there is no history to replay. */
  readonly preamble: string;
  readonly selection: HandoffSelection;
  readonly coverage: HandoffCoverage;
}

/** Inputs for {@link planSwitchHandoff}. */
export interface SwitchHandoffInput {
  readonly kind?: "switch" | "fork";
  readonly threadId: string;
  readonly fromProvider: string | null;
  readonly toProvider: string;
  /** Every stored row of the thread, internal rows included. */
  readonly rows: readonly HandoffMessageInput[];
  /** Last sequence that existed before the message being sent; later rows are excluded. */
  readonly throughSequence: number;
  /**
   * Highest sequence the target's resumable native session has already seen, or null when the
   * target has no session to resume.
   */
  readonly resumeWatermark: number | null;
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

function userTurnsSince(rows: readonly HandoffMessageInput[], watermark: number): number {
  return rows.filter((row) => row.role === "user" && !row.isInternal && row.sequence > watermark).length;
}

/**
 * Choose delta or fresh delivery and render the budgeted, fenced history preamble.
 *
 * A fresh target gets every row up to `throughSequence`; a resumed target gets only rows after its
 * watermark. Every history line is verbatim user and model text, so the fence and each item header
 * carry a per-handoff random nonce that earlier text cannot have predicted.
 *
 * @throws HandoffBudgetExhaustedError when even the preamble does not fit the target's context.
 */
export function planSwitchHandoff(input: SwitchHandoffInput): SwitchHandoffPlan {
  const prior = input.rows.filter((row) => row.sequence <= input.throughSequence);
  const resumable = input.resumeWatermark !== null
    && userTurnsSince(prior, input.resumeWatermark) <= MAX_DELTA_TURNS;
  const mode: SwitchHandoffMode = resumable ? "delta" : "fresh";
  const afterSequence = resumable ? input.resumeWatermark ?? 0 : 0;
  const rows = prior.filter((row) => row.sequence > afterSequence);

  const coverage: HandoffCoverage = {
    threadId: input.threadId,
    kind: input.kind ?? "switch",
    fromProvider: input.fromProvider,
    toProvider: input.toProvider,
    fromSequence: rows[0]?.sequence ?? afterSequence + 1,
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
    // No separate plan item: history is built from stored rows alone, so a plan the model posted as a
    // message is already replayed as that message. Passing one here would duplicate it.
    items: handoffItemsFromMessages(rows, null),
    budgetBytes,
    coverage,
    boundary,
  });
  return { mode, preamble: fencePreamble(selection.text, boundary), selection, coverage };
}

/** Apply the adapter's turn limit and Codex's inline delivery ceiling consistently. */
export function handoffInputCharacterCap(target: Pick<IAgentProvider, "id" | "maxInputCharactersPerTurn">): number {
  return target.id === "codex"
    ? Math.min(target.maxInputCharactersPerTurn, CODEX_INLINE_INPUT_MAX_CHARS)
    : target.maxInputCharactersPerTurn;
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
function inputCapBudget(input: SwitchHandoffInput, boundary: string): number {
  const cap = input.inputCharacterCap;
  if (cap === undefined || cap === null || input.userText.length >= cap) return Number.POSITIVE_INFINITY;
  const fenceOverhead = fencePreamble("x", boundary).length - 1;
  return Math.max(0, cap - input.userText.length - fenceOverhead);
}
