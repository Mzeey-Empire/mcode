import type { PlanVersion } from "@mcode/contracts";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { usePlanStore } from "@/stores/planStore";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { formatRelative } from "@/lib/format-relative";
import { PanelHeaderSlot } from "@/components/panels/shell/PanelHeader";

interface PlanChromeProps {
  plan: PlanVersion;
  allVersions: readonly PlanVersion[];
  threadId: string;
  onRevise: () => void;
  onImplement: () => void;
  commentCount: number;
}

/**
 * Plan's header in the panel shell: the revision picker in row 1 and Revise and
 * Implement in row 2. Row 1 leaves about 150px beside the caption buttons at the
 * narrowest panel, too little for the actions, and they must stay reachable.
 */
export function PlanChrome({
  plan,
  allVersions,
  threadId,
  onRevise,
  onImplement,
  commentCount,
}: PlanChromeProps) {
  const setActiveVersion = usePlanStore((s) => s.setActiveVersion);
  const maxVersion = allVersions.length > 0 ? allVersions[allVersions.length - 1].version : 1;
  const hasFeedback = commentCount > 0;

  return (
    <>
      <PanelHeaderSlot slot="leading">
        <div data-testid="plan-chrome" className="flex min-w-0 flex-1 items-center gap-2">
          <Popover>
            <PopoverTrigger
              render={
                <Button
                  type="button"
                  variant="outline"
                  size="compact"
                  className="shrink-0 gap-1.5 font-mono text-caption uppercase tracking-[0.16em]"
                  aria-label={`Revision history: v${plan.version} of ${maxVersion}`}
                >
                  v{plan.version}
                  <span className="tracking-normal text-muted/70 normal-case">
                    {formatRelative(plan.createdAt)}
                  </span>
                  <ChevronDown size={12} aria-hidden />
                </Button>
              }
            />
            <PopoverContent align="start" className="w-72 p-0">
              <div className="px-3 pt-3 pb-2 font-mono text-caption uppercase tracking-[0.18em] text-muted/45">
                Revision history
              </div>
              <div className="flex flex-col gap-0.5 px-1.5 pb-1.5">
                {[...allVersions].reverse().map((p) => {
                  const isLatest = p.version === maxVersion;
                  const isActive = p.version === plan.version;
                  return (
                    <Button
                      key={p.id}
                      type="button"
                      variant="ghost"
                      size="compact"
                      onClick={() => setActiveVersion(threadId, isLatest ? null : p.version)}
                      aria-current={isActive ? "true" : undefined}
                      className={cn(
                        "h-auto w-full flex-col items-stretch gap-1 whitespace-normal rounded-md px-2.5 py-2.5 text-left font-normal transition-colors hover:bg-selected/50",
                        isActive && "bg-selected/40",
                      )}
                    >
                      <span className="flex items-center gap-2.5">
                        <span
                          className={cn(
                            "font-mono text-caption tabular-nums",
                            isActive ? "text-primary" : "text-ink",
                          )}
                        >
                          v{p.version}
                        </span>
                        <span className="font-mono text-caption tabular-nums text-muted/70">
                          {formatRelative(p.createdAt)}
                        </span>
                        {isLatest ? (
                          <span className="ml-auto rounded-full bg-primary/12 px-1.5 py-0.5 font-mono text-caption uppercase tracking-[0.16em] text-primary">
                            latest
                          </span>
                        ) : (
                          <span className="ml-auto font-mono text-caption uppercase tracking-[0.16em] text-muted/45">
                            {p.status}
                          </span>
                        )}
                      </span>
                    </Button>
                  );
                })}
              </div>
            </PopoverContent>
          </Popover>
        </div>
      </PanelHeaderSlot>
      <PanelHeaderSlot slot="row2">
        <div data-testid="plan-actions" className="ml-auto flex shrink-0 items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="compact"
                  onClick={onRevise}
                  className={cn(
                    "font-mono text-caption uppercase tracking-[0.16em]",
                    hasFeedback && "text-ink",
                  )}
                >
                  {hasFeedback ? `Feedback (${commentCount})` : "Revise"}
                </Button>
              }
            />
            <TooltipContent side="bottom" sideOffset={6} className="max-w-[16rem] text-xs">
              {hasFeedback
                ? "Send annotated feedback and generate a new version"
                : "Request a new plan version without section notes"}
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="default"
                  size="compact"
                  onClick={onImplement}
                  className="font-mono text-caption uppercase tracking-[0.16em]"
                >
                  Implement
                </Button>
              }
            />
            <TooltipContent side="bottom" sideOffset={6} className="max-w-[16rem] text-xs">
              Start implementation in chat mode using this plan
            </TooltipContent>
          </Tooltip>
        </div>
      </PanelHeaderSlot>
    </>
  );
}
