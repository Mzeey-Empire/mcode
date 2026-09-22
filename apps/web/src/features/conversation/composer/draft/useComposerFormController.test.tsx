import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ORCHESTRATION_MODES, type SelectedTextComment } from "@mcode/contracts";
import { INTERACTION_MODES, PERMISSION_MODES } from "@/transport";
import { createMockThread } from "@/__tests__/mocks/transport";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { useComposerDraftStore } from "@/stores/composerDraftStore";
import {
  useThreadDraftStore,
  type ThreadDraftPayload,
} from "@/stores/threadDraftStore";
import { useComposerFormController } from "./useComposerFormController";

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
  note: "Saved note",
  mentions: [],
};

describe("useComposerFormController selected-text drafts", () => {
  beforeEach(() => {
    useComposerDraftStore.setState({ drafts: {}, pendingPrefill: null });
    useWorkspaceStore.setState({ threads: [] });
  });

  it("keeps a saved card when the source editor closes in the same update batch", () => {
    const { result } = renderHook(() => useComposerFormController({ isNewThread: true }));
    const editor = {
      source: comment.source,
      note: "Unsaved note",
      mentions: [],
      escapeWarned: false,
      outsideWarned: false,
      anchor: "source" as const,
    };

    act(() => {
      result.current.setSelectedTextComments([comment], editor);
      result.current.setSelectedTextCommentEditor(undefined);
    });

    expect(result.current.state).toMatchObject({
      selectedTextComments: [comment],
      selectedTextCommentEditor: undefined,
    });
  });

  it("requires a repeat submission attempt before discarding a dirty editor", () => {
    const { result } = renderHook(() => useComposerFormController({ isNewThread: true }));

    act(() => {
      result.current.setSelectedTextCommentEditor({
        source: comment.source,
        note: "Unsaved note",
        mentions: [],
        escapeWarned: false,
        outsideWarned: false,
        anchor: "card",
      });
    });

    expect(result.current.state.selectedTextComments).toEqual([]);

    let firstAttempt: string | null = null;
    act(() => {
      firstAttempt = result.current.requestSelectedTextCommentEditorDismissal();
    });
    expect(firstAttempt).toBe("Repeat this action to discard this comment.");
    expect(result.current.state.selectedTextCommentEditor?.outsideWarned).toBe(true);

    let secondAttempt: string | null = null;
    act(() => {
      secondAttempt = result.current.requestSelectedTextCommentEditorDismissal();
    });
    expect(secondAttempt).toBeNull();
    expect(result.current.state.selectedTextCommentEditor).toBeUndefined();
  });

  it("persists live edits while a failed thread creation waits for retry", async () => {
    const previewUrl = "blob:restored-preview";
    const revokeObjectUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const placeholder = {
      ...createMockThread({ id: "pending-thread" }),
      clientPreparing: false,
      clientError: "Creation failed",
    };
    useWorkspaceStore.setState({ threads: [placeholder] });
    useComposerDraftStore.getState().saveDraft(placeholder.id, {
      input: "Original request.",
      mentions: [],
      selectedTextComments: [comment],
      attachments: [{
        id: "attachment-1",
        name: "preview.png",
        mimeType: "image/png",
        sizeBytes: 128,
        previewUrl,
        filePath: "C:/tmp/preview.png",
      }],
      modelId: "gpt-5.5",
      provider: "codex",
      reasoning: "high",
    });
    const { result } = renderHook(() => useComposerFormController({
      threadId: placeholder.id,
      isNewThread: false,
      activeThread: placeholder,
    }));

    await waitFor(() => expect(result.current.state.text).toBe("Original request."));
    expect(revokeObjectUrl).not.toHaveBeenCalled();

    act(() => {
      result.current.updateDraft("Send the edited request.", []);
      result.current.setSelectedTextComments([comment]);
      result.current.updateSelection({ modelId: "gpt-5.5", provider: "codex" });
    });

    await waitFor(() => expect(useComposerDraftStore.getState().getDraft(placeholder.id)).toMatchObject({
      input: "Send the edited request.",
      selectedTextComments: [comment],
      modelId: "gpt-5.5",
      provider: "codex",
    }));
    expect(revokeObjectUrl).not.toHaveBeenCalled();
    revokeObjectUrl.mockRestore();
  });
});

function draftPayload(input: string): ThreadDraftPayload {
  return {
    workspaceId: "ws-1",
    draft: {
      input,
      mentions: [],
      selectedTextComments: [],
      attachments: [],
      modelId: "gpt-5.5",
      provider: "codex",
      reasoning: "high",
    },
    selection: {
      interactionMode: INTERACTION_MODES.PLAN,
      permissionMode: PERMISSION_MODES.FULL,
      orchestrationMode: ORCHESTRATION_MODES.STANDARD,
      approvalReviewMode: "manual",
      copilotAgent: null,
      thinking: null,
    },
    target: {
      mode: "worktree",
      branch: "main",
      branchSource: "branch",
      customBranchName: "",
      autoPreviewBranch: "",
      selectedWorktree: null,
      branchManuallySelected: false,
    },
  };
}

