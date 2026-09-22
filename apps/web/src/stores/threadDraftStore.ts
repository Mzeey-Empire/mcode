import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type {
  ApprovalReviewMode,
  OrchestrationMode,
  WorktreeInfo,
} from "@mcode/contracts";
import type {
  InteractionMode,
  PermissionMode,
} from "@/transport";
import {
  draftHasNoSendableContent,
  releaseComposerAttachmentResources,
  type ComposerDraft,
} from "@/stores/composerDraftStore";
import {
  canPersistComposerDraft,
  composerDraftStorage,
  parseStoredComposerDraft,
  serializeComposerDraft,
} from "@/lib/composer-draft-storage";

/** New-thread execution target captured with a draft so reopening restores it. */
export interface ThreadDraftTarget {
  mode: "direct" | "worktree" | "existing-worktree";
  branch: string;
  branchSource: "branch" | "pr";
  pullRequestNumber?: number;
  customBranchName: string;
  autoPreviewBranch: string;
  selectedWorktree: WorktreeInfo | null;
  branchManuallySelected: boolean;
}

/** Agent-selection fields that live outside ComposerDraft for new-thread drafts. */
export interface ThreadDraftSelection {
  interactionMode: InteractionMode;
  permissionMode: PermissionMode;
  orchestrationMode: OrchestrationMode;
  approvalReviewMode: ApprovalReviewMode;
  copilotAgent: string | null;
  thinking: boolean | null;
}

/** A local-only unsent new-thread draft shown as a row above a project's threads. */
export interface ThreadDraft {
  id: string;
  workspaceId: string;
  createdAt: number;
  updatedAt: number;
  draft: ComposerDraft;
  selection: ThreadDraftSelection;
  target: ThreadDraftTarget;
}

/** Payload required to create or update a draft entity. */
export interface ThreadDraftPayload {
  id?: string;
  workspaceId: string;
  draft: ComposerDraft;
  selection: ThreadDraftSelection;
  target: ThreadDraftTarget;
}

interface ThreadDraftState {
  drafts: Record<string, ThreadDraft>;

  /**
   * Creates or updates a draft entity and returns its id. An empty draft
   * removes the entity instead; identical payloads skip the write so opening
   * a draft does not reorder the list.
   */
  saveDraft: (payload: ThreadDraftPayload) => string | null;

  /** Removes a draft and releases its attachment resources. */
  removeDraft: (id: string) => void;

  /** Removes a draft without releasing attachments that were detached for dispatch. */
  removeDraftAfterAttachmentTransfer: (id: string) => void;

  /** Restores a previously removed entity verbatim (dispatch rollback). */
  restoreDraft: (draft: ThreadDraft) => void;

  /** Drops every draft owned by a removed workspace. */
  removeWorkspaceDrafts: (workspaceId: string) => void;
}

function sameDraftPayload(a: ThreadDraft, b: ThreadDraftPayload): boolean {
  return a.workspaceId === b.workspaceId
    && JSON.stringify(serializeComposerDraft(a.draft))
      === JSON.stringify(serializeComposerDraft(b.draft))
    && JSON.stringify(a.selection) === JSON.stringify(b.selection)
    && JSON.stringify(a.target) === JSON.stringify(b.target);
}

function isValidStoredSelection(raw: unknown): raw is ThreadDraftSelection {
  if (!raw || typeof raw !== "object") return false;
  const s = raw as Partial<ThreadDraftSelection>;
  return typeof s.interactionMode === "string"
    && typeof s.permissionMode === "string"
    && typeof s.orchestrationMode === "string"
    && typeof s.approvalReviewMode === "string"
    && (s.copilotAgent === null || typeof s.copilotAgent === "string")
    && (s.thinking === null || typeof s.thinking === "boolean");
}

function isValidTargetBranch(t: Partial<ThreadDraftTarget>): boolean {
  return typeof t.branch === "string"
    && (t.branchSource === "branch" || t.branchSource === "pr")
    && (t.pullRequestNumber === undefined || typeof t.pullRequestNumber === "number")
    && typeof t.customBranchName === "string"
    && typeof t.autoPreviewBranch === "string";
}

