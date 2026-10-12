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
