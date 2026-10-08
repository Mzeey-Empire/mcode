import { useEffect, useRef, useState } from "react";
import type { DraftDiffComment } from "@mcode/contracts";
import { useDiffStore } from "@/stores/diffStore";
import {
  clearVisibleDiffComments,
  deleteDraftDiffComment,
  editDraftDiffComment,
} from "./draft/draft-diff-comments";
import {
  ComposerCommentAttachmentShell,
  ComposerCommentPreviewItem,
  type ComposerCommentCardData,
} from "./SelectedTextCommentsComposerAttachment";

interface DiffCommentCard extends ComposerCommentCardData {
  readonly annotation: DraftDiffComment;
}

/** Props for the aggregate diff-comment attachment in the composer. */
export interface DiffCommentsComposerAttachmentProps {
  /** Saved Review comments in the thread's composer draft, numbered for display. */
  readonly comments: readonly DraftDiffComment[];
  /** Thread whose composer draft owns the comments. */
  readonly scopeId: string;
  /** Workspace whose right panel hosts the Review surface. */
  readonly workspaceId: string;
  /** Owning thread when the composer is bound to one. */
  readonly threadId?: string;
  /** Restores focus to the composer when deleting the final card. */
  readonly onFocusComposer: () => void;
}

function diffCommentLabel(count: number): string {
  return `${count} comment${count === 1 ? "" : "s"}`;
}

/**
 * Renders saved diff line comments through the same pill and preview card
 * chrome as the selected-text "Add comment" attachment. Opening a card reveals
 * the Review panel jumped to the owning file.
 */
export function DiffCommentsComposerAttachment({
  comments,
  scopeId,
  workspaceId,
  threadId,
  onFocusComposer,
}: DiffCommentsComposerAttachmentProps) {
  const [announcement, setAnnouncement] = useState("");
  const focusAfterDeleteRef = useRef<string | undefined>(undefined);
  const openSourceButtonsRef = useRef(new Map<string, HTMLElement>());
  useEffect(() => {
    const nextCommentId = focusAfterDeleteRef.current;
    if (!nextCommentId) return;
    focusAfterDeleteRef.current = undefined;
    openSourceButtonsRef.current.get(nextCommentId)?.focus();
  }, [comments]);
  if (comments.length === 0) return null;

  const label = diffCommentLabel(comments.length);
  const openSource = (item: DiffCommentCard) => {
    const store = useDiffStore.getState();
    store.showRightPanel(workspaceId, threadId);
    store.setRightPanelTab(workspaceId, threadId, "changes");
    store.requestReviewFileJump(scopeId, item.annotation.filePath);
  };
  const handleDelete = (item: DiffCommentCard) => {
    const index = comments.findIndex((candidate) => candidate.id === item.id);
    const nextFocusTarget = comments[index + 1] ?? comments[index - 1];
    focusAfterDeleteRef.current = nextFocusTarget?.id;
    setAnnouncement("Comment deleted.");
    if (!nextFocusTarget) onFocusComposer();
    deleteDraftDiffComment(scopeId, item.id);
  };

  return (
    <>
      <ComposerCommentAttachmentShell
        label={label}
        sectionAriaLabel="Diff comments"
        testId="diff-comment-attachment"
        chipTestId="diff-comment-chip"
        previewTestId="diff-comment-preview"
        commentCount={comments.length}
        onRemove={() => clearVisibleDiffComments(scopeId)}
      >
        {comments.map((annotation) => {
          const item: DiffCommentCard = {
            id: annotation.id,
            displayNumber: annotation.displayNumber,
            sourceLabel: `${annotation.filePath}:${annotation.line}`,
            quote: annotation.lineContent,
            note: annotation.note,
            annotation,
          };
          return (
            <ComposerCommentPreviewItem
              key={annotation.id}
              item={item}
              readOnly={false}
              sourceUnavailable={false}
              multipleComments={comments.length > 1}
              onOpenSource={openSource}
              onEdit={(item) => editDraftDiffComment(scopeId, item.annotation)}
              onDelete={handleDelete}
              openSourceButtonRef={(element) => {
                if (element) openSourceButtonsRef.current.set(annotation.id, element);
                else openSourceButtonsRef.current.delete(annotation.id);
              }}
              testId={`diff-comment-preview-item-${annotation.displayNumber}`}
            />
          );
        })}
      </ComposerCommentAttachmentShell>
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </span>
    </>
  );
}
