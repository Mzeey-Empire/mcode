import type { TurnFailure } from "@mcode/contracts";
import { ACP_AUTH_REQUIRED_CODE, acpRequestErrorCode } from "../../protocols/acp/acp-request-error.js";
import { cursorHttpStatus, isLikelyTransientCursorPromptFailure } from "./cursor-acp-transient-retry.js";
import { cursorSessionRecoveryErrorMessage } from "./cursor-session-recovery-error.js";

// Cursor sends no structured quota signal over ACP; this phrase in its error
// text is the only hint that the plan limit, not a burst limit, was hit.
const CURSOR_USAGE_LIMIT_RE = /\busage limit\b/i;

/** Classifies a failed Cursor ACP turn into the provider-neutral failure shape. */
export function classifyCursorFailure(error: unknown): TurnFailure {
  const acpCode = acpRequestErrorCode(error);
  if (acpCode === ACP_AUTH_REQUIRED_CODE) return { kind: "auth", code: String(acpCode) };
  const message = cursorSessionRecoveryErrorMessage(error);
  const status = cursorHttpStatus(message);
  return {
    kind: cursorFailureKind(message),
    ...(status === undefined ? {} : { status }),
    ...(acpCode === undefined ? {} : { code: String(acpCode) }),
  };
}

function cursorFailureKind(message: string): TurnFailure["kind"] {
  if (CURSOR_USAGE_LIMIT_RE.test(message)) return "usage_limit";
  if (isLikelyTransientCursorPromptFailure(message)) return "retryable";
  return "fatal";
}
