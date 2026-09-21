import { useCallback, useRef, useState, type MutableRefObject } from "react";
import type { LexicalEditor } from "lexical";
import type { MessageMention, SelectedTextComment } from "@mcode/contracts";
import { cn } from "@/lib/utils";
import type { SelectedTextCommentEditorDraft } from "@/stores/composerDraftStore";
import type { SelectedTextCommentSource } from "../selected-text-projection";
import {
  buildSelectedTextComment,
  canSaveSelectedTextComment,
} from "./comment-editor-model";
import {
  CommentEditorComposer,
  CommentEditorControls,
  useCommentDismissal,
} from "./comment-editor-primitives";

const EMPTY_MENTIONS: readonly MessageMention[] = [];
const COMMENT_EDITOR_VERTICAL_CHROME = 10;

/** Props for the compact editor that creates or updates one selected-text comment. */
export interface SelectedTextCommentEditorProps {
  /** Immutable source captured from the pointer selection. */
  readonly source: SelectedTextCommentSource;
  /** Saved comment to edit. Omit for a new comment. */
  readonly comment?: SelectedTextComment;
  /** Persisted editor state to restore after a thread switch. */
  readonly draft?: SelectedTextCommentEditorDraft;
  /** Creation-order display number for a new saved comment. */
  readonly nextDisplayNumber?: number;
  /** Workspace that scopes mention and slash suggestions. */
  readonly workspaceId?: string;
  /** Provider that scopes mention and slash suggestions. */
  readonly providerId?: string;
  /** Maximum visible editor height derived from the transcript viewport. */
  readonly maxHeight?: number;
  /** Receives the compact Lexical editor for owner-managed focus. */
  readonly editorRef?: MutableRefObject<LexicalEditor | null>;
  /** Receives the rendered editor element for current-size positioning. */
  readonly onElementChange?: (element: HTMLElement | null) => void;
  /** Stores the saved comment state. */
  readonly onSave: (comment: SelectedTextComment) => void;
  /** Removes the saved comment state. */
  readonly onDelete?: (comment: SelectedTextComment) => void;
  /** Persists note, mention, and dismissal-warning changes without saving the comment. */
  readonly onDraftChange?: (draft: SelectedTextCommentEditorDraft) => void;
  /** Closes the editor and optionally restores focus to its invoker. */
  readonly onClose: (options?: { readonly restoreFocus?: boolean }) => void;
  /** Announces editor state changes to the persistent live region. */
  readonly onAnnouncement: (message: string) => void;
}

