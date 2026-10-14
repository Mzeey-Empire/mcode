import { useCallback, useRef, useState } from "react";
import type { LexicalEditor } from "lexical";
import { Check, Trash2 } from "lucide-react";
import type { DraftFileComment, MessageMention } from "@mcode/contracts";
import {
  CommentEditorComposer,
  useCommentDismissal,
} from "@/features/conversation/messages/selection/comment-editor-primitives";
import { useComposerDraftStore } from "@/stores/composerDraftStore";
import {
  canSaveFileComment,
  deleteDraftFileComment,
  saveDraftFileComment,
  setDraftFileCommentEditor,
} from "@/features/conversation/composer/draft/draft-file-comments";
import type { FileCommentTarget } from "@/features/conversation/composer/draft/draft-submission";

/** Card chrome shared by the open editor and a saved comment. */
export const FILE_COMMENT_CARD_CLASS = "rounded-[10px] border border-control-border bg-panel text-body-small text-ink";

/** Row wrapper that starts the card at the code column, past the 44px line-number gutter. */
export const FILE_COMMENT_ROW_CLASS = "pt-1.5 pr-3 pb-2 pl-11 font-sans";

function isEdited(note: string, mentions: readonly MessageMention[], annotation: DraftFileComment | undefined): boolean {
  return note !== (annotation?.note ?? "")
    || JSON.stringify(mentions) !== JSON.stringify(annotation?.mentions ?? []);
}

function readInitialContent(
  threadId: string,
  annotation: DraftFileComment | undefined,
): { note: string; mentions: MessageMention[] } {
  const editor = useComposerDraftStore.getState().drafts[threadId]?.fileCommentEditor;
  if (editor && editor.annotationId === annotation?.id) {
    return { note: editor.note, mentions: editor.mentions };
  }
  return { note: annotation?.note ?? "", mentions: [...(annotation?.mentions ?? [])] };
}

/** Props for the comment editor opened under a Files code line. */
export interface FileCommentEditorProps {
  /** Thread whose composer draft receives the saved comment. */
  readonly threadId: string;
  /** Line target and source text sent to the agent. */
  readonly target: FileCommentTarget;
  /** Saved comment being edited, if any. */
  readonly annotation?: DraftFileComment;
  /** Workspace that scopes mention and slash suggestions. */
  readonly workspaceId?: string;
  /** Receives the Lexical editor, for tests and owner-managed focus. */
  readonly editorRef?: React.MutableRefObject<LexicalEditor | null>;
}

/**
 * Files line comment editor. Mirrors the Review DiffCommentEditor: the open
 * editor and its unsaved text live in the thread's composer draft, so the code
 * view's virtualizer unmounting it, or a reload, restores it as it was. Closing
 * always clears the draft's editor field, because that field is what keeps it open.
 */
export function FileCommentEditor({ threadId, target, annotation, workspaceId, editorRef: providedEditorRef }: FileCommentEditorProps) {
  const rootRef = useRef<HTMLElement | null>(null);
  const ownedEditorRef = useRef<LexicalEditor | null>(null);
  const editorRef = providedEditorRef ?? ownedEditorRef;
  const isPopupOpenRef = useRef(false);
  const [initialDraft] = useState(() => readInitialContent(threadId, annotation));
  const [note, setNote] = useState(initialDraft.note);
  const [mentions, setMentions] = useState<MessageMention[]>(initialDraft.mentions);

  const isDirty = isEdited(note, mentions, annotation);
  const canSave = canSaveFileComment(note, mentions);

  const close = useCallback(() => setDraftFileCommentEditor(threadId, undefined), [threadId]);
  const { isShaking, resetWarnings } = useCommentDismissal({ rootRef, isDirty, isPopupOpenRef, onClose: close });

  const handleChange = useCallback((nextNote: string, nextMentions: MessageMention[]) => {
    setNote(nextNote);
    setMentions(nextMentions);
    resetWarnings();
    setDraftFileCommentEditor(threadId, { target, annotationId: annotation?.id, note: nextNote, mentions: nextMentions });
  }, [annotation?.id, resetWarnings, target, threadId]);

  const save = useCallback(() => {
    if (!canSave) return;
    saveDraftFileComment(threadId, target, { note, mentions }, annotation?.id);
  }, [annotation?.id, canSave, mentions, note, target, threadId]);

  const remove = useCallback(() => {
    if (annotation) deleteDraftFileComment(threadId, annotation.id);
    close();
  }, [annotation, close, threadId]);

  return (
    <section
      ref={rootRef}
      role="dialog"
      aria-label={`Comment on ${target.filePath} line ${target.line}`}
      data-shaking={isShaking || undefined}
      className={FILE_COMMENT_ROW_CLASS}
    >
      <div className={`${FILE_COMMENT_CARD_CLASS} flex flex-col gap-2 pt-2.5 pr-2 pb-2 pl-3`}>
        <CommentEditorComposer
          threadId={threadId}
          workspaceId={workspaceId}
          savedNote={initialDraft.note}
          savedMentions={initialDraft.mentions}
          editorRef={editorRef}
          contentEditableRef={(element) => element?.focus()}
          rootRef={rootRef}
          isPopupOpenRef={isPopupOpenRef}
          submitOnEnter
          onChange={handleChange}
          onSubmit={save}
        />
        <div className="flex items-center gap-2">
          {annotation ? (
            <button
              type="button"
              aria-label="Delete comment"
              className="flex size-7 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-hover"
              onClick={remove}
            >
              <Trash2 size={14} aria-hidden />
            </button>
          ) : null}
          <span className="flex-1" />
          <button type="button" className="h-7 rounded-lg px-2.5 text-label text-muted hover:bg-hover" onClick={close}>
            Cancel
          </button>
          {canSave ? (
            <button
              type="button"
              aria-label={annotation ? "Save comment" : "Add comment"}
              className="flex size-7 items-center justify-center rounded-full bg-primary text-primary-ink"
              onClick={save}
            >
              <Check size={14} aria-hidden />
            </button>
          ) : null}
        </div>
      </div>
    </section>
  );
}
