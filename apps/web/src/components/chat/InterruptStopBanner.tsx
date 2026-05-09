import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useThreadStore } from "@/stores/threadStore";

/**
 * One-shot banner after the user stops the agent mid-turn while file edits were
 * snapshot-persisted, reminding them that workspace changes were kept on disk.
 */
export function InterruptStopBanner({ threadId }: { threadId: string }) {
  const notice = useThreadStore((s) => s.interruptStopFileNoticeByThread[threadId]);
  const clear = useThreadStore((s) => s.clearInterruptStopFileNotice);

  if (!notice || notice.paths.length === 0) return null;

  const preview =
    notice.paths.length <= 3
      ? notice.paths.join(", ")
      : `${notice.paths.slice(0, 3).join(", ")} and ${notice.paths.length - 3} more`;

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-start gap-2 border-t border-border/20 px-3 py-2"
      data-testid="interrupt-stop-file-notice"
    >
      <span className="text-xs text-muted-foreground pt-0.5">
        Stop: file changes from this turn are still on disk ({preview}). Use git to review or
        undo if needed.
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-7 w-7 shrink-0 text-muted-foreground"
        title="Dismiss"
        aria-label="Dismiss"
        onClick={() => clear(threadId)}
      >
        <X size={14} />
      </Button>
    </div>
  );
}
