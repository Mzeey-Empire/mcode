import type { SubagentRosterEntry, SubagentStatus } from "@mcode/contracts/models/subagent-roster";

const LIST_WORDS: Record<SubagentStatus, string> = {
  "needs-you": "Needs you", "setting-up": "Setting up", running: "Running",
  failed: "Failed", stopped: "Stopped", finished: "Finished",
};
const CHIP_WORDS: Record<SubagentStatus, string> = {
  "needs-you": "needs you", "setting-up": "setting up", running: "working",
  failed: "failed", stopped: "stopped", finished: "finished",
};

/** Shared list and rail status copy. */
export function subagentStatusLabel(status: SubagentStatus): string {
  return LIST_WORDS[status];
}

/** Shared chat chip status copy. */
export function subagentChipStatus(status: SubagentStatus): string {
  return CHIP_WORDS[status];
}

/** Overview counts by thread-row group; failures stay apart so they are not read as finished work. */
export interface SubagentOverviewCounts {
  readonly needsYou: number;
  readonly running: number;
  readonly failed: number;
  readonly finished: number;
}

const OVERVIEW_GROUP: Record<SubagentStatus, keyof SubagentOverviewCounts> = {
  "needs-you": "needsYou", "setting-up": "running", running: "running",
  failed: "failed", stopped: "finished", finished: "finished",
};

/** Count entries by overview group: setting up counts as running, stopped as finished. */
export function subagentOverviewCounts(entries: readonly SubagentRosterEntry[]): SubagentOverviewCounts {
  const counts = { needsYou: 0, running: 0, failed: 0, finished: 0 };
  for (const entry of entries) counts[OVERVIEW_GROUP[entry.status]] += 1;
  return counts;
}

/** Compact elapsed time for list rows: `48s`, `1m 12s`, `1h 3m`. */
export function formatLiveDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}
