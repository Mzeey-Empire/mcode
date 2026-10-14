import { MessageCircle, X } from "lucide-react";
import type { PlanComment } from "@mcode/contracts";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/** Props for {@link PlanCommentsComposerChip}. */
export interface PlanCommentsComposerChipProps {
  /** Open plan comments the next Send carries. */
  readonly comments: readonly PlanComment[];
  /** Leaves every comment out of the next Send. */
  readonly onExclude: () => void;
}

/**
 * Composer chip for the plan comments riding the next Send. Removing it only
 * leaves them out of that Send; they stay open in the Plan panel.
 */
export function PlanCommentsComposerChip({ comments, onExclude }: PlanCommentsComposerChipProps) {
  if (comments.length === 0) return null;
  const label = `${comments.length} plan comment${comments.length === 1 ? "" : "s"}`;
  return (
    <div className="px-3 pt-2" data-testid="composer-plan-comments">
      <div className="border-border bg-background text-ink inline-flex h-8 items-center gap-1.5 rounded-lg border pr-1 pl-2.5 text-sm">
        <MessageCircle className="text-muted size-3.5" aria-hidden />
        <span>{label}</span>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-compact"
                aria-label="Leave plan comments out of this message"
                onClick={onExclude}
              />
            }
          >
            <X className="size-3.5" />
          </TooltipTrigger>
          <TooltipContent>Leave out of this message</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
