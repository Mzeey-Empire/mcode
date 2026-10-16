import type { WorkspaceEnvironmentActionRun } from "@mcode/contracts";
import { useProjectActionStore } from "@/features/projects/environment/state/project-action-store";
import { useTerminalStore } from "./terminalStore";

interface ApplyActionRunOptions {
  readonly focus: boolean;
}

/** A newer run already owns the action's slot, so this one must not resurrect its record. */
function newerRun(run: WorkspaceEnvironmentActionRun): WorkspaceEnvironmentActionRun | null {
  const latest = useProjectActionStore.getState().runsByThread[run.threadId]?.[run.actionId];
  if (latest === undefined) return null;
  return latest.runId !== run.runId || latest.revision > run.revision ? latest : null;
}

function removeStaleRecords(run: WorkspaceEnvironmentActionRun): void {
  const terminals = useTerminalStore.getState();
  for (const record of terminals.terminals[run.threadId] ?? []) {
    if (record.kind === "action" && record.actionId === run.actionId && record.id !== run.terminalSessionId) {
      terminals.removeTerminal(record.id);
    }
  }
}

interface ShowRecordOptions {
  readonly focus: boolean;
  /** A new run took over the terminal, as opposed to another update of the run already there. */
  readonly relaunched: boolean;
}

const REUSABLE_STATES: ReadonlySet<string | undefined> = new Set(["exited", "failed", "pending"]);

function showRecord(run: WorkspaceEnvironmentActionRun, terminalId: string, { focus, relaunched }: ShowRecordOptions): void {
  const terminals = useTerminalStore.getState();
  const existing = (terminals.terminals[run.threadId] ?? []).find((record) => record.id === terminalId);
  if (existing) {
    // The server reuses a terminal whose shell the user exited, and starts an approved run in the
    // terminal that was waiting for it. A delayed update of the run that was running when the shell
    // exited must not undo that exit, so only a new run clears it.
    if (relaunched && run.status === "running" && REUSABLE_STATES.has(existing.state)) {
      terminals.recordTerminalRestart(terminalId);
    }
    if (focus) terminals.setActiveTerminal(run.threadId, terminalId);
    return;
  }
  // The terminal outlives the command: the shell phase keeps it running after the run settles.
  // A run waiting for approval has no process yet.
  terminals.addTerminal(
    run.threadId,
    terminalId,
    run.actionName,
    { kind: "action", actionId: run.actionId, state: run.status === "awaiting-approval" ? "pending" : "running", createdAt: run.startedAt ?? run.createdAt },
    focus,
  );
}

/**
 * Applies a Project Action run to the retained-run store, then mirrors its
 * terminal onto the scope's Terminal tab. The server owns the terminal, but the
 * client builds its tab record from the run, so every path that receives a run
 * (RPC response, push event, hydration) must come through here.
 *
 * A run whose `terminalSessionId` is null has no terminal left, so any record
 * still tagged with its action is stale and goes. Restart and Run again keep the
 * same terminal, so they only change the run, never the record.
 */
export function applyActionRun(run: WorkspaceEnvironmentActionRun, { focus }: ApplyActionRunOptions): void {
  const previous = useProjectActionStore.getState().runsByThread[run.threadId]?.[run.actionId];
  useProjectActionStore.getState().applyRun(run);
  const newer = newerRun(run);
  if (newer) {
    // The push event can beat the start response, which still carries the user's focus request.
    if (focus && newer.runId === run.runId && newer.terminalSessionId !== null) {
      showRecord(newer, newer.terminalSessionId, { focus: true, relaunched: false });
    }
    return;
  }
  removeStaleRecords(run);
  if (run.terminalSessionId !== null) {
    const relaunched = previous !== undefined && previous.runId !== run.runId;
    showRecord(run, run.terminalSessionId, { focus, relaunched });
  }
}
