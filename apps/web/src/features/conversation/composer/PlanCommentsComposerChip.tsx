import { MessageCircle, X } from "lucide-react";
import type { PlanComment } from "@mcode/contracts";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/** Props for {@link PlanCommentsComposerChip}. */
export interface PlanCommentsComposerChipProps {
  /** Open plan comments the next Send carries. */
  readonly comments: readonly PlanComment[];
  /** Deletes every comment. */
  readonly onRemove: () => void;
}

/**
 * Composer chip for the plan comments riding the next Send. Like the other
 * annotation chips, removing it deletes what it holds.
 */
export function PlanCommentsComposerChip({ comments, onRemove }: PlanCommentsComposerChipProps) {
  if (comments.length === 0) return null;
  const label = `${comments.length} plan comment${comments.length === 1 ? "" : "s"}`;
  return (
    <div className="px-3 pt-2" data-testid="composer-plan-comments">
      <div className="bg-hover text-ink inline-flex h-7 items-center gap-1.5 rounded-lg pr-0.5 pl-2.5 text-sm">
        <MessageCircle className="text-muted size-3.5" aria-hidden />
        <span>{label}</span>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-inline-sm"
                aria-label={`Remove ${label}`}
                onClick={onRemove}
              />
            }
          >
            <X className="size-3" />
          </TooltipTrigger>
          <TooltipContent>Remove {label}</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
