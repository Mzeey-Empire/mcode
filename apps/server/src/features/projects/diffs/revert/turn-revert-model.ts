import { z } from "zod";
import { RawPathStateSchema, samePathState, type PathState } from "../snapshots/snapshot-raw-state.js";

/** Persisted path evidence, written in full before the first filesystem mutation. */
export const RevertPathSchema = z.object({ path: z.string(), previousPath: z.string().optional(),
  action: z.enum(["restore", "delete", "recreate"]), beforeBlob: z.string().nullable(),
  pre: RawPathStateSchema, planned: RawPathStateSchema });
/** One journaled path. */
export type RevertPath = z.infer<typeof RevertPathSchema>;
/** Missing planned evidence is recoverable as an unresolved path, never permission to write. */
export const RecoveryPathSchema = RevertPathSchema.extend({ planned: RawPathStateSchema.nullish() });
/** Read-side evidence may be incomplete; new journal writes still require both states. */
export type RecoveryPath = z.infer<typeof RecoveryPathSchema>;
/** A semantically invalid request, distinguished from an execution or filesystem failure. */
export class TurnRevertValidationError extends Error {
  readonly code = "INVALID_PARAMS";
}
/** Journal state with explicit allowed transitions. */
export type RevertState = "prepared" | "committed" | "rolled_back" | "recovery_failed";
/** Enforce the journal's terminal and retryable states in the database writer. */
export function transitionRevert(from: RevertState, to: RevertState): RevertState {
  if (from === "prepared" && to !== "prepared") return to;
  if (from === "recovery_failed" && (to === "rolled_back" || to === "recovery_failed")) return to;
  throw new Error(`Invalid revert transition: ${from} to ${to}`);
}
/** Recovery distinguishes evidence that authorizes a write from a later edit or lost evidence. */
export type RecoveryDecision = { kind: "equal_pre" } | { kind: "equal_planned" } | { kind: "changed" } | { kind: "not_provable" };
/** Shared by rollback and restart recovery; filtered Git ids never enter this decision. */
export function classifyRecovery(current: PathState, entry: RecoveryPath, materialAvailable: boolean): RecoveryDecision {
  if (samePathState(current, entry.pre)) return { kind: "equal_pre" };
  if (!entry.planned) return { kind: "not_provable" };
  if (!samePathState(current, entry.planned)) return { kind: "changed" };
  return { kind: materialAvailable ? "equal_planned" : "not_provable" };
}

/** Information needed to recover without consulting snapshots that may have expired. */
export const RevertContextSchema = z.object({
  request: z.string(), cwd: z.string(), lockCwd: z.string().optional(), snapshotIds: z.array(z.string()), label: z.string(),
});
