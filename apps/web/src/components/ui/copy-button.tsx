import { useEffect, useState } from "react";
import { Check, Copy, X } from "lucide-react";
import { Button } from "./button";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

/** Copies text with success or failure feedback and a keyboard-accessible action. */
export function CopyButton({ text, label, className }: {
  text: string;
  label: string;
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
      <TooltipTrigger render={
        <Button type="button" variant="ghost" size="icon-xs" aria-label={label} onClick={() => void copy()} className={className}>
          <Icon aria-hidden="true" className="size-3.5" />
          <span className="sr-only" role="status">{status === "idle" ? "" : message}</span>
        </Button>
      } />
      <TooltipContent>{message}</TooltipContent>
    </Tooltip>
  );
}
