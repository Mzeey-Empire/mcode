import { useState, type KeyboardEvent } from "react";
import { Check, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";

/** The most a note can hold; the persisted editor draft is rejected on restore past this. */
const MAX_NOTE_CHARS = 4000;

/** Props for {@link PlanCommentEditor}. */
interface PlanCommentEditorProps {
  readonly body: string;
  /** True when editing a saved comment, which can also be deleted. */
  readonly saved: boolean;
  /** False once the version is accepted or a run is busy; the server would refuse the write. */
  readonly canWrite: boolean;
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
export function PlanCommentEditor({ body, saved, canWrite, onBodyChange, onSave, onDelete, onCancel }: PlanCommentEditorProps) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const run = async (action: () => Promise<string | null>) => {
    setPending(true);
    setError(await action());
    setPending(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (pending) return;
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    } else if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (canWrite) void run(onSave);
    }
  };

  return (
    <div
      className="bg-panel border-control-border my-1 flex flex-col gap-2 rounded-[10px] border pt-2.5 pr-2 pb-2 pl-3"
      data-testid="plan-comment-editor"
    >
      <textarea
        autoFocus
        rows={2}
        maxLength={MAX_NOTE_CHARS}
        readOnly={pending}
        value={body}
        aria-label="Comment"
        className="text-ink w-full resize-none bg-transparent text-sm leading-5 outline-none"
        onChange={(event) => onBodyChange(event.target.value)}
        onKeyDown={onKeyDown}
      />
      {error && (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      )}
      <div className="flex items-center gap-2">
        {saved && (
          <Button
            type="button"
            variant="ghost"
            size="icon-inline-sm"
            aria-label="Delete comment"
            disabled={pending || !canWrite}
            onClick={() => void run(onDelete)}
          >
            <Trash2 className="size-3.5" />
          </Button>
        )}
        <span className="flex-1" />
        <Button type="button" variant="ghost" size="compact" className="text-muted h-7 rounded-lg px-2.5" disabled={pending} onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="button"
          size="icon-inline-sm"
          className="rounded-full"
          aria-label="Save comment"
          disabled={pending || !canWrite || body.trim() === ""}
          onClick={() => void run(onSave)}
        >
          <Check className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}
