import { Notice } from "@/components/ui/notice";

/** Shown in place of the preflight notice when the read failed. The move stays unavailable until a read succeeds. */
export function PreflightFailedNotice({ onRetry }: { onRetry: () => void }) {
  return <Notice tone="error" title="Couldn't check this thread's folder. Try again." action={{ label: "Retry", onClick: onRetry }} />;
}