function isValidStoredTarget(raw: unknown): raw is ThreadDraftTarget {
  if (!raw || typeof raw !== "object") return false;
  const t = raw as Partial<ThreadDraftTarget>;
  const validMode = t.mode === "direct" || t.mode === "worktree" || t.mode === "existing-worktree";
  return validMode
    && isValidTargetBranch(t)
    && (t.selectedWorktree === null || typeof t.selectedWorktree === "object")
    && typeof t.branchManuallySelected === "boolean";
}

function isValidStoredThreadDraft(raw: unknown): raw is ThreadDraft {
  if (!raw || typeof raw !== "object") return false;
  const candidate = raw as Partial<ThreadDraft>;
  return typeof candidate.id === "string"
    && typeof candidate.workspaceId === "string"
    && typeof candidate.createdAt === "number"
    && typeof candidate.updatedAt === "number"
    && candidate.draft !== undefined
    && isValidStoredSelection(candidate.selection)
    && isValidStoredTarget(candidate.target);
}

function parseStoredThreadDrafts(raw: unknown): Record<string, ThreadDraft> {
  if (!raw || typeof raw !== "object") return {};
  const drafts: Record<string, ThreadDraft> = {};
  for (const [id, value] of Object.entries(raw)) {
    if (!isValidStoredThreadDraft(value)) continue;
    const draft = parseStoredComposerDraft(value.draft);
    if (!draft) continue;
    drafts[id] = { ...value, id, draft };
  }
  return drafts;
}

/** Zustand store for unsent new-thread drafts persisted per workspace. */
export const useThreadDraftStore = create<ThreadDraftState>()(
  persist(
    (set, get) => ({
      drafts: {},

      saveDraft: (payload) => {
        const id = payload.id ?? crypto.randomUUID();
        const existing = get().drafts[id];
        if (draftHasNoSendableContent(payload.draft)) {
          if (!existing) return null;
          releaseComposerAttachmentResources(existing.draft.attachments);
          const next = { ...get().drafts };
          delete next[id];
          set({ drafts: next });
          return null;
        }
        if (existing && sameDraftPayload(existing, payload)) return id;
        const now = Date.now();
        set({
          drafts: {
            ...get().drafts,
            [id]: {
              id,
              workspaceId: payload.workspaceId,
              createdAt: existing?.createdAt ?? now,
              updatedAt: now,
              draft: payload.draft,
              selection: payload.selection,
              target: payload.target,
            },
          },
        });
        return id;
      },

      removeDraft: (id) => {
        const existing = get().drafts[id];
        if (!existing) return;
        releaseComposerAttachmentResources(existing.draft.attachments);
        const next = { ...get().drafts };
        delete next[id];
        set({ drafts: next });
      },

      removeDraftAfterAttachmentTransfer: (id) => {
        if (!get().drafts[id]) return;
        const next = { ...get().drafts };
        delete next[id];
        set({ drafts: next });
      },

      restoreDraft: (draft) => {
        set({ drafts: { ...get().drafts, [draft.id]: draft } });
      },

      removeWorkspaceDrafts: (workspaceId) => {
        const entries = Object.entries(get().drafts);
        if (!entries.some(([, draft]) => draft.workspaceId === workspaceId)) return;
        const next: Record<string, ThreadDraft> = {};
        for (const [id, draft] of entries) {
          if (draft.workspaceId === workspaceId) {
            releaseComposerAttachmentResources(draft.draft.attachments);
            continue;
          }
          next[id] = draft;
        }
        set({ drafts: next });
      },
    }),
    {
      name: "mcode-thread-drafts",
      version: 1,
      storage: createJSONStorage(() => composerDraftStorage),
      partialize: (state) => ({
        drafts: Object.fromEntries(
          Object.entries(state.drafts)
            .filter(([, draft]) => canPersistComposerDraft(draft.draft))
            .map(([id, draft]) => [
              id,
              { ...draft, draft: serializeComposerDraft(draft.draft) },
            ]),
        ),
      }),
      merge: (persisted, current) => ({
        ...current,
        drafts: parseStoredThreadDrafts(
          (persisted as { drafts?: unknown } | undefined)?.drafts,
        ),
      }),
    },
  ),
);
