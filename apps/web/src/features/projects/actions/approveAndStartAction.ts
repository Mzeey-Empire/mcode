import type { WorkspaceEnvironmentActionRun } from "@mcode/contracts";
import { applyActionRun } from "@/features/terminal/state/applyActionRun";
import { useTerminalStore } from "@/features/terminal/state/terminalStore";
import { isProjectCommandApprovalInvalid } from "@/features/projects/environment/ProjectCommandApprovalDialog";
import { useProjectActionStore } from "@/features/projects/environment/state/project-action-store";
import { getTransport } from "@/transport";

/** True while the run still waits in its own terminal, so approving it is still what the user wants. */
function isStillAwaiting(run: WorkspaceEnvironmentActionRun): boolean {
  if (run.terminalSessionId === null || !useTerminalStore.getState().ptyToThread[run.terminalSessionId]) return false;
  const current = useProjectActionStore.getState().runsByThread[run.threadId]?.[run.actionId];
  return current?.runId === run.runId && current.status === "awaiting-approval";
}

/**
 * Stores the user's approval, then starts the action in its pending terminal.
 *
 * A stale or no-longer-required approval is not an error here: starting anyway lets the server
 * decide, and a changed command comes back as a renewed `awaiting-approval` run that the card
 * shows again with the new script.
 *
 * Returns `null` without starting when the user closed the pending tab while the approval was in
 * flight, because starting then would run the command in a new terminal after the user cancelled.
 */
export async function approveAndStartAction(run: WorkspaceEnvironmentActionRun): Promise<WorkspaceEnvironmentActionRun | null> {
  const transport = getTransport();
  const approval = run.snapshot.approval;
  if (approval) {
    try {
      await transport.approveWorkspaceEnvironmentCommand(run.threadId, approval.target, approval.fingerprint);
    } catch (error) {
      if (!isProjectCommandApprovalInvalid(error)) throw error;
    }
  }
  if (!isStillAwaiting(run)) return null;
  const started = await transport.startWorkspaceAction(run.threadId, run.actionId);
  applyActionRun(started, { focus: true });
  return started;
}
