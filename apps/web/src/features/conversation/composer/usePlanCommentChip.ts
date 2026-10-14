import { useEffect } from "react";
import type { PlanComment } from "@mcode/contracts";
import { usePlanStore } from "@/stores/planStore";
import { useComposerDraftStore } from "@/stores/composerDraftStore";
import { visiblePlanCommentSelection } from "./draft/draft-submission";
import { updatePlanCommentSelection } from "./draft/plan-comment-selection";

const NO_COMMENTS: readonly PlanComment[] = [];

/**
 * The plan comments the next Send to this thread carries. Keeps the draft's
 * selection in step with the plan store so a comment saved in the Plan panel
 * shows up here without a Send.
 */
export function usePlanCommentChip(threadId: string | undefined): readonly PlanComment[] {
  const comments = usePlanStore((s) => (threadId ? s.commentsByThread[threadId] : undefined) ?? NO_COMMENTS);
  const versions = usePlanStore((s) => (threadId ? s.plansByThread[threadId] : undefined));
  const draft = useComposerDraftStore((s) => (threadId ? s.drafts[threadId] : undefined));

  useEffect(() => {
    if (threadId) updatePlanCommentSelection(threadId);
  }, [threadId, comments, versions]);

  const selection = draft && visiblePlanCommentSelection(draft);
  if (!selection) return NO_COMMENTS;
  const riding = new Set(selection.includedIds.filter((id) => !selection.excludedIds.includes(id)));
  return comments.filter((comment) => riding.has(comment.id));
}
