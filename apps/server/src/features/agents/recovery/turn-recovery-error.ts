import { z } from "zod";

const TurnRecoveryErrorCodeSchema = z.enum([
  "TURN_RETRY_NOT_FOUND",
  "TURN_RETRY_NOT_LATEST",
  "TURN_RETRY_RUNNING",
  "TURN_RETRY_STARTUP_ACTIVE",
  "TURN_RETRY_NOT_ERRORED",
  "TURN_RETRY_CONFLICT",
  "TURN_RETRY_INPUT_MISSING",
  "TURN_RETRY_NOT_ADMITTED",
  "TURN_RETRY_SCHEDULE_INVALID_TIME",
  "TURN_RETRY_SCHEDULE_TOO_FAR",
]);

/** A rejected recovery action with a stable code preserved by the database writer. */
export class TurnRecoveryError extends Error {
  constructor(readonly code: z.infer<typeof TurnRecoveryErrorCodeSchema>, message: string) {
    super(message);
    this.name = "TurnRecoveryError";
  }
}

/** Read recovery codes from local errors or errors reconstructed across the writer boundary. */
export function turnRecoveryErrorCode(error: unknown): TurnRecoveryError["code"] | null {
  if (!(error instanceof Error) || !("code" in error)) return null;
  const parsed = TurnRecoveryErrorCodeSchema.safeParse(error.code);
  return parsed.success ? parsed.data : null;
}
