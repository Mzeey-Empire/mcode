import type { PlanComment, PlanCommentSelection, PlanVersion } from "@mcode/contracts";
import { carriedOriginalIds, usePlanStore } from "@/stores/planStore";
import { useComposerDraftStore, type ComposerDraft } from "@/stores/composerDraftStore";
import {
  readSendableDraftContent,
  reconcilePlanCommentSelection,
  type NextMessageDraft,
  type PlanCommentRecord,
} from "./draft-submission";

/**
 * Comments that can ride a Send: open, unsent, and on a version that is not
 * accepted, since the user picks which version to implement. A comment already
 * carried into a newer version is left out so it is not sent twice.
 */
export function sendablePlanComments(
  versions: readonly PlanVersion[],
  comments: readonly PlanComment[],
): { version: PlanVersion; comments: PlanComment[] } | undefined {
  const latest = versions.at(-1);
  if (!latest) return undefined;
  const open = new Set(versions.filter((version) => version.status !== "accepted").map((version) => version.id));
  const carried = carriedOriginalIds(comments);
  return {
    version: latest,
    comments: comments.filter(
      (comment) =>
        open.has(comment.versionId) && comment.status === "open" && comment.sentMessageId === null && !carried.has(comment.id),
    ),
  };
}

function toRecord(comment: PlanComment): PlanCommentRecord {
  return {
    id: comment.id,
    open: true,
    ...(comment.carriedFromCommentId ? { carriedFromCommentId: comment.carriedFromCommentId } : {}),
  };
}

/**
 * Brings the draft's plan-comment selection in line with the thread's
 * sendable comments. A new plan version keeps the earlier version's
 * exclusions through each comment's carried-from link.
 */
export function syncPlanCommentSelection<T extends NextMessageDraft>(
  draft: T,
  sendable: ReturnType<typeof sendablePlanComments>,
): T {
  const current = draft.planCommentSelection;
  if (!sendable) return current ? { ...draft, planCommentSelection: undefined } : draft;
  const base: PlanCommentSelection = current ?? {
    planVersionId: sendable.version.id,
    includedIds: [],
    excludedIds: [],
    revision: 1,
  };
  const reconciled = reconcilePlanCommentSelection(base, sendable.comments.map(toRecord));
  const next = reconciled.planVersionId === sendable.version.id
    ? reconciled
    : { ...reconciled, planVersionId: sendable.version.id, revision: reconciled.revision + 1 };
  if (next === current) return draft;
  if (!current && next.includedIds.length === 0 && next.excludedIds.length === 0) return draft;
  return { ...draft, planCommentSelection: next };
}

/** Leaves one comment out of the next Send only; it returns to the chip after that Send. */
export function excludePlanComment<T extends NextMessageDraft>(draft: T, commentId: string): T {
  const selection = draft.planCommentSelection;
  if (!selection?.includedIds.includes(commentId)) return draft;
  return {
    ...draft,
    planCommentSelection: {
      ...selection,
      excludedIds: [...selection.excludedIds, commentId],
      revision: selection.revision + 1,
    },
  };
}

/** Puts an excluded comment back on the next Send. */
export function includePlanComment<T extends NextMessageDraft>(draft: T, commentId: string): T {
  const selection = draft.planCommentSelection;
  if (!selection?.excludedIds.includes(commentId)) return draft;
  return {
    ...draft,
    planCommentSelection: {
      ...selection,
      excludedIds: selection.excludedIds.filter((id) => id !== commentId),
      revision: selection.revision + 1,
    },
  };
}

/** Leaves every riding comment out of the next Send; the comments stay open in the plan. */
export function excludeAllPlanComments<T extends NextMessageDraft>(draft: T): T {
  const selection = draft.planCommentSelection;
  if (!selection) return draft;
  const riding = selection.includedIds.filter((id) => !selection.excludedIds.includes(id));
  if (riding.length === 0) return draft;
  return {
    ...draft,
    planCommentSelection: {
      ...selection,
      excludedIds: [...selection.excludedIds, ...riding],
      revision: selection.revision + 1,
    },
  };
}

/** Syncs a thread's selection from the plan store, then applies the change. */
export function updatePlanCommentSelection(threadId: string, change?: (draft: ComposerDraft) => ComposerDraft): void {
  const plans = usePlanStore.getState();
  // Hydration sets a thread's comments last, even when empty. Syncing before then would drop a restored selection.
  const loaded = plans.commentsByThread[threadId] !== undefined;
  const sendable = sendablePlanComments(plans.plansByThread[threadId] ?? [], plans.commentsByThread[threadId] ?? []);
  useComposerDraftStore.getState().updateNextMessage(threadId, (draft) => {
    const synced = loaded ? syncPlanCommentSelection(draft, sendable) : draft;
    return change ? change(synced) : synced;
  });
}

/**
 * The plan comments the next Send to this thread would carry and the ones it
 * leaves out, synced with the plan store first so a comment saved a moment
 * ago is not missed.
 */
export function readPlanCommentsForSend(threadId: string): { ridingIds: string[]; excludedIds: string[] } {
  updatePlanCommentSelection(threadId);
  const draft = useComposerDraftStore.getState().drafts[threadId];
  return (draft && readSendableDraftContent(draft).planComments) ?? { ridingIds: [], excludedIds: [] };
}

/** A queued send or a branch starts no plan turn, so only a direct send to an existing thread carries plan comments. */
export function planCommentThreadFor(send: {
  isNewThread: boolean;
  branchFromMessageId?: string | null;
  isAgentRunning: boolean;
  threadId?: string;
}): string | undefined {
  return !send.isNewThread && !send.branchFromMessageId && !send.isAgentRunning ? send.threadId : undefined;
}
