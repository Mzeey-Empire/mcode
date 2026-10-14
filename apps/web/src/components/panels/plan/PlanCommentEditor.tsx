import { useState, type KeyboardEvent } from "react";
import { Check, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Props for {@link PlanCommentEditor}. */
interface PlanCommentEditorProps {
  readonly body: string;
  /** True when editing a saved comment, which can also be deleted. */
  readonly saved: boolean;
  readonly onBodyChange: (body: string) => void;
  /** Resolves to an error message, or null once saved. */
  readonly onSave: () => Promise<string | null>;
  readonly onDelete: () => Promise<string | null>;
  readonly onCancel: () => void;
}

/**
 * Note editor under a selection. Enter saves, Shift+Enter adds a line, Esc
 * cancels. A failed write keeps the note and shows the reason in place.
 */
export function PlanCommentEditor({ body, saved, onBodyChange, onSave, onDelete, onCancel }: PlanCommentEditorProps) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const run = async (action: () => Promise<string | null>) => {
    setPending(true);
    setError(await action());
    setPending(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    } else if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void run(onSave);
    }
  };

  return (
    <div
      className="bg-panel border-control-border my-1 flex flex-col gap-2 rounded-[10px] border py-2 pr-2 pl-3"
      data-testid="plan-comment-editor"
    >
      <textarea
        autoFocus
        rows={2}
        value={body}
        aria-label="Comment"
        className="text-ink w-full resize-none bg-transparent text-sm leading-6 outline-none"
        onChange={(event) => onBodyChange(event.target.value)}
        onKeyDown={onKeyDown}
      />
      {error && (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      )}
      <div className="flex items-center gap-1">
        {saved && (
          <Button
            type="button"
            variant="ghost"
            size="icon-inline"
            aria-label="Delete comment"
            disabled={pending}
            onClick={() => void run(onDelete)}
          >
            <Trash2 className="size-3.5" />
          </Button>
        )}
        <span className="flex-1" />
        <Button type="button" variant="ghost" size="compact" className="text-muted h-7 px-2.5" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="button"
          size="icon-inline"
          className="rounded-full"
          aria-label="Save comment"
          disabled={pending || body.trim() === ""}
          onClick={() => void run(onSave)}
        >
          <Check className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}
