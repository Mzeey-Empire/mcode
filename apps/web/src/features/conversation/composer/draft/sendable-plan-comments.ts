import type { PlanComment, PlanVersion } from "@mcode/contracts/models/plan";
import { carriedOriginalIds, usePlanStore } from "@/stores/planStore";

/**
 * Comments that can ride a Send: open, unsent, and on a version that is not
 * accepted, since an accepted version no longer takes comments. A comment
 * already carried into a newer version is left out so it is not sent twice.
 */
export function sendablePlanComments(
  versions: readonly PlanVersion[],
  comments: readonly PlanComment[],
): PlanComment[] {
  const open = new Set(versions.filter((version) => version.status !== "accepted").map((version) => version.id));
  const carried = carriedOriginalIds(comments);
  return comments.filter(
    (comment) =>
      open.has(comment.versionId) && comment.status === "open" && comment.sentMessageId === null && !carried.has(comment.id),
  );
}

/** Ids of the plan comments the next Send to this thread carries, read from the plan store at the moment of Send. */
export function readPlanCommentIdsForSend(threadId: string): string[] {
  const plans = usePlanStore.getState();
  return sendablePlanComments(plans.plansByThread[threadId] ?? [], plans.commentsByThread[threadId] ?? []).map(
    (comment) => comment.id,
  );
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
