import type { SubagentRosterEntry, SubagentStatus } from "@mcode/contracts";

const LIST_WORDS: Record<SubagentStatus, string> = {
  running: "Running", done: "Done", failed: "Failed", stopped: "Stopped",
};
const CHIP_WORDS: Record<SubagentStatus, string> = {
  running: "working", done: "finished", failed: "failed", stopped: "stopped",
};

/** Shared list and rail status copy. */
export function subagentStatusLabel(status: SubagentStatus): string {
  return LIST_WORDS[status];
}

/** Shared chat chip status copy. */
export function subagentChipStatus(status: SubagentStatus): string {
  return CHIP_WORDS[status];
}

/** Overview counts treat every terminal outcome as finished work. */
export function subagentOverviewCounts(entries: readonly SubagentRosterEntry[]): { active: number; done: number } {
  const active = entries.filter((entry) => entry.status === "running").length;
  return { active, done: entries.length - active };
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
