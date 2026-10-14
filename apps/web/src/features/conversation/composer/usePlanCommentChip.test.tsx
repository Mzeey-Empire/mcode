import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { PlanComment, PlanVersion } from "@mcode/contracts";
import { useComposerDraftStore } from "@/stores/composerDraftStore";
import { usePlanStore } from "@/stores/planStore";
import { excludePlanComment } from "./draft/plan-comment-selection";
import { usePlanCommentChip } from "./usePlanCommentChip";

const THREAD = "thread-chip";
const V1 = "00000000-0000-4000-8000-000000000001";
const V2 = "00000000-0000-4000-8000-000000000002";

const version = (id: string, number: number, status: PlanVersion["status"]) => ({ id, version: number, status }) as PlanVersion;
const comment = (id: string, versionId: string, carriedFromCommentId: string | null = null) =>
  ({ id, versionId, status: "open", sentMessageId: null, carriedFromCommentId }) as PlanComment;

describe("usePlanCommentChip", () => {
  beforeEach(() => {
    useComposerDraftStore.setState({ drafts: {} });
    usePlanStore.setState({ plansByThread: {}, commentsByThread: {}, activeVersionByThread: {} });
  });

  it("keeps an exclusion when the next version arrives before its carried comments", () => {
    usePlanStore.getState().addPlan(THREAD, version(V1, 1, "ready"));
    usePlanStore.getState().setComments(THREAD, [comment("a", V1), comment("b", V1)]);
    const { result } = renderHook(() => usePlanCommentChip(THREAD));
    act(() => useComposerDraftStore.getState().updateNextMessage(THREAD, (draft) => excludePlanComment(draft, "b")));

    act(() => {
      usePlanStore.getState().addPlan(THREAD, version(V1, 1, "superseded"));
      usePlanStore.getState().addPlan(THREAD, version(V2, 2, "ready"));
    });
    act(() => usePlanStore.getState().applyCommentsChanged(THREAD, [comment("a2", V2, "a"), comment("b2", V2, "b")], []));

    expect(result.current.map((c) => c.id)).toEqual(["a2"]);
  });
});
