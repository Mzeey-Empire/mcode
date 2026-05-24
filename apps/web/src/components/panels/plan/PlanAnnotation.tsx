import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

interface PlanAnnotationProps {
  sectionTitle: string;
  initialValue: string;
  /** Called on blur to stash the draft without closing the editor. */
  onCommit: (value: string) => void;
  /** Called when the user explicitly saves and closes the note. */
  onSave: (value: string) => void;
  onDiscard: () => void;
}

/**
 * Inline annotation textarea below a plan heading. Manages its own
 * text state to avoid re-rendering the parent markdown on every
 * keystroke. Blur stashes a draft; Save note commits and closes.
 */
export function PlanAnnotation({
  sectionTitle,
  initialValue,
  onCommit,
  onSave,
  onDiscard,
}: PlanAnnotationProps) {
  const [text, setText] = useState(initialValue);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fieldId = `plan-note-${sectionTitle.replace(/\s+/g, "-").toLowerCase()}`;

  useEffect(() => {
    const el = textareaRef.current;
    if (el) {
      el.focus();
      el.selectionStart = el.value.length;
    }
  }, []);

  const handleBlur = () => {
    onCommit(text);
  };

  const handleSave = () => {
    onSave(text);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onDiscard();
      return;
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSave();
    }
  };

  return (
    <div className="my-2 overflow-hidden rounded-md border border-border bg-card animate-wizard-float-rise">
      <label htmlFor={fieldId} className="sr-only">
        Note for section {sectionTitle}
      </label>
      <textarea
        id={fieldId}
        ref={textareaRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        placeholder="What should change in this section?"
        rows={2}
        className="block min-h-[3.5rem] w-full resize-y border-none bg-transparent px-3 py-2.5 text-[13px] leading-[1.65] text-foreground outline-none placeholder:text-muted-foreground/55"
      />
      <div className="flex items-center justify-between gap-2 border-t border-border/50 px-2 py-1.5">
        <p className="min-w-0 font-mono text-[9px] leading-snug tracking-[0.14em] text-muted-foreground/65">
          Click away to stash, or save to close
        </p>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onMouseDown={(e) => {
              // Blur fires before click; block it so discard runs first.
              e.preventDefault();
            }}
            onClick={onDiscard}
            className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground"
          >
            Discard
          </Button>
          <Button
            type="button"
            variant="outline"
            size="xs"
            onMouseDown={(e) => {
              e.preventDefault();
            }}
            onClick={handleSave}
            className="font-mono text-[10px] uppercase tracking-[0.16em]"
          >
            Save note
          </Button>
        </div>
      </div>
    </div>
  );
}
