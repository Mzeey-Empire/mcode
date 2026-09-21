import { useCallback, useRef, useState, type MutableRefObject } from "react";
import type { LexicalEditor } from "lexical";
import { MessageCircle } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { MessageMention } from "@mcode/contracts";
import { cn } from "@/lib/utils";
import { basename } from "@/lib/path";
import { canSaveSelectedTextComment } from "@/features/conversation/messages/selection/comment-editor-model";
import {
  CommentEditorComposer,
  CommentEditorControls,
  useCommentDismissal,
} from "@/features/conversation/messages/selection/comment-editor-primitives";
import {
  usePreviewAnnotationStore,
  type DiffAnnotationInput,
  type SavedDiffAnnotation,
} from "@/features/preview/state/previewAnnotationStore";

/**
 * Unsaved note text kept outside React so it survives pierre's virtualizer
 * unmounting the annotation row while the user types or scrolls.
 */
interface DiffCommentDraft {
  readonly note: string;
  readonly mentions: MessageMention[];
}

const draftCache = new Map<string, DiffCommentDraft>();

function draftKey(target: Omit<DiffAnnotationInput, "note" | "lineContent">, annotationId: string | undefined): string {
  return `${target.filePath}${target.side}:${target.line}:${annotationId ?? "new"}`;
}

/** Props for the compact comment editor attached to a diff line. */
export interface DiffCommentEditorProps {
  /** Thread whose composer bundle receives the saved comment. */
  readonly threadId: string;
  /** Line target and source context sent to the agent. */
  readonly target: Omit<DiffAnnotationInput, "note">;
  /** Existing annotation when the user is editing a saved line note. */
  readonly annotation?: SavedDiffAnnotation;
  /** Workspace that scopes mention and slash suggestions. */
  readonly workspaceId?: string;
  /** Provider that scopes mention and slash suggestions. */
  readonly providerId?: string;
  /** Receives the compact Lexical editor for owner-managed focus. */
  readonly editorRef?: MutableRefObject<LexicalEditor | null>;
  /** Closes the editor; drafts persist in the module cache. */
  readonly onClose: () => void;
}

/**
 * Diff line comment editor rendered inline at the annotated line. Uses the
 * same compact ComposerEditor, controls, and dismissal policy as the
 * transcript "Add comment" feature; persistence lands in
 * `previewAnnotationStore.diffByThread`.
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
  const key = draftKey(target, annotation?.id);
  const [note, setNote] = useState(() => draftCache.get(key)?.note ?? annotation?.note ?? "");
  const [mentions, setMentions] = useState<MessageMention[]>(() => draftCache.get(key)?.mentions ?? []);
  // Composer's savedNote effect rewrites the editor on change, so it must see
  // the initial draft only; live state would echo every keystroke back in.
  const initialNote = useRef(note).current;
  const initialMentions = useRef(mentions).current;

  const isDirty = note !== (annotation?.note ?? "") || mentions.length > 0;
  const canSave = canSaveSelectedTextComment(note, mentions);

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
    draftCache.set(key, { note: nextNote, mentions: nextMentions });
  }, [key, resetWarnings]);

  const close = useCallback(() => {
    draftCache.delete(key);
    onClose();
  }, [key, onClose]);

  const save = useCallback(() => {
    if (!canSave) return;
    usePreviewAnnotationStore
      .getState()
      .saveDiffAnnotation(threadId, { ...target, note }, annotation?.id);
    close();
  }, [annotation?.id, canSave, close, note, target, threadId]);

  const remove = useCallback(() => {
    if (annotation) {
      usePreviewAnnotationStore.getState().deleteAnnotation(threadId, annotation.id);
    }
    close();
  }, [annotation, close, threadId]);

  return (
    <section
      ref={rootRef}
      role="dialog"
      aria-label={`Comment on ${target.filePath} line ${target.line}`}
      className={cn(
        "relative overflow-hidden rounded-2xl border border-border/70 bg-popover text-popover-foreground shadow-lg",
        isShaking && "animate-preview-annotation-shake",
      )}
    >
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-1.5">
        <MessageCircle size={12} className="shrink-0 text-muted-foreground" aria-hidden />
        <Tooltip>
          <TooltipTrigger
            render={
              <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground" />
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
