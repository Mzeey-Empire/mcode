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
