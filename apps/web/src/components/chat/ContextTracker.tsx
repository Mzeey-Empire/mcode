import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * Full-circle SVG ring constants.
 * Radius chosen so the ring fits a 24×24 viewBox with room for the stroke.
 */
const RADIUS = 9;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS; // ≈ 56.55

interface ContextTrackerProps {
  /** Tokens consumed in the last completed turn (input_tokens from the API). */
  tokensIn: number;
  /** Maximum context window size for the active model. */
  contextWindow?: number;
  /** Accumulated total tokens processed across compactions. */
  totalProcessedTokens?: number;
  /** Optional additional Tailwind classes for the root element. */
  className?: string;
  /** Show red dot badge when any quota category is below 20%. */
  hasLowQuota?: boolean;
}

/** Returns the color tier class for the fill ring and label. */
function colorTier(pct: number) {
  if (pct >= 90) return { text: "text-destructive", stroke: "stroke-destructive", fill: "bg-destructive" } as const;
  if (pct >= 70) return { text: "text-amber-500", stroke: "stroke-amber-500", fill: "bg-amber-500" } as const;
  return { text: "text-foreground", stroke: "stroke-muted-foreground/60", fill: "bg-primary" } as const;
}

/**
 * Circular context-window usage indicator.
 *
 * Renders a full 360° ring that fills clockwise from 12 o'clock as token usage
 * grows. Hidden when no token data exists (fresh thread). The ring color shifts
 * from muted → amber (70%) → red (90%) to signal urgency. When the provider
 * compacts, the ring silently animates backward.
 */
export function ContextTracker({ tokensIn, contextWindow, totalProcessedTokens, className, hasLowQuota }: ContextTrackerProps) {
  if (tokensIn <= 0 || !contextWindow) return null;

  const pct = Math.min(100, contextWindow > 0 ? (tokensIn / contextWindow) * 100 : 0);
  const filled = CIRCUMFERENCE * (pct / 100);
  const gap = CIRCUMFERENCE - filled;
  const { text, stroke, fill } = colorTier(pct);

  const roundedPct = Math.round(pct);
  const displayPct = pct > 0 && pct < 1 ? "<1" : `${roundedPct}`;
  const abbrev = (n: number) =>
    n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`
    : n >= 1_000 ? `${Math.round(n / 1_000)}k`
    : `${n}`;
  const tooltipLine = `${displayPct}% · ${abbrev(tokensIn)}/${abbrev(contextWindow)} context used`;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            className={cn(
              "relative flex items-center justify-center cursor-pointer rounded-full focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2",
              className,
            )}
            style={{ width: 24, height: 24 }}
            aria-label={`Context window: ${tooltipLine}`}
            role="img"
            tabIndex={0}
          >
            {/* rotate(-90deg) starts the arc at 12 o'clock */}
            <svg
              width={24}
              height={24}
              viewBox="0 0 24 24"
              className="-rotate-90"
              aria-hidden="true"
            >
              {/* Background track */}
              <circle
                cx={12}
                cy={12}
                r={RADIUS}
                fill="none"
                strokeWidth={2}
                className="stroke-muted-foreground/15"
              />
              {/* Filled arc */}
              <circle
                cx={12}
                cy={12}
                r={RADIUS}
                fill="none"
                strokeWidth={2}
                strokeDasharray={`${filled} ${gap}`}
                strokeLinecap="round"
                className={cn(
                  stroke,
                  "transition-[stroke-dasharray] duration-[600ms] ease-[cubic-bezier(0.4,0,0.2,1)] motion-reduce:transition-none",
                )}
              />
            </svg>

            {hasLowQuota && (
              <div className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full border border-background bg-destructive">
                <span className="sr-only">Low quota</span>
              </div>
            )}

          </div>
        }
      />
      <TooltipContent side="top" align="end" sideOffset={8} variant="surface" className="w-64 p-3">
        <div className="flex w-full flex-col gap-3">
          <div className="flex items-center justify-between gap-4">
            <span className="font-medium">Context window</span>
            <span className={cn("tabular-nums font-medium", text)}>{displayPct}% used</span>
          </div>
          <div
            role="progressbar"
            aria-label="Context window usage"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuetext={tooltipLine}
            className="h-2 overflow-hidden rounded-full bg-muted"
          >
            <div className={cn("h-full rounded-full", fill)} style={{ width: `${pct}%` }} />
          </div>
          <div className="flex items-baseline justify-between gap-4 tabular-nums">
            <span><span className="font-medium">{abbrev(tokensIn)}</span><span className="text-muted-foreground"> / {abbrev(contextWindow)} tokens</span></span>
            <span className="text-muted-foreground">{abbrev(Math.max(0, contextWindow - tokensIn))} left</span>
          </div>
          {totalProcessedTokens != null && totalProcessedTokens > tokensIn && (
            <div className="flex justify-between gap-4 border-t border-border pt-2 text-muted-foreground">
              <span>Total processed</span>
              <span className="tabular-nums">{abbrev(totalProcessedTokens)} tokens</span>
            </div>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
