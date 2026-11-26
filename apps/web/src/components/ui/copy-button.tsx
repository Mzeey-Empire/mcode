import { type ComponentProps, type ReactNode, useEffect, useState } from "react";
import { Check, Copy, X } from "lucide-react";
import { Button } from "./button";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

/** Copies text with success or failure feedback and a keyboard-accessible action. */
export function CopyButton({ text, label, tooltip, tooltipSide, className }: {
  text: string;
  label: string;
  /** Tooltip before a copy; defaults to the label. The Copied and failure messages replace it. */
  tooltip?: ReactNode;
  /** Pins the tooltip to one side, so a tall tooltip and the short Copied message do not land on different sides. */
  tooltipSide?: ComponentProps<typeof TooltipContent>["side"];
  className?: string;
}) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (status === "idle") return;
    const timeout = setTimeout(() => setStatus("idle"), 2000);
    return () => clearTimeout(timeout);
  }, [status]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setStatus("copied");
    } catch {
      setStatus("failed");
    }
  }

  const message = status === "copied" ? "Copied" : status === "failed" ? "Copy failed. Try again." : label;
  const Icon = status === "copied" ? Check : status === "failed" ? X : Copy;
  return (
    <Tooltip>
      {/* A click closes a tooltip by default, which would hide the Copied and Copy failed messages it swaps in. */}
      <TooltipTrigger closeOnClick={false} render={
        <Button type="button" variant="ghost" size="icon-compact" aria-label={label} onClick={() => void copy()} className={className}>
          <Icon aria-hidden="true" className="size-3.5" />
          <span className="sr-only" role="status">{status === "idle" ? "" : message}</span>
        </Button>
      } />
      <TooltipContent side={tooltipSide}>{status === "idle" ? (tooltip ?? label) : message}</TooltipContent>
    </Tooltip>
  );
}
