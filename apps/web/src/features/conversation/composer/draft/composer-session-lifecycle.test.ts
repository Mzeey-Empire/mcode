import { describe, expect, it, vi } from "vitest";
import { INTERACTION_MODES } from "@/transport";
import { ORCHESTRATION_MODES } from "@mcode/contracts";
import type { ComposerDraft } from "@/stores/composerDraftStore";
import type { ThreadDraft } from "@/stores/threadDraftStore";
import {
  resolveComposerSessionForOwner,
  transitionComposerDraftOwner,
} from "./composer-session-lifecycle";

const draft: ComposerDraft = {
  input: "carry me",
  attachments: [],
  modelId: "gpt-5.5",
  provider: "codex",
  reasoning: "high",
};

function entity(overrides: Partial<ThreadDraft> = {}): ThreadDraft {
  return {
    id: "draft-1",
    workspaceId: "ws-1",
    createdAt: 1,
    updatedAt: 2,
    draft,
    selection: {
      interactionMode: INTERACTION_MODES.PLAN,
      permissionMode: "full",
      orchestrationMode: ORCHESTRATION_MODES.PROACTIVE,
      approvalReviewMode: "automatic",
      copilotAgent: "sub-agent",
      thinking: true,
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
    ...overrides,
  };
}

describe("transitionComposerDraftOwner", () => {
  it("does nothing when the owner did not change or was the fresh composer", () => {
    const saveDraft = vi.fn();
    const ownerExists = vi.fn(() => true);
    transitionComposerDraftOwner({
      previousOwnerKey: "draft:1",
      nextOwnerKey: "draft:1",
      draft,
      ownerExists,
      saveDraft,
    });
    transitionComposerDraftOwner({
      previousOwnerKey: "new",
      nextOwnerKey: "draft:1",
      draft,
      ownerExists,
      saveDraft,
    });
    expect(saveDraft).not.toHaveBeenCalled();
    expect(ownerExists).not.toHaveBeenCalled();
  });

  it("saves the departing draft when its owner still exists", () => {
    const saveDraft = vi.fn();
    transitionComposerDraftOwner({
      previousOwnerKey: "draft:1",
      nextOwnerKey: "thread:t1",
      draft,
      ownerExists: () => true,
      saveDraft,
    });
    expect(saveDraft).toHaveBeenCalledWith("draft:1", draft);
  });

  it("releases attachment resources when the departed owner is gone", () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const saveDraft = vi.fn();
    transitionComposerDraftOwner({
      previousOwnerKey: "draft:gone",
      nextOwnerKey: "new",
      draft: {
        ...draft,
        attachments: [{
          id: "a1",
          name: "x.png",
          mimeType: "image/png",
          sizeBytes: 1,
          previewUrl: "blob:orphan",
          filePath: "C:/tmp/x.png",
        }],
      },
      ownerExists: () => false,
      saveDraft,
    });
    expect(saveDraft).not.toHaveBeenCalled();
    expect(revoke).toHaveBeenCalledWith("blob:orphan");
    revoke.mockRestore();
  });
});

describe("resolveComposerSessionForOwner", () => {
  it("returns an empty session for the fresh composer", () => {
    const session = resolveComposerSessionForOwner({
      owner: { kind: "new" },
      getDraft: () => undefined,
      getThreadDraft: () => undefined,
    });
    expect(session.input).toBe("");
    expect(session.attachments).toEqual([]);
  });

  it("restores input and draft-owned modes from the entity", () => {
    const session = resolveComposerSessionForOwner({
      owner: { kind: "draft", id: "draft-1" },
      getDraft: () => undefined,
      getThreadDraft: (id) =>
        id === "draft-1" ? entity() : undefined,
    });
    expect(session.input).toBe("carry me");
    expect(session.interactionMode).toBe(INTERACTION_MODES.PLAN);
    expect(session.orchestrationMode).toBe(ORCHESTRATION_MODES.PROACTIVE);
    expect(session.approvalReviewMode).toBe("automatic");
    expect(session.copilotAgent).toBe("sub-agent");
    expect(session.thinking).toBe(true);
    expect(session.modelId).toBe("gpt-5.5");
    expect(session.provider).toBe("codex");
  });

  it("falls back to an empty session when the entity is gone", () => {
    const session = resolveComposerSessionForOwner({
      owner: { kind: "draft", id: "missing" },
      getDraft: () => undefined,
      getThreadDraft: () => undefined,
    });
    expect(session.input).toBe("");
  });
});
