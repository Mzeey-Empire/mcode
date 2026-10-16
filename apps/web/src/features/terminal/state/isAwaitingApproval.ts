import { useProjectActionStore } from "@/features/projects/environment/state/project-action-store";
import { useTerminalStore } from "./terminalStore";

/**
 * Whether the Action run on this terminal is waiting for the user's approval.
 *
 * The run decides, not the record's state: a terminal reused for a changed command keeps its
 * running or exited record while the run asks again.
 */
export function isAwaitingApproval(ptyId: string): boolean {
  const record = Object.values(useTerminalStore.getState().terminals).flat().find((candidate) => candidate.id === ptyId);
  if (record?.kind !== "action" || !record.actionId) return false;
  const run = useProjectActionStore.getState().runsByThread[record.threadId]?.[record.actionId];
  return run?.status === "awaiting-approval" && run.terminalSessionId === ptyId;
}