function mentionsMatch(left: readonly MessageMention[], right: readonly MessageMention[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function savedCommentContent(comment: SelectedTextComment | undefined) {
  return {
    note: comment?.note ?? "",
    mentions: comment?.mentions ?? EMPTY_MENTIONS,
  };
}

function useSelectedTextCommentContent(
  comment: SelectedTextComment | undefined,
  draft: SelectedTextCommentEditorDraft | undefined,
) {
  const { note: savedNote, mentions: savedMentions } = savedCommentContent(comment);
  const initialContentRef = useRef({
    note: draft?.note ?? savedNote,
    mentions: [...(draft?.mentions ?? savedMentions)],
  });
  const [note, setNote] = useState(initialContentRef.current.note);
  const [mentions, setMentions] = useState<MessageMention[]>(initialContentRef.current.mentions);
  return {
    initialContent: initialContentRef.current,
    note,
    mentions,
    setNote,
    setMentions,
    canSave: canSaveSelectedTextComment(note, mentions),
    isDirty: note !== savedNote || !mentionsMatch(mentions, savedMentions),
  };
}

function createEditorDraft(
  source: SelectedTextCommentSource,
  comment: SelectedTextComment | undefined,
  draft: SelectedTextCommentEditorDraft | undefined,
  note: string,
  mentions: MessageMention[],
  escapeWarned: boolean,
  outsideWarned: boolean,
): SelectedTextCommentEditorDraft {
  return {
    source,
    commentId: comment?.id,
    note,
    mentions,
    escapeWarned,
    outsideWarned,
    anchor: draft?.anchor ?? "source",
  };
}

function useSelectedTextCommentEditorActions({
  source,
  comment,
  draft,
  nextDisplayNumber,
  note,
  mentions,
  canSave,
  setNote,
  setMentions,
  resetWarnings,
  onDraftChange,
  onSave,
  onDelete,
  onClose,
  onAnnouncement,
}: {
  readonly source: SelectedTextCommentSource;
  readonly comment: SelectedTextComment | undefined;
  readonly draft: SelectedTextCommentEditorDraft | undefined;
  readonly nextDisplayNumber: number;
  readonly note: string;
  readonly mentions: MessageMention[];
  readonly canSave: boolean;
  readonly setNote: (note: string) => void;
  readonly setMentions: (mentions: MessageMention[]) => void;
  readonly resetWarnings: () => void;
  readonly onDraftChange: SelectedTextCommentEditorProps["onDraftChange"];
  readonly onSave: (comment: SelectedTextComment) => void;
  readonly onDelete: SelectedTextCommentEditorProps["onDelete"];
  readonly onClose: SelectedTextCommentEditorProps["onClose"];
  readonly onAnnouncement: (message: string) => void;
}) {
  const persist = useCallback((nextNote: string, nextMentions: MessageMention[]) => {
    const nextDraft = createEditorDraft(
      source,
      comment,
      draft,
      nextNote,
      nextMentions,
      false,
      false,
    );
    onDraftChange?.(nextDraft);
  }, [comment, draft, onDraftChange, source]);
  const handleChange = useCallback((nextNote: string, nextMentions: MessageMention[]) => {
    setNote(nextNote);
    setMentions(nextMentions);
    resetWarnings();
    persist(nextNote, nextMentions);
  }, [persist, resetWarnings, setMentions, setNote]);
  const save = useCallback(() => {
    if (!canSave) return;
    const nextComment = buildSelectedTextComment({
      comment,
      source,
      note,
      mentions,
      displayNumber: nextDisplayNumber,
    });
    resetWarnings();
    onSave(nextComment);
    onAnnouncement(`Comment ${nextComment.displayNumber} ${comment ? "updated" : "added"}.`);
    if (comment) onClose();
    else onClose({ restoreFocus: false });
  }, [canSave, comment, mentions, nextDisplayNumber, note, onAnnouncement, onClose, onSave, resetWarnings, source]);
  const deleteComment = useCallback(() => {
    if (!comment || !onDelete) return;
    resetWarnings();
    onDelete(comment);
    onAnnouncement("Comment deleted.");
    onClose({ restoreFocus: false });
  }, [comment, onAnnouncement, onClose, onDelete, resetWarnings]);
  return { handleChange, save, deleteComment };
}

/** Renders the prototype compact ComposerEditor and comment dismissal policy. */
export function SelectedTextCommentEditor({
  source,
  comment,
  draft,
  nextDisplayNumber = 1,
  workspaceId,
  providerId,
  maxHeight,
  editorRef: providedEditorRef,
  onSave,
  onDelete,
  onDraftChange,
  onClose,
  onElementChange,
  onAnnouncement,
}: SelectedTextCommentEditorProps) {
  const rootRef = useRef<HTMLElement | null>(null);
  const ownedEditorRef = useRef<LexicalEditor | null>(null);
  const editorRef = providedEditorRef ?? ownedEditorRef;
  const setRootElement = useCallback((element: HTMLElement | null) => {
    rootRef.current = element;
    onElementChange?.(element);
  }, [onElementChange]);
  const focusNoteOnMount = useCallback((element: HTMLDivElement | null) => {
    element?.focus();
  }, []);
  const isPopupOpenRef = useRef(false);
  const content = useSelectedTextCommentContent(comment, draft);
  const { isShaking, resetWarnings } = useCommentDismissal({
    rootRef,
    isDirty: content.isDirty,
    isPopupOpenRef,
    onClose,
    onAnnouncement,
    onWarningsChange: (escapeWarned, outsideWarned) => {
      onDraftChange?.(createEditorDraft(
        source,
        comment,
        draft,
        content.note,
        content.mentions,
        escapeWarned,
        outsideWarned,
      ));
    },
    initialEscapeWarned: draft?.escapeWarned,
    initialOutsideWarned: draft?.outsideWarned,
  });
  const { handleChange, save, deleteComment } = useSelectedTextCommentEditorActions({
    source,
    comment,
    draft,
    nextDisplayNumber,
    note: content.note,
    mentions: content.mentions,
    canSave: content.canSave,
    setNote: content.setNote,
    setMentions: content.setMentions,
    resetWarnings,
    onDraftChange,
    onSave,
    onDelete,
    onClose,
    onAnnouncement,
  });

  return (
    <section
      ref={setRootElement}
      role="dialog"
      aria-label="Comment on selected text"
      style={{ maxHeight }}
      className={cn(
        "relative overflow-hidden rounded-2xl border border-border/70 bg-popover text-popover-foreground shadow-lg",
        isShaking && "animate-preview-annotation-shake",
      )}
    >
      <div className="flex items-center gap-1.5 px-2 py-1">
        <div className="min-w-0 flex-1 overflow-hidden">
          <CommentEditorComposer
            threadId={source.threadId}
            workspaceId={workspaceId}
            providerId={providerId}
            savedNote={content.initialContent.note}
            savedMentions={content.initialContent.mentions}
            editorRef={editorRef}
            contentEditableRef={focusNoteOnMount}
            rootRef={rootRef}
            isPopupOpenRef={isPopupOpenRef}
            maxHeight={maxHeight === undefined ? undefined : Math.max(0, maxHeight - COMMENT_EDITOR_VERTICAL_CHROME)}
            onChange={handleChange}
            onSubmit={save}
          />
        </div>
        <CommentEditorControls
          editing={comment != null}
          canSave={content.canSave}
          onSave={save}
          onDelete={onDelete ? deleteComment : undefined}
          onClose={onClose}
        />
      </div>
    </section>
  );
}
