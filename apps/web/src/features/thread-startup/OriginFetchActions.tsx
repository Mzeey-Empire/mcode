import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type { StartupFetchDecision } from "./useStartupActions";

/** Retry and Continue from local for a startup blocked on a failed Start from origin fetch. */
export function OriginFetchActions({ decision }: { readonly decision: StartupFetchDecision }) {
  return (
    <>
      <Button type="button" variant="outline" size="compact" disabled={decision.pending !== null} onClick={() => decision.resolve("retry")}>
        {decision.pending === "retry" ? <Spinner size={12} aria-hidden /> : null}
        Retry
      </Button>
      <Button type="button" variant="outline" size="compact" disabled={decision.pending !== null} onClick={() => decision.resolve("continue")}>
        {decision.pending === "continue" ? <Spinner size={12} aria-hidden /> : null}
        Continue from local
      </Button>
    </>
  );
}
