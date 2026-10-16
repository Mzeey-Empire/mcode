import type { WorkspaceEnvironmentActionRun } from "@mcode/contracts";
import { applyActionRun } from "@/features/terminal/state/applyActionRun";
import { isProjectCommandApprovalInvalid } from "@/features/projects/environment/ProjectCommandApprovalDialog";
import { getTransport } from "@/transport";

/**
 * Stores the user's approval, then starts the action in its pending terminal.
 *
 * A stale or no-longer-required approval is not an error here: starting anyway lets the server
 * decide, and a changed command comes back as a renewed `awaiting-approval` run that the card
 * shows again with the new script.
 */
export async function approveAndStartAction(run: WorkspaceEnvironmentActionRun): Promise<WorkspaceEnvironmentActionRun> {
  const transport = getTransport();
  const approval = run.snapshot.approval;
  if (approval) {
    try {
      await transport.approveWorkspaceEnvironmentCommand(run.threadId, approval.target, approval.fingerprint);
    } catch (error) {
      if (!isProjectCommandApprovalInvalid(error)) throw error;
    }
  }
  const started = await transport.startWorkspaceAction(run.threadId, run.actionId);
  applyActionRun(started, { focus: true });
  return started;
}
