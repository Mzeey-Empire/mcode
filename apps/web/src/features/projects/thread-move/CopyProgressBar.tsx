import type { CopyProgress } from "./new-project-run";

const BYTES_PER_MB = 1024 * 1024;

/**
 * Whole megabytes, rounded the same way for both numbers so the count never passes the total. A folder with any
 * bytes counts as at least 1 MB, so a small copy never reads "0 of 0 MB".
 */
function megabytes(bytes: number, floor: number): number {
  return Math.max(floor, Math.round(bytes / BYTES_PER_MB));
}

/** The right-hand label, such as `31 of 48 MB`. */
export function copyProgressLabel({ copiedBytes, totalBytes }: CopyProgress): string {
  const total = megabytes(totalBytes, totalBytes > 0 ? 1 : 0);
  const copied = Math.min(megabytes(copiedBytes, 0), total);
  return `${copied.toLocaleString()} of ${total.toLocaleString()} MB`;
}

function copiedPercent({ copiedBytes, totalBytes }: CopyProgress): number {
  // An empty folder has nothing left to copy.
  if (totalBytes === 0) return 100;
  return Math.round(Math.min(copiedBytes / totalBytes, 1) * 100);
}

/**
 * How far the copy to another drive has got. It draws exactly the progress it is given and nothing between two
 * frames, so a long copy repaints only when the server reports more bytes.
 */
export function CopyProgressBar({ progress }: { readonly progress: CopyProgress }) {
  const percent = copiedPercent(progress);
  const label = copyProgressLabel(progress);
  return (
    <div
      role="progressbar"
      aria-label="Copying files"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      aria-valuetext={label}
      className="grid gap-1.5"
    >
      <div className="flex justify-between gap-3 text-caption text-muted">
        <span>Copying files</span>
        <span className="font-code tabular-nums text-ink">{label}</span>
      </div>
      <div className="h-1 overflow-hidden rounded-[2px] bg-selected">
        <div className="h-full rounded-[2px] bg-primary" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}
