import { beforeEach, describe, expect, it, vi } from "vitest";
import { INTERACTION_MODES, PERMISSION_MODES } from "@/transport";
import { ORCHESTRATION_MODES } from "@mcode/contracts";
import type { ComposerDraft } from "@/stores/composerDraftStore";
import {
  useThreadDraftStore,
  type ThreadDraftPayload,
  type ThreadDraftSelection,
  type ThreadDraftTarget,
} from "@/stores/threadDraftStore";

const composerDraft: ComposerDraft = {
  input: "unsent message",
  attachments: [],
  modelId: "gpt-5.5",
  provider: "codex",
  reasoning: "high",
};

const selection: ThreadDraftSelection = {
  interactionMode: INTERACTION_MODES.PLAN,
  permissionMode: PERMISSION_MODES.FULL,
  orchestrationMode: ORCHESTRATION_MODES.STANDARD,
  approvalReviewMode: "manual",
  copilotAgent: null,
  thinking: null,
};

const target: ThreadDraftTarget = {
  mode: "worktree",
  branch: "main",
  branchSource: "branch",
  customBranchName: "",
  autoPreviewBranch: "",
  selectedWorktree: null,
  branchManuallySelected: false,
};

function payload(overrides: Partial<ThreadDraftPayload> = {}): ThreadDraftPayload {
  return { workspaceId: "ws-1", draft: composerDraft, selection, target, ...overrides };
}

describe("threadDraftStore", () => {
  beforeEach(() => {
    localStorage.clear();
    useThreadDraftStore.setState({ drafts: {} });
  });

  it("creates an entity with workspace ownership and timestamps", () => {
    const id = useThreadDraftStore.getState().saveDraft(payload());
    expect(id).toBeTruthy();
    const entity = useThreadDraftStore.getState().drafts[id!];
    expect(entity).toMatchObject({
      id,
      workspaceId: "ws-1",
      draft: composerDraft,
      selection,
      target,
    });
    expect(entity.createdAt).toBeGreaterThan(0);
    expect(entity.updatedAt).toBeGreaterThanOrEqual(entity.createdAt);
  });

  it("persists entities to localStorage", () => {
    const id = useThreadDraftStore.getState().saveDraft(payload());
    const stored = JSON.parse(localStorage.getItem("mcode-thread-drafts") ?? "{}");
    expect(stored.state.drafts[id!].draft.input).toBe("unsent message");
    expect(stored.state.drafts[id!].workspaceId).toBe("ws-1");
  });

  it("removes the entity when the draft empties and ignores fresh empty saves", () => {
    const id = useThreadDraftStore.getState().saveDraft(payload())!;
    const result = useThreadDraftStore.getState().saveDraft(
      payload({ id, draft: { ...composerDraft, input: "  " } }),
    );
    expect(result).toBeNull();
    expect(useThreadDraftStore.getState().drafts[id]).toBeUndefined();

    expect(
      useThreadDraftStore.getState().saveDraft(
        payload({ draft: { ...composerDraft, input: "" } }),
      ),
    ).toBeNull();
    expect(Object.keys(useThreadDraftStore.getState().drafts)).toHaveLength(0);
  });

  it("skips identical writes so reopening a draft does not reorder it", () => {
    const store = useThreadDraftStore.getState();
    const id = store.saveDraft(payload())!;
    const first = useThreadDraftStore.getState().drafts[id];
    useThreadDraftStore.getState().saveDraft(payload({ id }));
    const second = useThreadDraftStore.getState().drafts[id];
    expect(second.updatedAt).toBe(first.updatedAt);
    expect(second).toBe(first);
  });

  it("removes only the removed workspace's drafts", () => {
    const store = useThreadDraftStore.getState();
    const mine = store.saveDraft(payload({ workspaceId: "ws-1" }))!;
    const other = store.saveDraft(payload({ workspaceId: "ws-2" }))!;
    useThreadDraftStore.getState().removeWorkspaceDrafts("ws-1");
    expect(useThreadDraftStore.getState().drafts[mine]).toBeUndefined();
    expect(useThreadDraftStore.getState().drafts[other]).toBeDefined();
  });

  it("releases attachment resources when a draft is removed", () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const id = useThreadDraftStore.getState().saveDraft(
      payload({
        draft: {
          ...composerDraft,
          attachments: [{
            id: "a1",
            name: "x.png",
            mimeType: "image/png",
            sizeBytes: 1,
            previewUrl: "blob:live",
            filePath: "C:/tmp/x.png",
          }],
        },
      }),
    )!;
    useThreadDraftStore.getState().removeDraft(id);
    expect(revoke).toHaveBeenCalledWith("blob:live");
    expect(useThreadDraftStore.getState().drafts[id]).toBeUndefined();
    revoke.mockRestore();
  });

  it("restores a removed entity verbatim for dispatch rollback", () => {
    const store = useThreadDraftStore.getState();
    const id = store.saveDraft(payload())!;
    const entity = useThreadDraftStore.getState().drafts[id];
    useThreadDraftStore.getState().removeDraftAfterAttachmentTransfer(id);
    expect(useThreadDraftStore.getState().drafts[id]).toBeUndefined();
    useThreadDraftStore.getState().restoreDraft(entity);
    expect(useThreadDraftStore.getState().drafts[id]).toBe(entity);
  });
});
