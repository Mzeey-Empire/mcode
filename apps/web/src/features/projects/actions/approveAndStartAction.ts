import type { WorkspaceEnvironmentActionRun } from "@mcode/contracts";
import { applyActionRun } from "@/features/terminal/state/applyActionRun";
import { isProjectCommandApprovalInvalid } from "@/features/projects/environment/ProjectCommandApprovalDialog";
import { getTransport } from "@/transport";

function isRunClosed(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { readonly code?: unknown }).code === "WORKSPACE_ENVIRONMENT_RUN_CLOSED";
}

/**
 * Stores the user's approval, then starts the action in its pending terminal.
 *
 * A stale or no-longer-required approval is not an error here: starting anyway lets the server
 * decide, and a changed command comes back as a renewed `awaiting-approval` run that the card
 * shows again with the new script.
 *
 * The start is bound to the run the user approved. Returns `null` when the server reports that run's
 * pending tab closed meanwhile, because the user cancelled and the command must not run elsewhere.
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
  try {
    const started = await transport.startWorkspaceAction(run.threadId, run.actionId, run.runId);
    applyActionRun(started, { focus: true });
    return started;
  } catch (error) {
    if (isRunClosed(error)) return null;
    throw error;
  }
}
