import { useState } from "react";
import { ChevronRight, Star } from "lucide-react";
import { AnimatedCollapsible } from "@/components/ui/animated-collapsible";

interface DeltaBlockProps {
  /** The streamed response text to display. */
  text: string;
}

/**
 * Renders a streaming response delta block in the narrative timeline.
 *
 * Visually distinct from thought blocks - uses a primary-tinted background
 * and a pulsing star icon to signal an active response. The block is
 * collapsible via the chevron and open by default. A typing cursor is
 * appended to the text while the block is being streamed.
 */
export function DeltaBlock({ text }: DeltaBlockProps) {
  const [open, setOpen] = useState(true);

  return (
    <div className="bg-primary/7 rounded-md">
      {/* Header row */}
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="flex w-full items-center gap-2 px-2 py-1 text-[0.8125rem] cursor-pointer"
        aria-expanded={open}
      >
        {/* Pulsing star icon */}
        <span className="flex w-[15px] h-[15px] items-center justify-center shrink-0 relative">
          <span className="absolute inset-0 rounded-full bg-primary/15" />
          <Star className="w-[11px] h-[11px] text-primary animate-pulse relative z-10" />
        </span>

        {/* Responding label */}
        <span className="font-semibold text-foreground flex-1 text-left">
          Responding
        </span>

        {/* Chevron */}
        <ChevronRight
          className={`h-3.5 w-3.5 text-muted-foreground/60 shrink-0 transition-transform duration-200 ${
            open ? "rotate-90" : ""
          }`}
        />
      </button>

      {/* Body content */}
      <AnimatedCollapsible open={open}>
        <p className="px-2 pb-2 text-[0.8125rem] leading-relaxed text-foreground">
          {text}
          {/* Typing cursor */}
          <span aria-hidden="true" className="typing-cursor" />
        </p>
      </AnimatedCollapsible>
    </div>
  );
}
