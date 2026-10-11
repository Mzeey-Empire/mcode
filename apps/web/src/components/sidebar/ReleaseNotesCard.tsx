import { useMemo } from "react";
import { parseReleaseNotes } from "@/features/updates/release-notes";
import { releaseNotesUrl } from "@/features/updates/update-button-state";

/** Props for {@link ReleaseNotesCard}. */
interface ReleaseNotesCardProps {
  /** Version the notes describe; links to its GitHub release. */
  readonly version: string;
  /** Raw release notes from the updater, HTML or markdown. Untrusted. */
  readonly notes: string | null;
}

/**
 * "What's new" digest shown on hover of Download and Install. Notes come from
 * a GitHub release body, so they are parsed to plain text and rendered as text.
 */
export function ReleaseNotesCard({ version, notes }: ReleaseNotesCardProps) {
  const parsed = useMemo(() => parseReleaseNotes(notes ?? ""), [notes]);
  return (
    <div data-testid="release-notes-card" className="flex flex-col gap-3">
      <h3 className="text-base leading-[22px] font-semibold text-ink">What&apos;s new</h3>
      {parsed.items.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {parsed.items.map((item, index) => (
            <li key={`${index}-${item}`} className="flex gap-2.5 text-[13px] leading-5 text-ink">
              <span aria-hidden className="flex h-5 w-1 shrink-0 items-center">
                <span className="size-1 rounded-full bg-muted" />
              </span>
              <span className="min-w-0">{item}</span>
            </li>
          ))}
        </ul>
      ) : parsed.fallback ? (
        <p className="text-[13px] leading-5 text-ink">{parsed.fallback}</p>
      ) : null}
      <button
        type="button"
        className="self-start text-[13px] leading-5 font-medium text-link hover:text-focus focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        onClick={() => void window.desktopBridge?.openExternalUrl(releaseNotesUrl(version))}
      >
        Full release notes
      </button>
    </div>
  );
}
