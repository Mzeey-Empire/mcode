import { buildFencedHandoff, type FencedHandoff, type FencedHandoffInput } from "./fenced-handoff.js";
import type { HandoffMessageInput } from "./types.js";

/**
 * Most user turns a resumed native session may have missed before replaying a delta stops being
 * cheaper than starting fresh with the full history.
 */
export const MAX_DELTA_TURNS = 20;

/** Whether the target keeps its native session or starts over. */
export type SwitchHandoffMode = "delta" | "fresh";

/** History sent with the first message after a provider switch or fork. */
export interface SwitchHandoffPlan extends FencedHandoff {
  readonly mode: SwitchHandoffMode;
}

/** Inputs for {@link planSwitchHandoff}; `rows` and `throughSequence` bound the replayable history. */
export interface SwitchHandoffInput extends Omit<FencedHandoffInput, "kind" | "afterSequence"> {
  /** A fork plans like a fresh switch onto the child's provider; defaults to `switch`. */
  readonly kind?: "switch" | "fork";
  /**
   * Highest sequence the target's resumable native session has already seen, or null when the
   * target has no session to resume.
   */
  readonly resumeWatermark: number | null;
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
  return { mode, ...buildFencedHandoff({ ...input, kind: input.kind ?? "switch", afterSequence }) };
}
