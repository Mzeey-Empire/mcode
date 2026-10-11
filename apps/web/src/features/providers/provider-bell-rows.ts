import { getCatalogEntry, type ProviderId, type ProviderRateLimit, type ProviderStatus } from "@mcode/contracts";

/** One provider that needs attention in the sidebar bell. */
export interface ProviderBellRow {
  providerId: ProviderId;
  name: string;
  kind: "signed_out" | "rate_limited";
  detail: string;
  /** The terminal command that signs in; present only on signed-out rows. */
  signInArgv?: readonly string[];
}

// A Map, not an object literal, so a provider-sent type such as "constructor" cannot hit a prototype member.
const LIMIT_LABELS = new Map([
  ["five_hour", "5-hour limit"],
  ["seven_day", "Weekly limit"],
]);

/**
 * Turns provider statuses into bell rows. Signed out outranks rate limited,
 * both for one provider and in row order, because a signed-out provider cannot
 * start a thread at all. Unknown auth and past rate limits produce no row.
 */
export function deriveProviderBellRows(statuses: readonly ProviderStatus[], now: Date): ProviderBellRow[] {
  const rows: ProviderBellRow[] = [];
  for (const status of statuses) {
    const row = rowFor(status, now);
    if (row) rows.push(row);
  }
  return rows.sort((a, b) => Number(a.kind === "rate_limited") - Number(b.kind === "rate_limited"));
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
  if (!detail) return null;
  return { providerId: status.providerId, name, kind: "rate_limited", detail };
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
