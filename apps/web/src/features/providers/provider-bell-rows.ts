import { getCatalogEntry, type ProviderCliUpdate, type ProviderId, type ProviderRateLimit, type ProviderStatus } from "@mcode/contracts";

/** A CLI update the bell can show; `none` never becomes a row. */
export type ProviderBellCliUpdate = Exclude<ProviderCliUpdate, { state: "none" }>;

/** One provider that needs attention in the sidebar bell. */
export type ProviderBellRow = { providerId: ProviderId; name: string } & (
  /** `signInArgv` is the terminal command that signs in. */
  | { kind: "signed_out"; detail: string; signInArgv: readonly string[] }
  | { kind: "rate_limited"; detail: string }
  | { kind: "cli_update"; installed: string | null; update: ProviderBellCliUpdate }
);

// A Map, not an object literal, so a provider-sent type such as "constructor" cannot hit a prototype member.
const LIMIT_LABELS = new Map([
  ["five_hour", "5-hour limit"],
  ["seven_day", "Weekly limit"],
]);

// Rows with an action sort first: signing in and updating are things the user can do now,
// while a rate limit or a running update only waits.
function actionRank(row: ProviderBellRow): number {
  if (row.kind === "signed_out") return 0;
  if (row.kind === "cli_update" && row.update.state !== "running") return 1;
  return 2;
}

/**
 * Turns provider statuses into bell rows, at most one per provider. Within a
 * provider, signed out outranks rate limited, which outranks a CLI update,
 * because each earlier problem blocks threads harder. Unknown auth, past rate
 * limits, and Mcode-managed CLIs produce no row.
 */
export function deriveProviderBellRows(statuses: readonly ProviderStatus[], now: Date): ProviderBellRow[] {
  const rows: ProviderBellRow[] = [];
  for (const status of statuses) {
    const row = rowFor(status, now);
    if (row) rows.push(row);
  }
  return rows.sort((a, b) => actionRank(a) - actionRank(b));
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
  if (!update || update.state === "none") return null;
  return { providerId, name, kind: "cli_update", installed: status.cli?.installed ?? null, update };
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
