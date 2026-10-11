import { getCatalogEntry, type ProviderId, type ProviderRateLimit, type ProviderStatus } from "@mcode/contracts";

/** One provider that needs attention in the sidebar bell. */
export interface ProviderBellRow {
  providerId: ProviderId;
  name: string;
  kind: ProviderBellRowKind;
  detail: string;
  /** The terminal command that signs in; present only on signed-out rows. */
  signInArgv?: readonly string[];
  /** The announced model that Try starts the next thread on; present only on new-model rows. */
  tryModelId?: string;
}

/** Row kinds in priority order: a provider shows only its first, and rows sort by it. */
const ROW_KINDS = ["signed_out", "rate_limited", "new_model"] as const;
type ProviderBellRowKind = (typeof ROW_KINDS)[number];

// A Map, not an object literal, so a provider-sent type such as "constructor" cannot hit a prototype member.
const LIMIT_LABELS = new Map([
  ["five_hour", "5-hour limit"],
  ["seven_day", "Weekly limit"],
]);

/**
 * Turns provider statuses into bell rows. Signed out outranks rate limited, which
 * outranks a new model, both for one provider and in row order, because a
 * signed-out provider cannot start a thread at all. Unknown auth and past rate
 * limits produce no row.
 */
export function deriveProviderBellRows(statuses: readonly ProviderStatus[], now: Date): ProviderBellRow[] {
  const rows: ProviderBellRow[] = [];
  for (const status of statuses) {
    const row = rowFor(status, now);
    if (row) rows.push(row);
  }
  return rows.sort((a, b) => ROW_KINDS.indexOf(a.kind) - ROW_KINDS.indexOf(b.kind));
}

function rowFor(status: ProviderStatus, now: Date): ProviderBellRow | null {
  const name = getCatalogEntry(status.providerId).name;
  if (status.auth.state === "signed_out") {
    return {
      providerId: status.providerId,
      name,
      kind: "signed_out",
      detail: `Signed out · threads on ${name} can't start`,
      signInArgv: status.auth.signIn.argv,
    };
  }
  const detail = status.rateLimit ? rateLimitDetail(status.rateLimit, now) : null;
  if (detail) return { providerId: status.providerId, name, kind: "rate_limited", detail };
  const newest = status.newModels[0];
  if (!newest) return null;
  return {
    providerId: status.providerId,
    name,
    kind: "new_model",
    detail: `${newest.label} is new in the model menu`,
    tryModelId: newest.modelId,
  };
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
