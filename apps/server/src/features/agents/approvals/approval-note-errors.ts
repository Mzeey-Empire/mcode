import type { ApprovalNoteAdmissionError } from "@mcode/contracts";

/** Stable admission failure preserved across the database writer boundary. */
export class ApprovalNoteAlreadyDeliveredError extends Error implements ApprovalNoteAdmissionError {
  readonly code = "note_already_delivered";
  constructor() {
    super("This note was already sent or removed");
    this.name = "ApprovalNoteAlreadyDeliveredError";
  }
}

/**
 * True for a refused note claim. The turn-admission claim runs on the database writer, which
 * rebuilds a thrown error as a plain `Error` carrying only its `code`, so the class alone misses it.
 */
export function isApprovalNoteAlreadyDelivered(error: unknown): boolean {
  if (error instanceof ApprovalNoteAlreadyDeliveredError) return true;
  return error instanceof Error && "code" in error && error.code === "note_already_delivered";
}
