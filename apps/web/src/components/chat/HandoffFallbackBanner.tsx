/**
 * Banner shown at the top of a child fork thread when the handoff was produced
 * by the local deterministic path (path D) because the user's provider was
 * unavailable (quota exceeded, auth failure, etc.).
 *
 * Suppressed when `chat.handoff.notifyOnLocalFallback` is false.
 * The "Regenerate" button is a v1 stub; live regeneration is deferred.
 */

import { AlertCircle, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSettingsStore } from "@/stores/settingsStore";
import { useThreadStore } from "@/stores/threadStore";

/** Props for {@link HandoffFallbackBanner}. */
interface Props {
  /** ID of the child fork thread to check handoff status for. */
  threadId: string;
}

/**
 * Renders an amber warning banner when the fork's handoff document was produced
 * locally rather than by the AI provider. Hidden when the notification setting
 * is disabled or the thread's handoff status is not "fallback".
 */
export function HandoffFallbackBanner({ threadId }: Props) {
  const enabled = useSettingsStore(
    (s) => s.settings.chat?.handoff?.notifyOnLocalFallback ?? true,
  );
  const status = useThreadStore((s) => s.handoffStatus[threadId]);

  if (!enabled || status !== "fallback") return null;

  return (
    <div
      role="status"
      data-testid="handoff-fallback-banner"
      className="flex items-center gap-3 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm"
    >
      <AlertCircle className="h-4 w-4 shrink-0 text-amber-600" aria-hidden />
      <span className="flex-1">
        Handoff generated locally; your provider was unavailable.
      </span>
      <Button
        size="sm"
        variant="outline"
        disabled
        title="Coming soon"
        className="gap-1"
      >
        <RotateCcw className="h-3 w-3" />
        Regenerate
      </Button>
    </div>
  );
}
