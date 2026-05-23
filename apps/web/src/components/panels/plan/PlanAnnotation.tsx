import { useEffect, useRef } from "react";

interface PlanAnnotationProps {
  sectionTitle: string;
  value: string;
  onChange: (value: string) => void;
  onDiscard: () => void;
}

/**
 * Inline annotation textarea that appears below a plan heading
 * when the user clicks it. Auto-focuses on mount.
 */
export function PlanAnnotation({
  value,
  onChange,
  onDiscard,
}: PlanAnnotationProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    // Auto-focus and place cursor at end
    const el = textareaRef.current;
    if (el) {
      el.focus();
      el.selectionStart = el.value.length;
    }
  }, []);

  return (
    <div className="my-2 rounded-md border border-border bg-card overflow-hidden animate-wizard-float-rise">
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="What should change?"
        rows={2}
        className="block w-full resize-none border-none bg-transparent px-3 py-2.5 text-[12.5px] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground/40"
      />
      <div className="flex items-center px-3 pb-2">
        <button
          type="button"
          onClick={onDiscard}
          className="font-mono text-[9px] uppercase tracking-[0.1em] text-muted-foreground/45 transition-colors hover:text-muted-foreground"
        >
          Discard
        </button>
      </div>
    </div>
  );
}
