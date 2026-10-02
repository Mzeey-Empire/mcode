/** Admission failures identify the exhausted or conflicting live boundary, independently of storage. */
export type ProgressAdmissionFailureReason = "routing-conflict" | "identity-conflict" | "retention-exhausted";

/** A rejected prepared observation has no accepted order or storage claim. */
export class ProgressAdmissionError extends Error {
  name = "ProgressAdmissionError";
  constructor(readonly admissionReason: ProgressAdmissionFailureReason) {
    super(`Accepted progress admission rejected: ${admissionReason}`);
  }
}

/** A provider observation failed before acceptance; its mailbox slot may be checkpointed. */
export class RejectedProviderObservationError extends Error {
  name = "RejectedProviderObservationError";
  constructor(cause: unknown) {
    super("Provider observation rejected before live acceptance", { cause });
  }
}

/** Bounded failure evidence crosses worker IPC without serializing arbitrary thrown objects. */
export interface ExecutionWriterFailure {
  readonly name: string;
  readonly message: string;
  readonly code?: string;
  readonly admissionReason?: ProgressAdmissionFailureReason;
  readonly observationRejected?: true;
  readonly cause?: ExecutionWriterFailure;
}

/** Preserve the original failure and a bounded cause chain at the worker boundary. */
export function executionWriterFailure(cause: unknown, depth = 0): ExecutionWriterFailure {
  const error = cause instanceof Error ? cause : new Error("Execution writer failed");
  return { name: error.name.slice(0, 128), message: error.message.slice(0, 2_000),
    ...("code" in error && typeof error.code === "string" ? { code: error.code.slice(0, 128) } : {}),
    ...(error instanceof ProgressAdmissionError ? { admissionReason: error.admissionReason } : {}),
    ...(error instanceof RejectedProviderObservationError ? { observationRejected: true as const } : {}),
    ...(depth < 3 && error.cause instanceof Error ? { cause: executionWriterFailure(error.cause, depth + 1) } : {}) };
}

/** Restore diagnostic evidence for a failed provider admission, without treating it as progress. */
export function restoreExecutionWriterFailure(failure: ExecutionWriterFailure): Error {
  const error = failure.observationRejected ? new RejectedProviderObservationError(failure.cause ? restoreExecutionWriterFailure(failure.cause) : undefined)
    : failure.admissionReason ? new ProgressAdmissionError(failure.admissionReason)
    : new Error(failure.message, failure.cause ? { cause: restoreExecutionWriterFailure(failure.cause) } : undefined);
  error.name = failure.name;
  if (failure.code) Object.defineProperty(error, "code", { value: failure.code, enumerable: true });
  return error;
}
