import {
  TurnAdmissionFailureSchema,
  type TurnAdmissionFailureReason,
} from "@mcode/contracts/models/turn-admission";

const PROVIDER_UNAVAILABLE_CODES: ReadonlySet<string> = new Set(["PROVIDER_DISABLED", "PROVIDER_CLI_MISSING"]);

/**
 * An admission refusal whose reason does not depend on its message. It keeps
 * the inherited `Error` name so locally shown text stays unchanged.
 */
export class TurnAdmissionError extends Error {
  /** Why the turn was refused. */
  readonly reason: TurnAdmissionFailureReason;

  constructor(reason: TurnAdmissionFailureReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

/**
 * Reads the admission reason from a local {@link TurnAdmissionError}, a
 * provider availability error, or a remote error carrying a validated
 * `TURN_ADMISSION_REJECTED` payload. Never classifies message text; anything
 * else returns `null`.
 */
export function turnAdmissionFailureReason(error: unknown): TurnAdmissionFailureReason | null {
  if (error instanceof TurnAdmissionError) return error.reason;
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  if (typeof error.code === "string" && PROVIDER_UNAVAILABLE_CODES.has(error.code)) return "unavailable";
  if (!("data" in error)) return null;
  const parsed = TurnAdmissionFailureSchema().safeParse({ code: error.code, data: error.data });
  return parsed.success ? parsed.data.data.reason : null;
}
