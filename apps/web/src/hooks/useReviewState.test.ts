// @vitest-environment jsdom
import { mockTransport } from "@/__tests__/mocks/transport";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewState } from "@mcode/contracts/models/review-comparison";
import { reviewViewAvailability } from "@/lib/review-views";
import { useDiffStore } from "@/stores/diffStore";
import { useReviewState } from "./useReviewState";

const getReviewState = vi.mocked(mockTransport.getReviewState);
vi.mock("@/transport", () => ({ getTransport: () => mockTransport }));

beforeEach(() => {
  vi.mocked(mockTransport.getReviewState).mockReset();
});

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
    expect(useDiffStore.getState().getReviewView("thread", { hasTurnChanges: false, isDirty: result.current.isDirty }, reviewViewAvailability("thread", result.current.state, null))).toBe("unstaged");
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
  // Each probe costs the server about six git spawns, which on Windows block
  // the event loop ahead of the transcript the user just selected.
  it("sends one probe per selection for the hooks a selection mounts together", async () => {
    const { result, rerender } = renderHook(({ thread }) => [
      useReviewState("workspace", thread),
      useReviewState("workspace", thread),
      useReviewState("workspace", thread),
    ], { initialProps: { thread: "a" } });
    await waitFor(() => expect(result.current.map((hook) => hook.state)).toEqual([clean, clean, clean]));
    rerender({ thread: "b" });
    await waitFor(() => expect(result.current.map((hook) => hook.state)).toEqual([clean, clean, clean]));
    rerender({ thread: "a" });
    await waitFor(() => expect(result.current.map((hook) => hook.state)).toEqual([clean, clean, clean]));
    expect(getReviewState.mock.calls).toEqual([["workspace", "a"], ["workspace", "b"], ["workspace", "a"]]);
  });
  it("re-reads when the revision moves while a shared probe is in flight", async () => {
    const stale: Array<(state: ReviewState) => void> = [];
    const dirty = { ...clean, uncommitted: { staged: 0, unstaged: 1, untracked: 0 } };
    let changed = false;
    getReviewState.mockImplementation(() => changed
      ? Promise.resolve(dirty)
      : new Promise((resolve) => { stale.push(resolve); }));
    const { result } = renderHook(() => [useReviewState("workspace", "thread"), useReviewState("workspace", "thread")]);
    changed = true;
    act(() => useDiffStore.getState().bumpDiffRevision("thread"));
    await waitFor(() => expect(result.current.map((hook) => hook.isDirty)).toEqual([true, true]));
    await act(async () => { for (const finish of stale) finish(clean); });
    expect(result.current.map((hook) => hook.isDirty)).toEqual([true, true]);
  });
  it("re-reads for a hook that mounts after the shared probe settled", async () => {
    const first = renderHook(() => useReviewState("workspace", "thread"));
    await waitFor(() => expect(first.result.current.state).toEqual(clean));
    const dirty = { ...clean, uncommitted: { staged: 1, unstaged: 0, untracked: 0 } };
    getReviewState.mockResolvedValue(dirty);
    const second = renderHook(() => useReviewState("workspace", "thread"));
    await waitFor(() => expect(second.result.current.isDirty).toBe(true));
    expect(getReviewState).toHaveBeenCalledTimes(2);
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
