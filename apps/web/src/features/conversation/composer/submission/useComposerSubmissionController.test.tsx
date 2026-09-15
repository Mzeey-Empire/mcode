import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SelectedTextComment } from "@mcode/contracts";
import type { ComposerExecutionTargetController } from "../execution/useComposerExecutionTarget";
import { useComposerFormController } from "../draft/useComposerFormController";

const routeMocks = vi.hoisted(() => ({
  dispatchComposerTarget: vi.fn(),
}));

vi.mock("./composer-submission-routes", () => ({
  dispatchComposerTarget: routeMocks.dispatchComposerTarget,
  isComposerTargetReady: () => true,
}));

import {
  useComposerSubmissionController,
  type ComposerSubmissionQueue,
} from "./useComposerSubmissionController";

const comment: SelectedTextComment = {
  id: "11111111-1111-4111-8111-111111111111",
  displayNumber: 1,
  source: {
    threadId: "thread-1",
    messageId: "message-1",
    sourceRole: "assistant",
    start: 0,
    end: 5,
    quote: "focus",
  },
  note: "Explain this choice.",
  mentions: [],
};

const target = {
  kind: "new-thread" as const,
  mode: "direct" as const,
  branch: "main",
  branchSource: "branch" as const,
  hasWorktree: false,
};

function execution(): ComposerExecutionTargetController {
  return {
    target,
    mode: "direct",
    modeOptions: [],
    isGitRepo: false,
    needsWorkspace: false,
    isStaleWorktree: false,
    selectedWorktree: null,
    newThreadBranch: "main",
    newThreadBranchSource: "branch",
    branchExecMode: "direct",
    branchTargetBranch: "main",
    branchWorktreePath: null,
    branchWorktreeIsDetached: false,
    fetchingBranch: false,
    setMode: vi.fn(),
    setBranchMode: vi.fn(),
    setNewThreadMode: vi.fn(),
    setNewThreadBranch: vi.fn(),
    setNewThreadBranchFromPullRequest: vi.fn(),
  };
}

function useHarness(queueOverrides: Partial<ComposerSubmissionQueue> = {}) {
  const form = useComposerFormController({
    isNewThread: true,
    workspaceId: "workspace-1",
  });
  const controller = useComposerSubmissionController({
    isNewThread: true,
    workspaceId: "workspace-1",
    isAgentRunning: false,
    isThreadScaffold: false,
    form,
    execution: execution(),
    queue: {
      editing: null,
      queueIfGenerating: () => false,
      discardEmptyEdit: () => false,
      finishEditing: vi.fn(),
      consumeEditForDispatch: vi.fn(),
      releaseConsumedEdit: vi.fn(),
      resolvePreviewAnnotations: (annotations) => annotations,
      ...queueOverrides,
    },
  });
  return { form, controller };
}

