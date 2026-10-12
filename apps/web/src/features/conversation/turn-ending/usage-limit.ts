const LIMIT_LABELS: Readonly<Record<string, string>> = {
  five_hour: "5-hour limit",
  seven_day: "Weekly limit",
};

/** Names a provider's usage-limit window, passing an unrecognized window through and omitting a missing one. */
export function usageLimitLabel(limitType: string | undefined): string | undefined {
  return limitType ? LIMIT_LABELS[limitType] ?? limitType : undefined;
}

/** Local 24-hour "HH:MM", the format usage-limit times use. */
export function clockTime(iso: string): string {
  const date = new Date(iso);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** Time left until `at`, as "in 2h 13m"; a started minute counts as a whole one so it never reads "in 0m". */
export function timeUntil(at: string, now: number): string {
  const minutes = Math.max(1, Math.ceil((Date.parse(at) - now) / 60_000));
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `in ${days}d ${hours % 24}h`;
  return hours > 0 ? `in ${hours}h ${minutes % 60}m` : `in ${minutes}m`;
}
