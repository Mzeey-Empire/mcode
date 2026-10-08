import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { PendingAttachment } from "@/components/chat/AttachmentPreview";
import type {
  ContextWindowMode,
  DevinMode,
  DraftDiffComment,
  DraftSubmission,
  MessageMention,
  PlanCommentSelection,
  ReasoningLevel,
  SelectedTextComment,
  SelectedTextCommentSource,
} from "@mcode/contracts";
import type { DiffCommentTarget } from "@/features/conversation/composer/draft/draft-submission";
import {
  collectSpillPathsFromPendingAttachments,
  releaseBrowserCaptureSpills,
} from "@/features/preview/capture/browser-capture-spill";
import {
  canPersistComposerDraft,
  composerDraftStorage,
  parseStoredComposerDraft,
  serializeComposerDraft,
} from "@/lib/composer-draft-storage";

/** Restorable open-editor state for one selected-text comment in a ComposerDraft. */
export interface SelectedTextCommentEditorDraft {
  /** The immutable selected-text source that the editor targets. */
  source: SelectedTextCommentSource;
  /** Saved comment being edited. Omit while the editor creates a new comment. */
  commentId?: string;
  /** Current note text, including unsaved changes. */
  note: string;
  /** Current structured mention metadata, including unsaved changes. */
  mentions: MessageMention[];
  /** The first Escape warning has been shown. */
  escapeWarned: boolean;
  /** The first close or outside warning has been shown. */
  outsideWarned: boolean;
  /** The editor is anchored to its source range or to an aggregate card. */
  anchor: "source" | "card";
}

/** Restorable open-editor state for one Review line comment. */
export interface DiffCommentEditorDraft {
  /** Line the editor is anchored to. */
  target: DiffCommentTarget;
  /** Saved comment being edited. Omit while the editor creates a new comment. */
  annotationId?: string;
  /** Current note text, including unsaved changes. */
  note: string;
  /** Current structured mention metadata, including unsaved changes. */
  mentions: MessageMention[];
}

/**
 * Draft state for a single composer instance, keyed by thread ID.
 *
 * The composer owns the message fields and writes them as one snapshot. The
 * next-message fields (Review comments, their editor, the plan-comment
 * selection and pending submissions) are written only through
 * {@link ComposerDraftState.updateNextMessage}, because other surfaces edit
 * them while the composer holds an older snapshot.
 */
export interface ComposerDraft {
  input: string;
  mentions?: MessageMention[];
  /** Saved selected-text comments awaiting persistence with this draft. */
  selectedTextComments?: SelectedTextComment[];
  /** Open selected-text comment editor state restored with this draft. */
  selectedTextCommentEditor?: SelectedTextCommentEditorDraft;
  attachments: PendingAttachment[];
  modelId: string;
  /** Provider ID stored alongside the model because multiple providers share model IDs. */
  provider?: string;
  reasoning: ReasoningLevel;
  /**
   * Per-thread context window override. Undefined falls back to the thread's
   * persisted mode (or the global settings default). Honored only by Claude
   * provider for models that support a 1M-context beta header.
   */
  contextWindow?: ContextWindowMode;
  /**
   * Per-thread thinking toggle override. Undefined falls back to the thread's
   * persisted toggle (or the global settings default). Honored only by models
   * that expose a thinking toggle (Haiku 4.5).
   */
  /**
   * Per-thread Codex fast-tier override. Undefined in drafts means "not captured
   * in this saved draft"; Composer falls back to thread settings.
   */
  codexFastMode?: boolean | null;
  /** Per-thread Devin native mode (normal|accept-edits|smart|bypass|plan). */
  devinMode?: DevinMode | null;
  /** Saved Review line comments riding the next Send. */
  diffComments?: DraftDiffComment[];
  /** Open Review comment editor, restored with this draft. */
  diffCommentEditor?: DiffCommentEditorDraft;
  /** Plan comments chosen to ride the next Send; S07-06 renders the chip. */
  planCommentSelection?: PlanCommentSelection;
  /** Sends whose admission has not settled. */
  submissions?: DraftSubmission[];
}

