import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewState } from "@mcode/contracts";
import { useDiffStore } from "@/stores/diffStore";
import { useReviewState } from "./useReviewState";

const { getReviewState } = vi.hoisted(() => ({ getReviewState: vi.fn<(...args: unknown[]) => Promise<ReviewState>>() }));
vi.mock("@/transport", () => ({ getTransport: () => ({ getReviewState }) }));

const clean: ReviewState = {
  isGitRepo: true, head: "abc123", branch: "main",
  uncommitted: { staged: 0, unstaged: 0, untracked: 0 },
  commitsAhead: null, branchDefault: { unavailable: "no-base" },
};
describe("useReviewState", () => {
  beforeEach(() => {
    getReviewState.mockReset().mockResolvedValue(clean);
    useDiffStore.setState({ diffRevisionByScope: {}, reviewViewByThread: {}, reviewViewManuallySelectedByThread: {} });
  });
  it.each(["untracked", "staged"] as const)("selects Unstaged for an %s-only thread", async (kind) => {
    getReviewState.mockResolvedValue({ ...clean, uncommitted: { staged: 0, unstaged: 0, untracked: 0, [kind]: 1 } });
    const { result } = renderHook(() => useReviewState("workspace", "thread"));
    await waitFor(() => expect(result.current.isDirty).toBe(true));
    expect(useDiffStore.getState().getReviewView("thread", { hasTurnChanges: false, isDirty: result.current.isDirty })).toBe("unstaged");
    expect(getReviewState).toHaveBeenCalledWith("workspace", "thread");
  });
  it("refreshes on revision bumps and menu opens", async () => {
    const { result, rerender } = renderHook(({ refresh }) => useReviewState("workspace", "thread", refresh), { initialProps: { refresh: 0 } });
    await waitFor(() => expect(result.current.state).toEqual(clean));
    getReviewState.mockResolvedValue({ ...clean, uncommitted: { staged: 0, unstaged: 1, untracked: 0 } });
    act(() => useDiffStore.getState().bumpDiffRevision("thread"));
    await waitFor(() => expect(result.current.isDirty).toBe(true));
    getReviewState.mockResolvedValue(clean);
    rerender({ refresh: 1 });
    await waitFor(() => expect(result.current.isDirty).toBe(false));
    expect(getReviewState).toHaveBeenCalledTimes(3);
  });
  it("ignores a stale response after switching threads", async () => {
    let finish: ((state: ReviewState) => void) | undefined;
    getReviewState.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const { result, rerender } = renderHook(({ thread }) => useReviewState("workspace", thread), { initialProps: { thread: "old" } });
    rerender({ thread: "new" });
    await waitFor(() => expect(result.current.state).toEqual(clean));
    await act(async () => { finish?.({ ...clean, uncommitted: { staged: 1, unstaged: 0, untracked: 0 } }); });
    expect(result.current.isDirty).toBe(false);
  });
  it("keeps a probe error distinct from a clean state", async () => {
    const error = new Error("offline");
    getReviewState.mockRejectedValue(error);
    const { result } = renderHook(() => useReviewState("workspace"));
    await waitFor(() => expect(result.current.error).toBe(error));
    expect(result.current.state).toBeNull();
  });
  it("does not probe without a workspace", () => {
    const { result } = renderHook(() => useReviewState(null));
    expect(result.current.state).toBeNull();
    expect(getReviewState).not.toHaveBeenCalled();
  });
});
