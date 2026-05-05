import { useThreadStore } from "@/stores/threadStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";

/**
 * Inline banner shown when the provider is rate-limited or retrying an API request.
 *
 * Renders in the same Composer slot as CompactingBanner. Shows a pulsing indicator
 * with a human-readable description of why the agent is paused.
 */
export function RetryBanner() {
  const threadId = useWorkspaceStore((s) => s.activeThreadId);
  const rateLimit = useThreadStore((s) => threadId ? s.rateLimitByThread[threadId] : undefined);
  const apiRetry = useThreadStore((s) => threadId ? s.apiRetryByThread[threadId] : undefined);

  if (!rateLimit && !apiRetry) return null;

  let label: string;
  if (rateLimit) {
    if (rateLimit.retryAfterMs && rateLimit.retryAfterMs > 0) {
      const seconds = Math.ceil(rateLimit.retryAfterMs / 1000);
      label = `Rate limited - retrying in ${formatDuration(seconds)}`;
    } else {
      label = "Rate limited - waiting for capacity...";
    }
  } else if (apiRetry) {
    const parts: string[] = ["Retrying"];
    if (apiRetry.attempt != null && apiRetry.maxRetries != null) {
      parts.push(`(${apiRetry.attempt}/${apiRetry.maxRetries})`);
    } else if (apiRetry.attempt != null) {
      parts.push(`(attempt ${apiRetry.attempt})`);
    }
    if (apiRetry.delayMs != null && apiRetry.delayMs > 0) {
      const seconds = Math.ceil(apiRetry.delayMs / 1000);
      parts.push(`in ${formatDuration(seconds)}`);
    }
    label = parts.join(" ") + "...";
  } else {
    return null;
  }

  return (
    <div role="status" aria-live="polite" className="flex items-center gap-2 px-3 py-2 border-t border-border/20">
      <span className="relative flex h-3 w-3 shrink-0">
        <span className="motion-safe:animate-ping motion-reduce:hidden absolute inline-flex h-full w-full rounded-full bg-amber-500/60" />
        <span className="relative inline-flex h-3 w-3 rounded-full bg-amber-500" />
      </span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
}

/** Format seconds into a compact human-readable duration (e.g. "12s", "2m 30s"). */
function formatDuration(totalSeconds: number): string {
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}