/** Fields that only {@link ComposerDraftState.updateNextMessage} writes. */
export type NextMessageFields = Pick<
  ComposerDraft,
  "diffComments" | "diffCommentEditor" | "planCommentSelection" | "submissions"
>;

function nextMessageFields(draft: ComposerDraft | undefined): NextMessageFields {
  return {
    diffComments: draft?.diffComments,
    diffCommentEditor: draft?.diffCommentEditor,
    planCommentSelection: draft?.planCommentSelection,
    submissions: draft?.submissions,
  };
}

/** Composer fields of a draft created by a next-message write before the composer saved one. */
const NO_COMPOSER_STATE: Omit<ComposerDraft, keyof NextMessageFields> = {
  input: "",
  attachments: [],
  modelId: "",
  reasoning: "medium",
};

/**
 * True when the draft holds only next-message fields. Session restore must
 * ignore its placeholder model and fall back to the thread's settings.
 */
export function isNextMessageOnlyDraft(draft: ComposerDraft): boolean {
  return draft.modelId === ""
    && draft.input === ""
    && draft.attachments.length === 0
    && (draft.selectedTextComments?.length ?? 0) === 0
    && !draft.selectedTextCommentEditor;
}

interface ComposerDraftState {
  drafts: Record<string, ComposerDraft>;

  /** Prefill text set by the empty-state prompt chips, consumed once by the Composer. */
  pendingPrefill: string | null;

  /** Save a draft for a thread. Skips storage only when it has no sendable content. */
  saveDraft: (threadId: string, draft: ComposerDraft) => void;

  /** Retrieve the saved draft for a thread, or undefined if none exists. */
  getDraft: (threadId: string) => ComposerDraft | undefined;

  /** Remove the draft for a thread (e.g. after sending a message). */
  clearDraft: (threadId: string) => void;

  /** Remove a draft after the submitting Composer takes over attachment cleanup. */
  removeDraftAfterAttachmentTransfer: (threadId: string) => void;

  /**
   * Clear the composer's message fields after a Send. Next-message fields
   * stay, because pending submissions settle them on their own.
   */
  clearSentComposerFields: (threadId: string, options: { releaseAttachments: boolean }) => void;

  /** Apply a change to a thread's next-message fields, creating the draft when needed. */
  updateNextMessage: (threadId: string, update: (draft: ComposerDraft) => ComposerDraft) => void;

  /** Set a prefill text to be picked up by the Composer on next render. */
  setPendingPrefill: (text: string) => void;

  /** Clear the pending prefill after the Composer has consumed it. */
  clearPendingPrefill: () => void;
}

/** True when a draft carries nothing worth persisting or restoring. */
export function draftHasNoSendableContent(draft: ComposerDraft): boolean {
  return !hasComposerContent(draft) && !hasNextMessageContent(draft);
}

function hasComposerContent(draft: ComposerDraft): boolean {
  return draft.input.trim() !== ""
    || draft.attachments.length > 0
    || (draft.selectedTextComments?.length ?? 0) > 0
    || Boolean(draft.selectedTextCommentEditor);
}

function hasNextMessageContent(draft: ComposerDraft): boolean {
  return (draft.diffComments?.length ?? 0) > 0
    || Boolean(draft.diffCommentEditor)
    || hasPlanCommentSelection(draft.planCommentSelection)
    || (draft.submissions?.length ?? 0) > 0;
}

function hasPlanCommentSelection(selection: PlanCommentSelection | undefined): boolean {
  return Boolean(selection && (selection.includedIds.length > 0 || selection.excludedIds.length > 0));
}

/** Revokes preview URLs and releases capture spill files owned by these attachments. */
export function releaseComposerAttachmentResources(attachments: readonly PendingAttachment[]): void {
  for (const attachment of attachments) {
    if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
  }
  const spillPaths = collectSpillPathsFromPendingAttachments(attachments);
  if (spillPaths.length > 0) void releaseBrowserCaptureSpills(spillPaths);
}

function removeDraft(
  drafts: Record<string, ComposerDraft>,
  threadId: string,
): Record<string, ComposerDraft> {
  const nextDrafts = { ...drafts };
  delete nextDrafts[threadId];
  return nextDrafts;
}

