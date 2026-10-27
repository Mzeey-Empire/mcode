import { Check, MessageCircle, Pencil } from "lucide-react";
import type { PlanComment } from "@mcode/contracts/models/plan";
import { Button } from "@/components/ui/button";

/** Props for {@link PlanCommentRow}. */
interface PlanCommentRowProps {
  readonly comment: PlanComment;
  /** False on a version that no longer takes comments; the row then only shows the note. */
  readonly canEdit: boolean;
  readonly onEdit: () => void;
  readonly onResolve: () => void;
}

/** A saved plan comment under the line it is about. */
export function PlanCommentRow({ comment, canEdit, onEdit, onResolve }: PlanCommentRowProps) {
  return (
    <div className="bg-panel my-1 flex items-start gap-2 rounded-lg py-2 pr-1 pl-3" data-testid="plan-comment-row">
      <MessageCircle className="text-muted mt-0.5 size-3.5 shrink-0" aria-hidden />
      {canEdit ? (
        <button
          type="button"
          className="text-ink min-w-0 flex-1 cursor-text text-left text-sm leading-5 break-words whitespace-pre-wrap"
          onClick={onEdit}
        >
          {comment.body}
        </button>
      ) : (
        <p className="text-ink min-w-0 flex-1 text-sm leading-5 break-words whitespace-pre-wrap">{comment.body}</p>
      )}
      {canEdit && (
        <>
          <Button type="button" variant="ghost" size="icon-inline-sm" aria-label="Edit comment" onClick={onEdit}>
            <Pencil className="size-3.5" />
          </Button>
          <Button type="button" variant="ghost" size="icon-inline" aria-label="Resolve comment" onClick={onResolve}>
            <Check className="size-3.5" />
          </Button>
        </>
      )}
    </div>
  );
}