describe("useComposerFormController new-thread drafts", () => {
  beforeEach(() => {
    localStorage.clear();
    useComposerDraftStore.setState({ drafts: {}, pendingPrefill: null });
    useThreadDraftStore.setState({ drafts: {} });
    useWorkspaceStore.setState({
      threads: [],
      activeDraftId: null,
      activeWorkspaceId: "ws-1",
    });
  });

  it("materializes a persisted draft entity on first input", async () => {
    const { result } = renderHook(() => useComposerFormController({
      isNewThread: true,
      workspaceId: "ws-1",
      draftId: null,
    }));

    act(() => result.current.updateDraft("Ship the fix", []));

    await waitFor(() => {
      const drafts = Object.values(useThreadDraftStore.getState().drafts);
      expect(drafts).toHaveLength(1);
      expect(drafts[0].draft.input).toBe("Ship the fix");
      expect(drafts[0].workspaceId).toBe("ws-1");
    });
    const [id] = Object.keys(useThreadDraftStore.getState().drafts);
    expect(useWorkspaceStore.getState().activeDraftId).toBe(id);
  });

  it("does not materialize for a branch composer or a missing workspace", async () => {
    const branch = renderHook(() => useComposerFormController({
      isNewThread: true,
      workspaceId: "ws-1",
      draftId: undefined,
      branchFromMessageId: "m1",
      branchFromMessageContent: "quoted",
    }));
    act(() => branch.result.current.updateDraft("fork work", []));
    const noWorkspace = renderHook(() => useComposerFormController({
      isNewThread: true,
      draftId: null,
    }));
    act(() => noWorkspace.result.current.updateDraft("orphan", []));

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(Object.keys(useThreadDraftStore.getState().drafts)).toHaveLength(0);
  });

  it("restores input and selection from a bound draft entity", async () => {
    const id = useThreadDraftStore.getState().saveDraft(draftPayload("saved draft"))!;
    const { result } = renderHook(() => useComposerFormController({
      isNewThread: true,
      workspaceId: "ws-1",
      draftId: id,
    }));

    await waitFor(() => expect(result.current.state.text).toBe("saved draft"));
    expect(result.current.state.selection.interactionMode).toBe(INTERACTION_MODES.PLAN);
  });

  it("removes the entity when the composer empties", async () => {
    const id = useThreadDraftStore.getState().saveDraft(draftPayload("to clear"))!;
    const { result } = renderHook(() => useComposerFormController({
      isNewThread: true,
      workspaceId: "ws-1",
      draftId: id,
    }));
    await waitFor(() => expect(result.current.state.text).toBe("to clear"));

    act(() => result.current.updateDraft("", []));

    await waitFor(() =>
      expect(useThreadDraftStore.getState().drafts[id]).toBeUndefined(),
    );
  });

  it("consumes the entity on submit and rolls it back after a failed dispatch", async () => {
    const id = useThreadDraftStore.getState().saveDraft(draftPayload("send me"))!;
    // Mirrors ChatViewSurface: the store owns the binding and the composer
    // receives it as a prop.
    useWorkspaceStore.setState({ activeDraftId: id });
    const { result } = renderHook(() => {
      const draftId = useWorkspaceStore((state) => state.activeDraftId);
      return useComposerFormController({
        isNewThread: true,
        workspaceId: "ws-1",
        draftId,
      });
    });
    await waitFor(() => expect(result.current.state.text).toBe("send me"));

    const submission = result.current.readSubmission();
    act(() => {
      expect(result.current.clearSubmittedDraft(submission)).toBe(true);
    });
    expect(useThreadDraftStore.getState().drafts[id]).toBeUndefined();
    expect(useWorkspaceStore.getState().activeDraftId).toBeNull();

    act(() => result.current.restoreFailedDispatch());

    expect(useThreadDraftStore.getState().drafts[id]).toBeDefined();
    expect(useWorkspaceStore.getState().activeDraftId).toBe(id);
    await waitFor(() => expect(result.current.state.text).toBe("send me"));
  });

  it("keeps the departing draft's target when switching to another draft", async () => {
    const idA = useThreadDraftStore.getState().saveDraft({
      ...draftPayload("draft A"),
      target: { ...draftPayload("draft A").target, branch: "branch-a" },
    })!;
    const idB = useThreadDraftStore.getState().saveDraft({
      ...draftPayload("draft B"),
      target: { ...draftPayload("draft B").target, mode: "direct", branch: "branch-b" },
    })!;

    useWorkspaceStore.getState().openThreadDraft("ws-1", idA);
    const { result } = renderHook(() => {
      const draftId = useWorkspaceStore((state) => state.activeDraftId);
      return useComposerFormController({
        isNewThread: true,
        workspaceId: "ws-1",
        draftId,
      });
    });
    await waitFor(() => expect(result.current.state.text).toBe("draft A"));

    // openThreadDraft writes B's target into the shared newThread* fields in
    // the same set() that rebinds the composer, so the departing save must not
    // re-snapshot live globals.
    act(() => useWorkspaceStore.getState().openThreadDraft("ws-1", idB));
    await waitFor(() => expect(result.current.state.text).toBe("draft B"));

    expect(useThreadDraftStore.getState().drafts[idA]?.target.branch).toBe("branch-a");
  });
});