function revokeReplacedAttachmentPreviewUrls(
  existing: ComposerDraft | undefined,
  draft: ComposerDraft,
): void {
  if (!existing) return;
  const retainedUrls = new Set(draft.attachments.map((attachment) => attachment.previewUrl));
  releaseComposerAttachmentResources(existing.attachments.filter(
    (attachment) => attachment.previewUrl && !retainedUrls.has(attachment.previewUrl),
  ));
}

function parseStoredDrafts(raw: unknown): Record<string, ComposerDraft> {
  if (!raw || typeof raw !== "object") return {};
  const drafts: Record<string, ComposerDraft> = {};
  for (const [threadId, value] of Object.entries(raw)) {
    const parsed = parseStoredComposerDraft(value);
    if (parsed) drafts[threadId] = parsed;
  }
  return drafts;
}

/** Zustand store for per-thread composer draft persistence. */
export const useComposerDraftStore = create<ComposerDraftState>()(
  persist(
    (set, get) => ({
      drafts: {},
      pendingPrefill: null,

      saveDraft: (threadId, composerDraft) => {
        const existing = get().drafts[threadId];
        const draft = { ...composerDraft, ...nextMessageFields(existing) };
        if (draftHasNoSendableContent(draft)) {
          // Don't store empty drafts; clean up if one existed
          if (!existing) return;
          releaseComposerAttachmentResources(existing.attachments);
          set({ drafts: removeDraft(get().drafts, threadId) });
          return;
        }
        // Revoke blob URLs from the previous draft that are not reused in the new one
        revokeReplacedAttachmentPreviewUrls(existing, draft);
        set({ drafts: { ...get().drafts, [threadId]: draft } });
      },

      getDraft: (threadId) => {
        return get().drafts[threadId];
      },

      clearDraft: (threadId) => {
        const draft = get().drafts[threadId];
        if (!draft) return;
        releaseComposerAttachmentResources(draft.attachments);
        set({ drafts: removeDraft(get().drafts, threadId) });
      },

      removeDraftAfterAttachmentTransfer: (threadId) => {
        if (!get().drafts[threadId]) return;
        set({ drafts: removeDraft(get().drafts, threadId) });
      },

      clearSentComposerFields: (threadId, { releaseAttachments }) => {
        const draft = get().drafts[threadId];
        if (!draft) return;
        if (releaseAttachments) releaseComposerAttachmentResources(draft.attachments);
        const remaining = { ...NO_COMPOSER_STATE, ...nextMessageFields(draft) };
        set({
          drafts: draftHasNoSendableContent(remaining)
            ? removeDraft(get().drafts, threadId)
            : { ...get().drafts, [threadId]: remaining },
        });
      },

      updateNextMessage: (threadId, update) => {
        const existing = get().drafts[threadId] ?? { ...NO_COMPOSER_STATE };
        const next = update(existing);
        if (next === existing) return;
        set({
          drafts: draftHasNoSendableContent(next)
            ? removeDraft(get().drafts, threadId)
            : { ...get().drafts, [threadId]: next },
        });
      },

      setPendingPrefill: (text) => set({ pendingPrefill: text }),

      clearPendingPrefill: () => set({ pendingPrefill: null }),
    }),
    {
      name: "mcode-composer-drafts",
      version: 2,
      // v2 only adds optional next-message fields, so v1 drafts load unchanged.
      migrate: (persisted) => persisted as { drafts: Record<string, ComposerDraft> },
      storage: createJSONStorage(() => composerDraftStorage),
      partialize: (state) => ({
        drafts: Object.fromEntries(
          Object.entries(state.drafts)
            .filter(([, draft]) => canPersistComposerDraft(draft))
            .map(([threadId, draft]) => [
              threadId,
              serializeComposerDraft(draft),
            ]),
        ),
      }),
      merge: (persisted, current) => ({
        ...current,
        drafts: parseStoredDrafts(
          (persisted as { drafts?: unknown } | undefined)?.drafts,
        ),
      }),
    },
  ),
);
