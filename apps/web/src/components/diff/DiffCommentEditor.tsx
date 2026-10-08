import { useCallback, useRef, useState, type MutableRefObject } from "react";
import type { LexicalEditor } from "lexical";
import { MessageCircle } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { DraftDiffComment, MessageMention } from "@mcode/contracts";
import { basename } from "@/lib/path";
import {
  CommentEditorComposer,
  CommentEditorControls,
  useCommentDismissal,
} from "@/features/conversation/messages/selection/comment-editor-primitives";
import { useComposerDraftStore } from "@/stores/composerDraftStore";
import {
  canSaveDiffComment,
  deleteDraftDiffComment,
  saveDraftDiffComment,
  setDraftDiffCommentEditor,
} from "@/features/conversation/composer/draft/draft-diff-comments";
import type { DiffCommentTarget } from "@/features/conversation/composer/draft/draft-submission";

/** True when the note or its mentions differ from the saved comment, or from empty for a new one. */
function isEdited(
  note: string,
  mentions: readonly MessageMention[],
  annotation: DraftDiffComment | undefined,
): boolean {
  return note !== (annotation?.note ?? "")
    || JSON.stringify(mentions) !== JSON.stringify(annotation?.mentions ?? []);
}

/** Restores the open editor's unsaved text, else starts from the saved comment. */
function readInitialContent(
  threadId: string,
  annotation: DraftDiffComment | undefined,
): { note: string; mentions: MessageMention[] } {
  const editor = useComposerDraftStore.getState().drafts[threadId]?.diffCommentEditor;
  if (editor && editor.annotationId === annotation?.id) {
    return { note: editor.note, mentions: editor.mentions };
  }
  return { note: annotation?.note ?? "", mentions: [...(annotation?.mentions ?? [])] };
}

/** Props for the compact comment editor attached to a diff line. */
export interface DiffCommentEditorProps {
  /** Thread whose composer draft receives the saved comment. */
  readonly threadId: string;
  /** Line target and source context sent to the agent. */
  readonly target: DiffCommentTarget;
  /** Existing comment when the user is editing a saved line note. */
  readonly annotation?: DraftDiffComment;
  /** Workspace that scopes mention and slash suggestions. */
  readonly workspaceId?: string;
  /** Provider that scopes mention and slash suggestions. */
  readonly providerId?: string;
  /** Receives the compact Lexical editor for owner-managed focus. */
  readonly editorRef?: MutableRefObject<LexicalEditor | null>;
  /** Called after the editor closes; unsaved text persists in the composer draft. */
  readonly onClose: () => void;
}

/**
 * Diff line comment editor rendered inline at the annotated line. Uses the
 * same compact ComposerEditor, controls, and dismissal policy as the
 * transcript "Add comment" feature. Saved comments and the open editor's
 * unsaved text and mentions persist in the thread's composer draft, so they
 * survive pierre's virtualizer unmounting the row and a reload. The diff row
 * frames it: the editor sits in the row's flow rather than floating, because the
 * virtualizer unmounts rows that a floating anchor would point at.
 */
export function DiffCommentEditor({
  threadId,
  target,
  annotation,
  workspaceId,
  providerId,
  editorRef: providedEditorRef,
  onClose,
}: DiffCommentEditorProps) {
  const rootRef = useRef<HTMLElement | null>(null);
  const ownedEditorRef = useRef<LexicalEditor | null>(null);
  const editorRef = providedEditorRef ?? ownedEditorRef;
  const isPopupOpenRef = useRef(false);
  const [initialDraft] = useState(() => readInitialContent(threadId, annotation));
  const [note, setNote] = useState(initialDraft.note);
  const [mentions, setMentions] = useState<MessageMention[]>(initialDraft.mentions);
  // Composer's savedNote effect rewrites the editor on change, so it must see
  // the initial draft only; live state would echo every keystroke back in.
  const initialNote = useRef(note).current;
  const initialMentions = useRef(mentions).current;

  const isDirty = isEdited(note, mentions, annotation);
  const canSave = canSaveDiffComment(note, mentions);

  const { isShaking, resetWarnings } = useCommentDismissal({
    rootRef,
    isDirty,
    isPopupOpenRef,
    onClose,
  });

  const handleChange = useCallback((nextNote: string, nextMentions: MessageMention[]) => {
    setNote(nextNote);
    setMentions(nextMentions);
    resetWarnings();
    setDraftDiffCommentEditor(threadId, {
      target,
      annotationId: annotation?.id,
      note: nextNote,
      mentions: nextMentions,
    });
  }, [annotation?.id, resetWarnings, target, threadId]);

  const close = useCallback(() => {
    setDraftDiffCommentEditor(threadId, undefined);
    onClose();
  }, [onClose, threadId]);

  const save = useCallback(() => {
    if (!canSave) return;
    saveDraftDiffComment(threadId, target, { note, mentions }, annotation?.id);
    onClose();
  }, [annotation?.id, canSave, mentions, note, onClose, target, threadId]);

  const remove = useCallback(() => {
    if (annotation) deleteDraftDiffComment(threadId, annotation.id);
    close();
  }, [annotation, close, threadId]);

  return (
    <section
      ref={rootRef}
      role="dialog"
      aria-label={`Comment on ${target.filePath} line ${target.line}`}
      className="relative overflow-hidden"
      data-shaking={isShaking || undefined}
    >
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-1.5">
        <MessageCircle size={12} className="shrink-0 text-muted" aria-hidden />
        <Tooltip>
          <TooltipTrigger
            render={
              <span className="min-w-0 text-fade font-mono text-caption text-muted" />
            }
          >
            {basename(target.filePath)}:{target.line}
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {target.filePath}:{target.line}
          </TooltipContent>
        </Tooltip>
      </div>
      <div className="flex items-center gap-1.5 px-2 py-1">
        <div className="min-w-0 flex-1 overflow-hidden">
          <CommentEditorComposer
            threadId={threadId}
            workspaceId={workspaceId}
            providerId={providerId}
            savedNote={initialNote}
            savedMentions={initialMentions}
            editorRef={editorRef}
            contentEditableRef={(element) => element?.focus()}
            rootRef={rootRef}
            isPopupOpenRef={isPopupOpenRef}
            onChange={handleChange}
            onSubmit={save}
          />
        </div>
        <CommentEditorControls
          editing={annotation != null}
          canSave={canSave}
          onSave={save}
          onDelete={annotation ? remove : undefined}
          onClose={close}
        />
      </div>
    </section>
  );
}
