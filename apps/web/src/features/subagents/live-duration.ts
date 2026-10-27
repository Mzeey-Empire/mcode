import { useEffect, useState } from "react";
import { isLiveSubagentStatus, type SubagentRosterEntry } from "@mcode/contracts/models/subagent-roster";
import { formatLiveDuration } from "./subagent-status";

const LIVE_TICK_MS = 1_000;

/** Re-renders once a second only while something is live, so an idle surface costs nothing. */
export function useNow(live: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => setNow(Date.now()), LIVE_TICK_MS);
    return () => window.clearInterval(timer);
  }, [live]);
  return now;
}

/** Only a running entry reads the clock; a finished entry without an end time has no honest duration. */
export function elapsed(row: SubagentRosterEntry, now: number): string | null {
  const end = isLiveSubagentStatus(row.status) ? now : row.endedAt && Date.parse(row.endedAt);
  return end ? formatLiveDuration(end - Date.parse(row.startedAt)) : null;
}
