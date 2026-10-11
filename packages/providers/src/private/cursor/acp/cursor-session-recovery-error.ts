import { describeAcpError } from "../../protocols/acp/acp-request-error.js";
import { SessionRecoveryFailedError } from "../../protocols/acp/acp-session-runtime.js";

const CURSOR_SESSION_RECOVERY_FAILED_MESSAGE =
  "SessionRecoveryFailed: Cursor could not recover the saved session. Retry starts a new Cursor session.";

/** Returns the user-visible message for a Cursor failure, including ACP error data. */
export function cursorSessionRecoveryErrorMessage(error: unknown): string {
  return error instanceof SessionRecoveryFailedError
    ? CURSOR_SESSION_RECOVERY_FAILED_MESSAGE
    : describeAcpError(error);
}
