import type { ThreadStartup } from "@mcode/contracts/thread-startup";
import { createDefaultComposerAgentSelection } from "@/features/conversation/composer/draft/composer-selection-state";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import type { WorkspaceThread } from "@/lib/workspace-thread";
import { useComposerDraftStore, type ComposerDraft } from "@/stores/composerDraftStore";
import { useThreadStore } from "@/stores/threadStore";
import { useThreadDraftStore, type ThreadDraftSelection, type ThreadDraftTarget } from "@/stores/threadDraftStore";

type TargetThread = Pick<WorkspaceThread, "mode" | "branch" | "base_branch" | "worktree_managed" | "worktree_path">;

function folderName(path: string): string {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) ?? path;
}

type FetchDetail = Extract<NonNullable<ThreadStartup["steps"][number]["detail"]>, { phase: "fetch" }>;

/** The thread fields do not say how the branch was picked; only the startup's fetch step does. */
function startupFetch(startup: Pick<ThreadStartup, "steps"> | undefined): FetchDetail | undefined {
  const detail = startup?.steps.find((step) => step.phase === "fetch")?.detail;
  return detail?.phase === "fetch" ? detail : undefined;
}

function managedWorktreeTarget(thread: TargetThread, fetch: FetchDetail | undefined): ThreadDraftTarget {
  const target = { mode: "worktree", branchRemote: null, selectedWorktree: null } as const;
  if (fetch?.pullRequestNumber !== undefined) {
    return { ...target, branch: fetch.branch ?? thread.base_branch ?? thread.branch, branchSource: "pr", pullRequestNumber: fetch.pullRequestNumber, startFromOrigin: false };
  }
  // An empty branch follows the project's current-else-default branch when the draft reopens.
  return { ...target, branch: thread.base_branch || thread.branch, branchSource: "branch", startFromOrigin: fetch !== undefined };
}

/**
 * The new-thread target that starts the same kind of thread again.
 *
 * A managed worktree reopens on its base branch, since its own branch is the one the failed
 * startup created, and keeps the pull request or Start from origin choice its fetch step records.
 * An attached worktree reattaches to the same checkout.
 */
export function startupRetryTarget(thread: TargetThread, startup?: Pick<ThreadStartup, "steps">): ThreadDraftTarget {
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
  return managedWorktreeTarget(thread, startupFetch(startup));
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
 * The thread's first message. A reloaded client has no queued copy, and the loaded transcript holds
 * it only once the server persisted it, so the title stands in last; it keeps just the first line.
 */
function firstMessage(thread: WorkspaceThread, queuedMessage: string | undefined): string {
  if (queuedMessage) return queuedMessage;
  const sent = useThreadStore.getState().records.get(thread.id)?.messages.find((message) => message.role === "user");
  return sent?.content || thread.title;
}

/**
 * Edit message for a startup that never produced a working thread: moves the first message into a
 * new-thread draft aimed at the same target, removes the stopped thread, and opens the draft.
 *
 * The draft is saved before the thread is removed and moves back if removal fails, so the
 * message always lives in exactly one place.
 */
export async function editStartupMessage(thread: WorkspaceThread, startup: ThreadStartup | undefined, queuedMessage: string | undefined): Promise<void> {
  const composerDrafts = useComposerDraftStore.getState();
  const threadDrafts = useThreadDraftStore.getState();
  const workspace = useWorkspaceStore.getState();
  const parked = composerDrafts.getDraft(thread.id);
  const draft = parked ?? firstMessageDraft(firstMessage(thread, queuedMessage));
  const draftId = threadDrafts.saveDraft({
    workspaceId: thread.workspace_id,
    draft,
    selection: threadSelection(thread),
    target: startupRetryTarget(thread, startup),
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
