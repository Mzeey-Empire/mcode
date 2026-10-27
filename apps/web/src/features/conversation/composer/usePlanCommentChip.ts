import { useMemo } from "react";
import type { PlanComment } from "@mcode/contracts/models/plan";
import { usePlanStore } from "@/stores/planStore";
import { sendablePlanComments } from "./draft/sendable-plan-comments";

const NO_COMMENTS: readonly PlanComment[] = [];
const NO_VERSIONS: readonly never[] = [];

/** The plan comments the next Send to this thread carries, live from the plan store. */
export function usePlanCommentChip(threadId: string | undefined): readonly PlanComment[] {
  const comments = usePlanStore((s) => (threadId ? s.commentsByThread[threadId] : undefined) ?? NO_COMMENTS);
  const versions = usePlanStore((s) => (threadId ? s.plansByThread[threadId] : undefined) ?? NO_VERSIONS);
  return useMemo(() => sendablePlanComments(versions, comments), [versions, comments]);
}
