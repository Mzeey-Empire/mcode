import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { CapsuleDivider } from "./ComposerCapsuleSplit";
import { contextLabelFor, type ContextLabel } from "./context-label";

interface ComposerContextLabelProps {
  /** Tokens in the last completed turn. */
  readonly tokensIn: number;
  /** The active model's context window, when known. */
  readonly contextWindow: number | undefined;
  /** Tokens processed across compactions. */
  readonly totalProcessedTokens?: number;
  /** A provider quota is nearly spent: the label shows even below 70% and names the low quota. */
  readonly hasLowQuota: boolean;
}

const TONE_CLASS: Record<ContextLabel["tone"], { readonly text: string; readonly fill: string }> = {
  warning: { text: "text-warning", fill: "bg-warning" },
  destructive: { text: "text-destructive", fill: "bg-destructive" },
};

const LABEL_CLASS =
  "inline-flex h-8 shrink-0 cursor-default items-center rounded-full pr-1.5 pl-1 text-compact whitespace-nowrap focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

function abbreviateTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return `${n}`;
}

function percentUsedOf(tokensIn: number, contextWindow: number | undefined): number | null {
  if (tokensIn <= 0 || !contextWindow) return null;
  return Math.min(100, (tokensIn / contextWindow) * 100);
}

/**
 * The capsule's context usage, shown from 70% as "72% context", or "72%" below the 680px capsule tier, behind a rule
 * that sets it off from the access part. Hover or focus opens the token breakdown card the old ring showed.
 */
export function ComposerContextLabel({ tokensIn, contextWindow, totalProcessedTokens, hasLowQuota }: ComposerContextLabelProps) {
  const percentUsed = percentUsedOf(tokensIn, contextWindow);
  const label = contextLabelFor(percentUsed);
  if (!label || percentUsed === null || !contextWindow) return hasLowQuota ? <LowQuotaLabel /> : null;

  const tone = TONE_CLASS[label.tone];
  const summary = `${label.text} · ${abbreviateTokens(tokensIn)}/${abbreviateTokens(contextWindow)} context used`;

  return (
    <>
      <CapsuleDivider />
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              data-testid="composer-context-label"
              role="img"
              aria-label={`Context window: ${summary}${hasLowQuota ? " · Low provider quota" : ""}`}
              tabIndex={0}
              className={cn(LABEL_CLASS, "tabular-nums", tone.text)}
            >
              {label.text}
              {/* A bare percentage beside Stop reads as task progress, so name it where there is room. */}
              <span className="@max-[680px]/capsule:hidden">&nbsp;context</span>
            </span>
          }
        />
        <TooltipContent side="top" align="end" sideOffset={8} className="w-72 max-w-none p-3">
          <div className="flex w-full flex-col gap-3">
            <div className="flex items-center justify-between gap-4">
              <span className="font-medium">Context window</span>
              <span className={cn("tabular-nums font-medium", tone.text)}>{label.text} used</span>
            </div>
            <div
              role="progressbar"
              aria-label="Context window usage"
              aria-valuenow={percentUsed}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuetext={summary}
              className="h-2 overflow-hidden rounded-full bg-hover"
            >
              <div className={cn("h-full rounded-full", tone.fill)} style={{ width: `${percentUsed}%` }} />
            </div>
            <div className="flex items-baseline justify-between gap-4 tabular-nums">
              <span className="whitespace-nowrap"><span className="font-medium">{abbreviateTokens(tokensIn)}</span><span className="text-muted"> / {abbreviateTokens(contextWindow)} tokens</span></span>
              <span className="whitespace-nowrap text-muted">{abbreviateTokens(Math.max(0, contextWindow - tokensIn))} left</span>
            </div>
            {totalProcessedTokens != null && totalProcessedTokens > tokensIn && (
              <div className="flex justify-between gap-4 border-t border-border pt-2 text-muted">
                <span>Total processed</span>
                <span className="tabular-nums">{abbreviateTokens(totalProcessedTokens)} tokens</span>
              </div>
            )}
            {hasLowQuota && <ProviderQuotaLine className="border-t border-border pt-2" />}
          </div>
        </TooltipContent>
      </Tooltip>
    </>
  );
}

function ProviderQuotaLine({ className }: { readonly className?: string }) {
  return (
    <div className={cn("flex justify-between gap-4", className)}>
      <span>Provider quota</span>
      <span className="font-medium text-warning">Low</span>
    </div>
  );
}

/**
 * Stands in for the context label while context use is below its warning level or unknown. The warning tone there
 * would belong to the quota, so a percentage beside it would read as quota left.
 */
function LowQuotaLabel() {
  return (
    <>
      <CapsuleDivider />
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              data-testid="composer-context-label"
              role="img"
              aria-label="Low provider quota"
              tabIndex={0}
              className={cn(LABEL_CLASS, TONE_CLASS.warning.text)}
            >
              Low quota
            </span>
          }
        />
        <TooltipContent side="top" align="end" sideOffset={8} className="w-72 max-w-none p-3">
          <ProviderQuotaLine />
        </TooltipContent>
      </Tooltip>
    </>
  );
}
