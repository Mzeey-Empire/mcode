import type { PlanVersion, PlanVersionStatus } from "@mcode/contracts";

const statusOrder: Record<PlanVersionStatus, number> = { draft: 0, ready: 0, superseded: 1, accepted: 2 };

/** Preserves accepted progress while taking mutable user content from committed rows. */
export function mergePlanVersions(memory: readonly PlanVersion[], saved: readonly PlanVersion[]): PlanVersion[] {
  const merged = new Map(memory.map((plan) => [plan.id, plan]));
  for (const row of saved) {
    const current = merged.get(row.id);
    if (!current) { merged.set(row.id, row); continue; }
    const later = statusOrder[current.status] > statusOrder[row.status] ? current : row;
    merged.set(row.id, { ...row,
      status: later.status, acceptedAt: later.acceptedAt, acceptedMessageId: later.acceptedMessageId,
      updatedAt: later.updatedAt > row.updatedAt ? later.updatedAt : row.updatedAt,
    });
  }
  return [...merged.values()].sort((a, b) => a.version - b.version);
}
