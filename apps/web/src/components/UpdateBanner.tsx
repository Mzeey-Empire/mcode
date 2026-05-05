import { useState } from "react";
import { Loader2 } from "lucide-react";
import { useUpdateStore } from "@/stores/updateStore";

/**
 * Banner shown across the top of the app when an update is downloading or
 * ready to install. Hidden in non-Electron environments and when the user
 * has dismissed the current state. Includes expandable release notes.
 */
export function UpdateBanner() {
  const status = useUpdateStore((s) => s.status);
  const dismissed = useUpdateStore((s) => s.bannerDismissed);
  const dismiss = useUpdateStore((s) => s.dismissBanner);
  const [showReleaseNotes, setShowReleaseNotes] = useState(false);

  if (dismissed) return null;
  if (!window.desktopBridge) return null;

  if (status.state === "downloading") {
    return (
      <div className="space-y-1.5 bg-blue-600/90 px-4 py-2 text-white">
        <div className="flex items-center justify-center gap-2">
          <Loader2 size={14} className="animate-spin" aria-hidden="true" />
          <span className="flex-1 text-xs font-medium">
            Downloading update… {status.percent}%
          </span>
          <button
            onClick={dismiss}
            className="rounded px-2 py-0.5 text-xs hover:bg-white/15"
            aria-label="Dismiss banner"
          >
            ×
          </button>
        </div>
      </div>
    );
  }

  if (status.state === "available") {
    return (
      <div className="space-y-1.5 bg-blue-600/90 px-4 py-2 text-white">
        <div className="flex items-center justify-between">
          <span className="flex-1 text-xs font-medium">
            Version {status.version} is available for download.
          </span>
          {status.releaseNotes && (
            <button
              onClick={() => setShowReleaseNotes(!showReleaseNotes)}
              className="mx-1 rounded px-2 py-0.5 text-xs hover:bg-white/15"
            >
              {showReleaseNotes ? "Hide" : "Show"} notes
            </button>
          )}
          <button
            onClick={dismiss}
            className="rounded px-2 py-0.5 text-xs hover:bg-white/15"
            aria-label="Dismiss banner"
          >
            ×
          </button>
        </div>
        <ReleaseNotesSection notes={status.releaseNotes} visible={showReleaseNotes} />
      </div>
    );
  }

  if (status.state === "downloaded") {
    return (
      <div className="space-y-1.5 bg-emerald-600/95 px-4 py-2 text-white">
        <div className="flex items-center justify-between">
          <span className="flex-1 text-xs font-medium">
            Update {status.version} is ready. Restart Mcode to apply.
          </span>
          {status.releaseNotes && (
            <button
              onClick={() => setShowReleaseNotes(!showReleaseNotes)}
              className="mx-1 rounded px-2 py-0.5 text-xs hover:bg-white/15"
            >
              {showReleaseNotes ? "Hide" : "Show"} notes
            </button>
          )}
          <button
            onClick={() => void window.desktopBridge?.app.installUpdate()}
            className="rounded bg-white/15 px-2 py-0.5 text-xs hover:bg-white/25"
          >
            Restart now
          </button>
          <button
            onClick={dismiss}
            className="rounded px-2 py-0.5 text-xs hover:bg-white/15"
            aria-label="Dismiss banner"
          >
            ×
          </button>
        </div>
        <ReleaseNotesSection notes={status.releaseNotes} visible={showReleaseNotes} />
      </div>
    );
  }

  return null;
}

/** Collapsible release-notes panel rendered beneath the banner action row. */
function ReleaseNotesSection({ notes, visible }: { notes?: string; visible: boolean }) {
  if (!visible || !notes) return null;
  return (
    <div className="max-h-32 overflow-y-auto rounded bg-white/10 px-2 py-1.5 text-xs font-normal leading-relaxed">
      {notes}
    </div>
  );
}
