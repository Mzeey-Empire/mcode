import { cn } from "@/lib/utils";
import { Check } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { PlanQuestionOption } from "@mcode/contracts";

interface OptionTileProps {
  /** The option data. */
  option: PlanQuestionOption;
  /** Whether this tile is currently selected. */
  selected: boolean;
  /** Whether this option is the model's recommended choice. */
  isRecommended?: boolean;
  /** Called when the user clicks or keyboard-selects this tile. */
  onSelect: (optionId: string) => void;
  /** When true, shows a textarea instead of description when selected. */
  isOtherTile?: boolean;
  /** Current free-text value for the "Other" tile. */
  otherText?: string;
  /** Called when the user types in the "Other" textarea. */
  onOtherTextChange?: (text: string) => void;
}

/**
 * Selectable option tile with spring animation on selection,
 * recommended badge, and inline textarea for the "Other" option.
 */
export function OptionTile({
  option,
  selected,
  isRecommended,
  onSelect,
  isOtherTile,
  otherText = "",
  onOtherTextChange,
}: OptionTileProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [justSelected, setJustSelected] = useState(false);

  // Auto-focus textarea when "Other" is selected (AC-1.4)
  useEffect(() => {
    if (isOtherTile && selected) {
      textareaRef.current?.focus();
    }
  }, [isOtherTile, selected]);

  // Trigger spring animation on selection (AC-1.19)
  useEffect(() => {
    if (selected) {
      setJustSelected(true);
      const timer = setTimeout(() => setJustSelected(false), 200);
      return () => clearTimeout(timer);
    }
  }, [selected]);

  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={() => onSelect(option.id)}
      className={cn(
        "group w-full text-left px-3.5 py-2.5 transition-colors duration-100",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        "cursor-pointer border-b border-border/20 last:border-b-0",
        selected ? "bg-primary/8" : "hover:bg-muted/50",
        justSelected && "animate-option-spring",
      )}
    >
      <div className="flex items-start gap-3">
        {/* Radio indicator */}
        <div
          className={cn(
            "mt-0.5 flex-shrink-0 w-4 h-4 rounded-full border-2 flex items-center justify-center transition-colors",
            selected
              ? "border-primary bg-primary"
              : "border-muted-foreground/50 group-hover:border-primary/60",
          )}
        >
          {selected && (
            <Check className="w-2.5 h-2.5 text-primary-foreground" strokeWidth={3} />
          )}
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span
              className={cn(
                "text-sm leading-none",
                selected ? "font-medium text-foreground" : "text-foreground/75",
              )}
            >
              {option.title}
            </span>
            {isRecommended && (
              <span className="inline-flex items-center text-[10px] font-medium text-primary/70 bg-primary/10 border border-primary/20 rounded px-1.5 py-0.5 leading-none">
                Recommended
              </span>
            )}
          </div>

          {/* Inline textarea for "Other" when selected (AC-1.4) */}
          {isOtherTile && selected ? (
            <textarea
              ref={textareaRef}
              value={otherText}
              onChange={(e) => onOtherTextChange?.(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              placeholder="Describe your preference..."
              rows={2}
              className="mt-2 w-full bg-transparent text-xs text-foreground placeholder:text-muted-foreground/40 outline-none border border-border/40 rounded-md p-2 resize-none focus:border-primary/50 transition-colors"
            />
          ) : (
            option.description &&
            !isOtherTile && (
              <p
                className={cn(
                  "text-xs mt-1 leading-relaxed",
                  selected ? "text-muted-foreground/80" : "text-muted-foreground/45",
                )}
              >
                {option.description}
              </p>
            )
          )}
        </div>
      </div>
    </button>
  );
}
