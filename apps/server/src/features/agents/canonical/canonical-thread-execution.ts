import { v5 as uuidv5 } from "uuid";

/** Stable execution identity for canonical publications which belong to a thread without a turn. */
export function syntheticThreadExecutionId(threadId: string): string {
  if (!threadId || threadId.length > 256) throw new Error("Canonical thread execution requires a bounded thread ID");
  return uuidv5(`mcode:canonical-thread-execution:${threadId}`, uuidv5.URL);
}
