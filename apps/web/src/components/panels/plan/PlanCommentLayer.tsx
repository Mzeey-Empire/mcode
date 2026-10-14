import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { EditorView } from "@codemirror/view";
import type { PlanComment, PlanCommentEditorDraft, PlanVersion } from "@mcode/contracts";
import { useComposerDraftStore } from "@/stores/composerDraftStore";
import { carriedOriginalIds, usePlanStore } from "@/stores/planStore";
import { PlanCommentEditor } from "./PlanCommentEditor";
import { PlanCommentRow } from "./PlanCommentRow";
import {
  deletePlanComment,
  resolvePlanComment,
  savePlanComment,
  setPlanCommentEditor,
  setPlanCommentEditorBody,
} from "./plan-comment-actions";
import { createPlanCommentAnchor, resolveAnchorRange } from "./plan-comment-anchor";
import { setPlanCommentMarks, type PlanCommentBinding } from "./plan-comment-extension";
import type { PlanCommentMark } from "./plan-comment-marks";

const NO_COMMENTS: readonly PlanComment[] = [];
const NEW_COMMENT_MARK = "new";

/** Props for {@link PlanCommentLayer}. */
interface PlanCommentLayerProps {
  readonly threadId: string;
  readonly binding: PlanCommentBinding;
  readonly view: EditorView | null;
  readonly viewed: PlanVersion;
  /** The text the editor shows, which can run ahead of the saved version while typing. */
  readonly docText: string;
  /** True when the viewed version still takes comments and the shown text matches what the server holds. */
  readonly canComment: boolean;
}

function markFor(id: string, docText: string, anchor: PlanComment["anchor"]): PlanCommentMark {
  return { id, range: resolveAnchorRange(docText, anchor), section: anchor.section };
}

/**
 * Highlights, saved-comment rows and the note editor for the Plan panel.
 * CodeMirror lays out one host node per comment; this renders into them.
 */
export function PlanCommentLayer({ threadId, binding, view, viewed, docText, canComment }: PlanCommentLayerProps) {
  const allComments = usePlanStore((s) => s.commentsByThread[threadId] ?? NO_COMMENTS);
  const storedEditor = useComposerDraftStore((s) => s.drafts[threadId]?.planCommentEditor);
  // An editor belongs to the version it was opened on; it stays hidden while another version is on screen.
  const editor = storedEditor?.planVersionId === viewed.id ? storedEditor : undefined;
  const hosts = useSyncExternalStore(binding.hosts.subscribe, binding.hosts.getSnapshot);
  const newCommentId = useRef<string | null>(null);

  const comments = useMemo(
    () => allComments.filter((comment) => comment.versionId === viewed.id && comment.status === "open"),
    [allComments, viewed.id],
  );
  const carried = useMemo(() => carriedOriginalIds(allComments), [allComments]);
  const editedComment = editor?.commentId ? comments.find((comment) => comment.id === editor.commentId) : undefined;
  // Editing a comment someone deleted meanwhile reopens as a new comment.
  const pendingNew = editor && !editedComment ? editor : undefined;

  const marks = useMemo(
    () => [
      ...comments.map((comment) => markFor(comment.id, docText, comment.anchor)),
      ...(pendingNew ? [markFor(NEW_COMMENT_MARK, docText, pendingNew.anchor)] : []),
    ],
    [comments, pendingNew, docText],
  );

  useEffect(() => {
    view?.dispatch({ effects: setPlanCommentMarks.of(marks) });
  }, [view, marks]);

  useEffect(() => {
    binding.onSelect.current = (from, to) => {
      if (!view || !canComment) return;
      const anchor = createPlanCommentAnchor(view.state.doc.toString(), from, to);
      if (!anchor) return;
      newCommentId.current = null;
      setPlanCommentEditor(threadId, { planVersionId: viewed.id, commentId: null, anchor, body: "" });
    };
  }, [binding, view, canComment, threadId, viewed.id]);

  const save = async (draft: PlanCommentEditorDraft) => {
    newCommentId.current ??= crypto.randomUUID();
    const current = view ? binding.readMarks(view).find((mark) => mark.id === (draft.commentId ?? NEW_COMMENT_MARK)) : undefined;
    const text = view?.state.doc.toString() ?? docText;
    const anchor = (current?.range && createPlanCommentAnchor(text, current.range.from, current.range.to)) || draft.anchor;
    const error = await savePlanComment(threadId, draft, {
      versionId: viewed.id,
      newCommentId: newCommentId.current,
      anchor,
      body: draft.body,
    });
    if (error === null) newCommentId.current = null;
    return error;
  };

  const renderEditor = (draft: PlanCommentEditorDraft) => (
    <PlanCommentEditor
      body={draft.body}
      saved={editedComment !== undefined}
      canWrite={canComment}
      onBodyChange={(body) => setPlanCommentEditorBody(threadId, body)}
      onSave={() => save(draft)}
      onDelete={() => deletePlanComment(threadId, editedComment?.id ?? "")}
      onCancel={() => setPlanCommentEditor(threadId, undefined)}
    />
  );

  return (
    <>
      {comments.map((comment) => {
        const host = hosts.get(comment.id);
        if (!host) return null;
        return createPortal(
          editor && editedComment === comment ? (
            renderEditor(editor)
          ) : (
            <PlanCommentRow
              comment={comment}
              canEdit={canComment && !carried.has(comment.id)}
              onEdit={() =>
                setPlanCommentEditor(threadId, {
                  planVersionId: viewed.id,
                  commentId: comment.id,
                  anchor: comment.anchor,
                  body: comment.body,
                })
              }
              onResolve={() => void resolvePlanComment(threadId, comment.id)}
            />
          ),
          host,
          comment.id,
        );
      })}
      {pendingNew && hosts.get(NEW_COMMENT_MARK) ? createPortal(renderEditor(pendingNew), hosts.get(NEW_COMMENT_MARK)!, NEW_COMMENT_MARK) : null}
    </>
  );
}
