import { useState } from "react";
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
          <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
            />
          </svg>
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
            Update available — version {status.version} is downloading.
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
        {showReleaseNotes && status.releaseNotes && (
          <div className="max-h-32 overflow-y-auto rounded bg-white/10 px-2 py-1.5 text-xs font-normal leading-relaxed">
            {status.releaseNotes}
          </div>
        )}
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
        {showReleaseNotes && status.releaseNotes && (
          <div className="max-h-32 overflow-y-auto rounded bg-white/10 px-2 py-1.5 text-xs font-normal leading-relaxed">
            {status.releaseNotes}
          </div>
        )}
      </div>
    );
  }

  return null;
}
