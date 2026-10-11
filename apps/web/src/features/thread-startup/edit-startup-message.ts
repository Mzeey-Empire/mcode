import { createDefaultComposerAgentSelection } from "@/features/conversation/composer/draft/composer-selection-state";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import type { WorkspaceThread } from "@/lib/workspace-thread";
import { useComposerDraftStore, type ComposerDraft } from "@/stores/composerDraftStore";
import { useThreadDraftStore, type ThreadDraftSelection, type ThreadDraftTarget } from "@/stores/threadDraftStore";

type TargetThread = Pick<WorkspaceThread, "mode" | "branch" | "base_branch" | "worktree_managed" | "worktree_path">;

function folderName(path: string): string {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) ?? path;
}

/**
 * The new-thread target that starts the same kind of thread again.
 *
 * A managed worktree reopens on its base branch, since its own branch is the one the failed
 * startup created. An attached worktree reattaches to the same checkout.
 */
export function startupRetryTarget(thread: TargetThread): ThreadDraftTarget {
  const base = { branchSource: "branch", branchRemote: null, startFromOrigin: false } as const;
  if (thread.mode !== "worktree") return { ...base, mode: "direct", branch: thread.branch, selectedWorktree: null };
  if (!thread.worktree_managed && thread.worktree_path) {
    return {
      ...base,
      mode: "existing-worktree",
      branch: thread.branch,
      selectedWorktree: { name: folderName(thread.worktree_path), path: thread.worktree_path, branch: thread.branch },
    };
  }
  // An empty branch follows the project's current-else-default branch when the draft reopens.
  return { ...base, mode: "worktree", branch: thread.base_branch || thread.branch, selectedWorktree: null };
}

function firstMessageDraft(prompt: string): ComposerDraft {
  const selection = createDefaultComposerAgentSelection();
  return {
    input: prompt,
    attachments: [],
    modelId: selection.modelId,
    provider: selection.provider,
    reasoning: selection.reasoning,
  };
}

function threadSelection(thread: WorkspaceThread): ThreadDraftSelection {
  return {
    interactionMode: thread.interaction_mode ?? "build",
    permissionMode: thread.permission_mode ?? "full",
    orchestrationMode: thread.orchestration_mode ?? "standard",
    approvalReviewMode: "manual",
    thinking: thread.thinking,
  };
}

/**
 * Edit message for a startup that never produced a working thread: moves the first message into a
 * new-thread draft aimed at the same target, removes the stopped thread, and opens the draft.
 *
 * The draft is saved before the thread is removed and moves back if removal fails, so the
 * message always lives in exactly one place.
 */
export async function editStartupMessage(thread: WorkspaceThread, queuedMessage: string | undefined): Promise<void> {
  const composerDrafts = useComposerDraftStore.getState();
  const threadDrafts = useThreadDraftStore.getState();
  const workspace = useWorkspaceStore.getState();
  const parked = composerDrafts.getDraft(thread.id);
  const draft = parked ?? firstMessageDraft(queuedMessage || thread.title);
  const draftId = threadDrafts.saveDraft({
    workspaceId: thread.workspace_id,
    draft,
    selection: threadSelection(thread),
    target: startupRetryTarget(thread),
  });
  if (!draftId) throw new Error("Could not keep the message");
  // Thread removal clears the thread's composer draft and its attachments, so the draft moves first.
  if (parked) composerDrafts.removeDraftAfterAttachmentTransfer(thread.id);
  try {
    await workspace.deleteThread(thread.id, thread.mode === "worktree" && thread.worktree_managed === true);
  } catch (error) {
    if (parked) composerDrafts.saveDraft(thread.id, parked);
    threadDrafts.removeDraftAfterAttachmentTransfer(draftId);
    throw error;
  }
  useWorkspaceStore.getState().openThreadDraft(thread.workspace_id, draftId);
}
