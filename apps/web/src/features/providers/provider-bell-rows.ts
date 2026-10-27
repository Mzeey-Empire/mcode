import { getCatalogEntry } from "@mcode/contracts/providers/catalog";
import { type ProviderCliUpdate, type ProviderRateLimit, type ProviderStatus } from "@mcode/contracts/providers/provider-status";
import { type ProviderId } from "@mcode/contracts/providers/interfaces";

/** A CLI update the bell can show; `none` never becomes a row. */
export type ProviderBellCliUpdate = Exclude<ProviderCliUpdate, { state: "none" }>;

/** One provider that needs attention in the sidebar bell. */
export type ProviderBellRow = { providerId: ProviderId; name: string } & (
  /** `signInArgv` is the terminal command that signs in. */
  | { kind: "signed_out"; detail: string; signInArgv: readonly string[] }
  | { kind: "rate_limited"; detail: string }
  | { kind: "cli_update"; installed: string | null; update: ProviderBellCliUpdate }
  /** `tryModelId` is the announced model that Try starts the next thread on. */
  | { kind: "new_model"; detail: string; tryModelId: string }
);

/** Row kinds in priority order: a provider shows only its first, and rows sort by it. */
const ROW_KINDS = ["signed_out", "rate_limited", "cli_update", "new_model"] as const satisfies readonly ProviderBellRow["kind"][];

// A Map, not an object literal, so a provider-sent type such as "constructor" cannot hit a prototype member.
const LIMIT_LABELS = new Map([
  ["five_hour", "5-hour limit"],
  ["seven_day", "Weekly limit"],
]);

/**
 * Turns provider statuses into bell rows, at most one per provider. Signed out
 * outranks rate limited, which outranks a CLI update, which outranks a new
 * model, both for one provider and in row order, because each earlier problem
 * blocks threads harder. Unknown auth, past rate limits, and CLIs with no
 * update produce no row.
 */
export function deriveProviderBellRows(statuses: readonly ProviderStatus[], now: Date): ProviderBellRow[] {
  const rows: ProviderBellRow[] = [];
  for (const status of statuses) {
    const row = rowFor(status, now);
    if (row) rows.push(row);
  }
  return rows.sort((a, b) => ROW_KINDS.indexOf(a.kind) - ROW_KINDS.indexOf(b.kind) || runningLast(a) - runningLast(b));
}

// A running update has no action, so it waits below the updates the user can still start or retry.
function runningLast(row: ProviderBellRow): number {
  return row.kind === "cli_update" && row.update.state === "running" ? 1 : 0;
}

function rowFor(status: ProviderStatus, now: Date): ProviderBellRow | null {
  const providerId = status.providerId;
  const name = getCatalogEntry(providerId).name;
  if (status.auth.state === "signed_out") {
    return {
      providerId,
      name,
      kind: "signed_out",
      detail: `Signed out · threads on ${name} can't start`,
      signInArgv: status.auth.signIn.argv,
    };
  }
  const detail = status.rateLimit ? rateLimitDetail(status.rateLimit, now) : null;
  if (detail) return { providerId, name, kind: "rate_limited", detail };
  const update = status.cli?.update;
  if (update && update.state !== "none") {
    return { providerId, name, kind: "cli_update", installed: status.cli?.installed ?? null, update };
  }
  const newest = status.newModels[0];
  if (!newest) return null;
  return { providerId, name, kind: "new_model", detail: `${newest.label} is new in the model menu`, tryModelId: newest.modelId };
}

function rateLimitDetail(limit: ProviderRateLimit, now: Date): string | null {
  if (limit.resetsAt === null) return "Rate limited";
  const resetsAt = new Date(limit.resetsAt);
  if (resetsAt.getTime() <= now.getTime()) return null;
  const label = limit.limitType === null ? "Rate limited" : `${LIMIT_LABELS.get(limit.limitType) ?? limit.limitType} reached`;
  return `${label} · resets ${formatClock(resetsAt)}`;
}

function formatClock(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
