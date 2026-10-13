import { useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** The prompt the parent agent handed this subagent, clamped to six lines until expanded. */
export function ParentPromptBubble({ prompt }: { readonly prompt: string }) {
  const textRef = useRef<HTMLParagraphElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const text = textRef.current;
    if (text && !expanded) setOverflows(text.scrollHeight > text.clientHeight);
  }, [prompt, expanded]);
  const clamped = !expanded && overflows;
  return (
    <section aria-label="From the main thread" className="flex flex-col items-end gap-1.5">
      <span className="text-xs text-muted">From the main thread</span>
      <div className="max-w-[420px] rounded-t-[14px] rounded-br-[6px] rounded-bl-[14px] bg-selected px-3.5 py-2.5">
        {/* Six 22px lines; the bottom fades instead of ending in an ellipsis. */}
        <p ref={textRef} data-testid="subagent-parent-prompt"
          className={cn("whitespace-pre-wrap text-sm leading-[22px] text-ink",
            !expanded && "max-h-[132px] overflow-hidden",
            clamped && "[mask-image:linear-gradient(to_bottom,black_calc(100%-24px),transparent)]")}>
          {prompt}
        </p>
      </div>
      {clamped && <Button type="button" variant="ghost" size="compact" onClick={() => setExpanded(true)}>Show all</Button>}
    </section>
  );
}
