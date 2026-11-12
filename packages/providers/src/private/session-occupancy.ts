/** Maximum native-task protection after launch or a user turn. */
export const NATIVE_TASK_CAP_MS = 4 * 60 * 60 * 1000;
/** Eviction policy shared by idle and memory-pressure sweeps. */
export interface OccupancyPolicy { idleTtlMs: number; nativeCapMs: number; mode: "idle" | "memory-pressure" }
/** Launch time of native background work. */
export interface NativeTaskAge { startedAt: number }
/** Policy which permits retirement. */
export type EvictionReason = "idle" | "memory-pressure";
/** Decision and counts from one occupancy observation. */
export type OccupancyVerdict = ({ evict: false } | { evict: true; reason: EvictionReason; idleMs: number }) & {
  nativeTasks: number; nativeProtecting: number;
};
/** Facts observed for one pooled session. */
export interface OccupancyInput {
  now: number;
  clock: number;
  turnBusy: boolean;
  nativeTasks: readonly NativeTaskAge[];
  occupancy: { held: boolean; lastActivityAt: number | null; lastUserTurnAt: number | null };
  policy: OccupancyPolicy;
}
/** Agent activity cannot extend a native task's protection window. */
export function nativeProtectsUntil(task: NativeTaskAge, lastUserTurnAt: number | null, capMs: number): number {
  return Math.max(task.startedAt, lastUserTurnAt ?? task.startedAt) + capMs;
}
/** Applies protection before considering the idle clock. */
export function decideOccupancy(input: OccupancyInput): OccupancyVerdict {
  const nativeProtecting = input.nativeTasks.filter((task) => input.now < nativeProtectsUntil(task, input.occupancy.lastUserTurnAt, input.policy.nativeCapMs)).length;
  const counts = { nativeTasks: input.nativeTasks.length, nativeProtecting };
  if (input.turnBusy || input.occupancy.held || nativeProtecting > 0) return { evict: false, ...counts };
  const idleMs = input.now - Math.max(input.clock, input.occupancy.lastActivityAt ?? input.clock);
  if (input.policy.mode === "memory-pressure" || idleMs > input.policy.idleTtlMs) {
    return { evict: true, reason: input.policy.mode, idleMs, ...counts };
  }
  return { evict: false, ...counts };
}