describe("useComposerSubmissionController selected-text comments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("dispatches comment-only drafts and clears them while acknowledgement is pending", async () => {
    let acknowledge!: () => void;
    routeMocks.dispatchComposerTarget.mockReturnValueOnce(new Promise<void>((resolve) => {
      acknowledge = resolve;
    }));
    const { result } = renderHook(useHarness);

    act(() => {
      result.current.form.setSelectedTextComments([comment]);
    });
    await waitFor(() => expect(result.current.form.state.selectedTextComments).toEqual([comment]));
    act(() => {
      void result.current.controller.submit();
    });

    await waitFor(() => expect(routeMocks.dispatchComposerTarget).toHaveBeenCalledWith(expect.objectContaining({
      submission: expect.objectContaining({
        snapshot: expect.objectContaining({ rawInput: "", selectedTextComments: [comment] }),
      }),
    })));
    expect(result.current.form.state.selectedTextComments).toEqual([]);

    await act(async () => {
      acknowledge();
    });
    await waitFor(() => expect(result.current.form.state.selectedTextComments).toEqual([]));
  });

  it("retains saved cards when the dispatch fails or is cancelled before acknowledgement", async () => {
    routeMocks.dispatchComposerTarget.mockRejectedValueOnce(new Error("Cancelled before acknowledgement"));
    const { result } = renderHook(useHarness);

    act(() => {
      result.current.form.setSelectedTextComments([comment]);
    });
    await waitFor(() => expect(result.current.form.state.selectedTextComments).toEqual([comment]));
    act(() => {
      void result.current.controller.submit();
    });

    await waitFor(() => expect(routeMocks.dispatchComposerTarget).toHaveBeenCalled());
    expect(result.current.form.state.selectedTextComments).toEqual([comment]);
  });

  it("dispatches saved cards after a dirty editor completes its dismissal warning flow", async () => {
    const { result } = renderHook(useHarness);

    act(() => {
      result.current.form.setSelectedTextComments([comment], {
        source: comment.source,
        note: "Unsaved note",
        mentions: [],
        escapeWarned: false,
        outsideWarned: false,
        anchor: "card",
      });
    });
    await waitFor(() => expect(result.current.form.state.selectedTextCommentEditor).toBeDefined());
    expect(result.current.form.state.selectedTextComments).toEqual([comment]);
    act(() => {
      void result.current.controller.submit();
    });

    await waitFor(() => expect(result.current.form.state.selectedTextCommentEditor?.outsideWarned).toBe(true));
    expect(routeMocks.dispatchComposerTarget).not.toHaveBeenCalled();

    act(() => {
      void result.current.controller.submit();
    });

    await waitFor(() => expect(routeMocks.dispatchComposerTarget).toHaveBeenCalledWith(expect.objectContaining({
      submission: expect.objectContaining({
        snapshot: expect.objectContaining({
          selectedTextComments: [comment],
          selectedTextCommentEditor: undefined,
        }),
      }),
    })));
    expect(result.current.form.state.selectedTextCommentEditor).toBeUndefined();
  });

  it("accepts a second Enter while the previous dispatch is still in flight", async () => {
    let releaseFirst!: () => void;
    routeMocks.dispatchComposerTarget
      .mockReturnValueOnce(new Promise<void>((resolve) => {
        releaseFirst = resolve;
      }))
      .mockResolvedValueOnce(undefined);

    const { result } = renderHook(useHarness);

    act(() => {
      result.current.form.replaceDraft("first message");
    });
    await waitFor(() => expect(result.current.form.state.text).toBe("first message"));
    act(() => {
      void result.current.controller.submit();
    });

    await waitFor(() => expect(routeMocks.dispatchComposerTarget).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.form.state.text).toBe(""));

    act(() => {
      result.current.form.replaceDraft("second message");
    });
    await waitFor(() => expect(result.current.form.state.text).toBe("second message"));
    act(() => {
      void result.current.controller.submit();
    });

    await waitFor(() => expect(routeMocks.dispatchComposerTarget).toHaveBeenCalledTimes(2));
    expect(routeMocks.dispatchComposerTarget.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        submission: expect.objectContaining({
          snapshot: expect.objectContaining({ rawInput: "second message" }),
        }),
      }),
    );

    await act(async () => {
      releaseFirst();
    });
  });

  it("consumes the queue edit while a dispatch is in flight and releases it when the dispatch fails", async () => {
    const consumeEditForDispatch = vi.fn();
    const releaseConsumedEdit = vi.fn();
    routeMocks.dispatchComposerTarget.mockRejectedValueOnce(
      new Error("transport unavailable"),
    );
    const { result } = renderHook(() =>
      useHarness({ consumeEditForDispatch, releaseConsumedEdit }),
    );

    act(() => {
      result.current.form.replaceDraft("edited queued message");
    });
    await waitFor(() => expect(result.current.form.state.text).toBe("edited queued message"));
    act(() => {
      void result.current.controller.submit();
    });

    await waitFor(() => expect(releaseConsumedEdit).toHaveBeenCalledTimes(1));
    expect(consumeEditForDispatch).toHaveBeenCalledTimes(1);
    expect(
      consumeEditForDispatch.mock.invocationCallOrder[0],
    ).toBeLessThan(
      routeMocks.dispatchComposerTarget.mock.invocationCallOrder[0]!,
    );
  });

  it("does not release a consumed queue edit after a settled dispatch", async () => {
    const releaseConsumedEdit = vi.fn();
    routeMocks.dispatchComposerTarget.mockResolvedValueOnce(undefined);
    const { result } = renderHook(() => useHarness({ releaseConsumedEdit }));

    act(() => {
      result.current.form.replaceDraft("edited queued message");
    });
    await waitFor(() => expect(result.current.form.state.text).toBe("edited queued message"));
    await act(async () => {
      await result.current.controller.submit();
    });

    await waitFor(() => expect(routeMocks.dispatchComposerTarget).toHaveBeenCalled());
    expect(releaseConsumedEdit).not.toHaveBeenCalled();
  });
});
