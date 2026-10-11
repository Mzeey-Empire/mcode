import type { TurnFailure } from "@mcode/contracts";
import { ACP_AUTH_REQUIRED_CODE, acpRequestErrorCode } from "../../protocols/acp/acp-request-error.js";
import { cursorHttpStatus, isLikelyTransientCursorPromptFailure } from "./cursor-acp-transient-retry.js";
import { cursorSessionRecoveryErrorMessage } from "./cursor-session-recovery-error.js";

/** Classifies a failed Cursor ACP turn into the provider-neutral failure shape. */
export function classifyCursorFailure(error: unknown): TurnFailure {
  const acpCode = acpRequestErrorCode(error);
  if (acpCode === ACP_AUTH_REQUIRED_CODE) return { kind: "auth", code: String(acpCode) };
  const message = cursorSessionRecoveryErrorMessage(error);
  const status = cursorHttpStatus(message);
  return {
    kind: isLikelyTransientCursorPromptFailure(message) ? "retryable" : "fatal",
    ...(status === undefined ? {} : { status }),
    ...(acpCode === undefined ? {} : { code: String(acpCode) }),
  };
}

/** A Cursor turn that stopped with `end_turn` but closed on Cursor's own failure notice. */
export interface CursorEndTurnNotice {
  /** Assistant text written before the notice, trimmed. */
  reply: string;
  notice: string;
  failure: TurnFailure;
}

const NOTICE_SEPARATOR = "\n\n";

// cursor-agent's ACP prompt handler never rejects on account failures: it
// appends one of these fixed chunks and returns stopReason "end_turn". Copied
// verbatim from cursor-agent 2026.04.29-c83a488. "upgrade" covers both plan
// usage limits and rate limits, because Cursor maps them to the same action.
const CURSOR_END_TURN_NOTICES: ReadonlyMap<string, TurnFailure> = new Map([
  ["Please sign in to continue", { kind: "auth", code: "login" }],
  [
    "Error: [unauthenticated] Backend rejected authentication. Verify this is a User API Key for the same endpoint/environment, then rerun with --debug for request-level auth logs.",
    { kind: "auth", code: "unauthenticated" },
  ],
  ["Upgrade your plan to continue", { kind: "usage_limit", code: "upgrade" }],
  ["Add a payment method to continue", { kind: "usage_limit", code: "payment" }],
  ["Check your settings to continue", { kind: "fatal", code: "config" }],
]);

/**
 * Detects Cursor's account-failure notice at the end of an `end_turn` reply.
 * Matches only the exact final paragraph, so a reply that merely quotes a
 * notice mid-text still completes normally.
 */
export function classifyCursorEndTurnNotice(assistantText: string): CursorEndTurnNotice | undefined {
  const separator = assistantText.lastIndexOf(NOTICE_SEPARATOR);
  if (separator < 0) return undefined;
  const notice = assistantText.slice(separator + NOTICE_SEPARATOR.length);
  const failure = CURSOR_END_TURN_NOTICES.get(notice);
  if (!failure) return undefined;
  return { reply: assistantText.slice(0, separator).trim(), notice, failure };
}
