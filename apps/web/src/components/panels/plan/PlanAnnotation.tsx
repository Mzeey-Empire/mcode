import { useEffect, useRef, useState } from "react";

interface PlanAnnotationProps {
  sectionTitle: string;
  initialValue: string;
  /** Called on blur or Enter to sync the final text to parent state. */
  onCommit: (value: string) => void;
  onDiscard: () => void;
}

/**
 * Inline annotation textarea below a plan heading. Manages its own
 * text state to avoid re-rendering the parent markdown on every
 * keystroke. Syncs to parent on blur.
 */
export function PlanAnnotation({
  initialValue,
  onCommit,
  onDiscard,
}: PlanAnnotationProps) {
  const [text, setText] = useState(initialValue);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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

  return (
    <div className="my-2 rounded-md border border-border bg-card overflow-hidden animate-wizard-float-rise">
      <textarea
        ref={textareaRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={handleBlur}
        placeholder="What should change?"
        rows={2}
        className="block w-full resize-none border-none bg-transparent px-3 py-2.5 text-[12.5px] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground/40"
      />
      <div className="flex items-center px-3 pb-2">
        <button
          type="button"
          onMouseDown={(e) => {
            // Prevent blur from firing before discard
            e.preventDefault();
            onDiscard();
          }}
          className="font-mono text-[9px] uppercase tracking-[0.1em] text-muted-foreground/45 transition-colors hover:text-muted-foreground"
        >
          Discard
        </button>
      </div>
    </div>
  );
}
