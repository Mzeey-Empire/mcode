import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { PlanComment, PlanVersion } from "@mcode/contracts";
import { usePlanStore } from "@/stores/planStore";
import { usePlanCommentChip } from "./usePlanCommentChip";

const THREAD = "thread-chip";
const V1 = "00000000-0000-4000-8000-000000000001";
const V2 = "00000000-0000-4000-8000-000000000002";

const version = (id: string, number: number, status: PlanVersion["status"]) => ({ id, version: number, status }) as PlanVersion;
const comment = (id: string, versionId: string, carriedFromCommentId: string | null = null) =>
  ({ id, versionId, status: "open", sentMessageId: null, carriedFromCommentId, updatedAt: "2026-07-01T00:00:00.000Z" }) as PlanComment;

describe("usePlanCommentChip", () => {
  beforeEach(() => {
    usePlanStore.setState({ plansByThread: {}, commentsByThread: {}, activeVersionByThread: {} });
  });

  it("follows a comment saved in the Plan panel and drops it once deleted or sent", () => {
    usePlanStore.getState().addPlan(THREAD, version(V1, 1, "ready"));
    const { result } = renderHook(() => usePlanCommentChip(THREAD));
    expect(result.current).toEqual([]);

    act(() => usePlanStore.getState().applyCommentsChanged(THREAD, [comment("a", V1), comment("b", V1)], []));
    expect(result.current.map((c) => c.id)).toEqual(["a", "b"]);

    act(() => usePlanStore.getState().applyCommentsChanged(THREAD, [{ ...comment("a", V1), sentMessageId: "m1", updatedAt: "2026-07-01T00:00:01.000Z" }], ["b"]));
    expect(result.current).toEqual([]);
  });

  it("shows a carried copy instead of its original when the next version arrives", () => {
    usePlanStore.getState().addPlan(THREAD, version(V1, 1, "ready"));
    usePlanStore.getState().setComments(THREAD, [comment("a", V1)]);
    const { result } = renderHook(() => usePlanCommentChip(THREAD));

    act(() => {
      usePlanStore.getState().addPlan(THREAD, version(V1, 1, "superseded"));
      usePlanStore.getState().addPlan(THREAD, version(V2, 2, "ready"));
    });
    act(() => usePlanStore.getState().applyCommentsChanged(THREAD, [comment("a2", V2, "a")], []));

    expect(result.current.map((c) => c.id)).toEqual(["a2"]);
  });

  it("carries a comment written on an older version", () => {
    usePlanStore.getState().addPlan(THREAD, version(V1, 1, "superseded"));
    usePlanStore.getState().addPlan(THREAD, version(V2, 2, "ready"));
    usePlanStore.getState().setComments(THREAD, [comment("old", V1), comment("new", V2)]);

    const { result } = renderHook(() => usePlanCommentChip(THREAD));

    expect(result.current.map((c) => c.id)).toEqual(["old", "new"]);
  });
});
