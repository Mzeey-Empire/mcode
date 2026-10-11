import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type { StartupFetchDecision } from "./useStartupActions";

const TEXT_ACTION_CLASS = "px-2 text-caption text-ink";

/**
 * Retry and Start from local for a startup blocked on a failed Start from origin fetch.
 *
 * Both are text actions styled like the trail's Cancel, per Paper board 04f state 7.
 */
export function OriginFetchActions({ decision }: { readonly decision: StartupFetchDecision }) {
  return (
    <>
      <Button type="button" variant="ghost" size="compact" className={TEXT_ACTION_CLASS} disabled={decision.pending !== null} onClick={() => decision.resolve("retry")}>
        {decision.pending === "retry" ? <Spinner size={12} aria-hidden /> : null}
        Retry
      </Button>
      <Button type="button" variant="ghost" size="compact" className={TEXT_ACTION_CLASS} disabled={decision.pending !== null} onClick={() => decision.resolve("continue")}>
        {decision.pending === "continue" ? <Spinner size={12} aria-hidden /> : null}
        Start from local {decision.localBranch}
      </Button>
    </>
  );
}
