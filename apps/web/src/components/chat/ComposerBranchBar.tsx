import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { stripPlanFences } from "@/lib/plan-fences";

interface ComposerBranchBarProps {
  /** ID of the message being branched from; bar is hidden when absent. */
  branchFromMessageId?: string;
  /** Preview content of the message being branched from, shown as a truncated excerpt. */
  branchFromMessageContent?: string;
  /** Called when the user exits branch mode via the X button. */
  onBranchModeExit?: () => void;
}

/**
 * Minimal quote bar shown at the top of the Composer when in branch mode.
 * Uses a ↳ glyph instead of the heavier gradient/border chrome.
 */
export function ComposerBranchBar({ branchFromMessageId, branchFromMessageContent, onBranchModeExit }: ComposerBranchBarProps) {
  if (!branchFromMessageId) return null;
  const excerpt = stripPlanFences(branchFromMessageContent ?? "").trim();

  return (
    <div className="flex items-start gap-2 px-3 py-2 animate-fade-up-in">
      <span className="shrink-0 text-sm text-primary/70 leading-none mt-0.5" aria-hidden="true">↳</span>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-muted/60 leading-none mb-0.5">Forking from</p>
        {excerpt && (
          <p className="text-xs text-muted/50 text-fade italic">
            {excerpt}
          </p>
        )}
      </div>
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={onBranchModeExit}
        disabled={!onBranchModeExit}
        className="shrink-0 text-muted/30 hover:bg-hover/40 hover:text-muted"
        aria-label="Exit fork mode"
      >
        <X className="size-3.5" />
      </Button>
    </div>
  );
}
