import type { WorkspaceEnvironmentActionRun } from "@mcode/contracts";
import { useProjectActionStore } from "@/features/projects/environment/state/project-action-store";
import { useTerminalStore } from "./terminalStore";

interface ApplyActionRunOptions {
  /** Make the run's record the scope's active tab; false leaves a background run behind the tab the user is on. */
  readonly focus: boolean;
}

/** A newer run already owns the action's slot, so this one must not resurrect its record. */
function isSuperseded(run: WorkspaceEnvironmentActionRun): boolean {
  const latest = useProjectActionStore.getState().runsByThread[run.threadId]?.[run.actionId];
  return latest !== undefined && (latest.runId !== run.runId || latest.revision > run.revision);
}

/** Removes the action's records that are not the run's terminal. */
function removeStaleRecords(run: WorkspaceEnvironmentActionRun): void {
  const terminals = useTerminalStore.getState();
  for (const record of terminals.terminals[run.threadId] ?? []) {
    if (record.kind === "action" && record.actionId === run.actionId && record.id !== run.terminalSessionId) {
      terminals.removeTerminal(record.id);
    }
  }
}

function showRecord(run: WorkspaceEnvironmentActionRun, terminalId: string, focus: boolean): void {
  const terminals = useTerminalStore.getState();
  if ((terminals.terminals[run.threadId] ?? []).some((record) => record.id === terminalId)) {
    if (focus) terminals.setActiveTerminal(run.threadId, terminalId);
    return;
  }
  // The terminal outlives the command: the shell phase keeps it running after the run settles.
  terminals.addTerminal(
    run.threadId,
    terminalId,
    run.actionName,
    { kind: "action", actionId: run.actionId, state: "running", createdAt: run.startedAt ?? run.createdAt },
    focus,
  );
}

/**
 * Applies a Project Action run to the retained-run store, then mirrors its
 * terminal onto the scope's Terminal tab. The server owns the record, but a
 * client only learns of it on reconnect, so a started run has to add its record
 * here or the tab never appears.
 *
 * A run whose `terminalSessionId` is null has no terminal left, so any record
 * still tagged with its action is stale and goes. Restart and Run again keep the
 * same terminal, so they only change the run, never the record.
 */
export function applyActionRun(run: WorkspaceEnvironmentActionRun, { focus }: ApplyActionRunOptions): void {
  useProjectActionStore.getState().applyRun(run);
  if (isSuperseded(run)) return;
  removeStaleRecords(run);
  if (run.terminalSessionId !== null) showRecord(run, run.terminalSessionId, focus);
}
