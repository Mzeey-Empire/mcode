import { z } from "zod";

const TurnRecoveryErrorCodeSchema = z.enum([
  "TURN_RECOVERY_NOT_FOUND",
  "TURN_RECOVERY_NOT_LATEST",
  "TURN_RECOVERY_RUNNING",
  "TURN_RECOVERY_STARTUP_ACTIVE",
  "TURN_RECOVERY_NOT_ERRORED",
  "TURN_RECOVERY_NOT_INTERRUPTED",
  "TURN_RECOVERY_CONFLICT",
  "TURN_RECOVERY_INPUT_MISSING",
  "TURN_RECOVERY_NOT_ADMITTED",
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
