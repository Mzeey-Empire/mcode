import { useId, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { ReviewFileChange } from "@mcode/contracts";
import { FileTypeIcon } from "@/components/ui/file-type-icon";
import { cn } from "@/lib/utils";

interface ReviewFileHeaderProps {
  readonly file: ReviewFileChange;
  readonly expanded: boolean;
  /** Whether this file is showing the jump confirmation flash. */
  readonly highlighted: boolean;
  readonly onToggle: () => void;
  /** Per-file actions, shown only while the file is expanded. */
  readonly actions: ReactNode;
}

function splitFilePath(path: string): { readonly name: string; readonly folder: string } {
  const index = path.lastIndexOf("/");
  return index < 0
    ? { name: path, folder: "" }
    : { name: path.slice(index + 1), folder: path.slice(0, index) };
}

/**
 * One file's 36px header in the Review diff: chevron, file icon, name, fading
 * folder, then deletion and addition counts. Rendered through pierre's
 * `renderCustomHeader`, so the node is a light-DOM child of the item host and
 * document CSS (the folder fade, the jump flash) applies to it.
 */
export function ReviewFileHeader({ file, expanded, highlighted, onToggle, actions }: ReviewFileHeaderProps) {
  const { name, folder } = splitFilePath(file.path);
  const Chevron = expanded ? ChevronDown : ChevronRight;
  const countsId = useId();
  const countsDescription = describeLineCounts(file.deletions, file.additions);
  return (
    <div
      data-jump-highlight={highlighted ? "true" : undefined}
      className={cn("flex h-9 items-center gap-1.5 border-b border-border pl-2 font-sans", expanded ? "pr-1.5" : "pr-3")}
    >
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={expanded ? `Collapse ${file.path}` : `Expand ${file.path}`}
        aria-describedby={countsDescription ? countsId : undefined}
        onClick={onToggle}
        className="flex min-w-0 flex-1 items-center gap-1.5 self-stretch rounded-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus/55"
      >
        <span className="flex size-5 shrink-0 items-center justify-center">
          <Chevron aria-hidden size={14} className="text-muted" />
        </span>
        <FileTypeIcon filePath={file.path} />
        <span aria-hidden className="flex min-w-0 flex-1 items-center gap-2 text-code-small">
          <span className="text-fade font-medium text-ink">{name}</span>
          {folder ? <span data-testid="review-file-folder" className="text-fade flex-1 text-muted">{folder}</span> : null}
        </span>
        <FileLineCounts deletions={file.deletions} additions={file.additions} />
      </button>
      {countsDescription ? <span id={countsId} hidden>{countsDescription}</span> : null}
      {expanded ? actions : null}
    </div>
  );
}

function FileLineCounts({ deletions, additions }: { readonly deletions: number | null; readonly additions: number | null }) {
  if (!deletions && !additions) return null;
  return (
    <span aria-hidden data-testid="review-file-counts" className="flex shrink-0 items-center gap-1.5 font-mono text-caption tabular-nums">
      {deletions ? <span className="text-error">-{deletions}</span> : null}
      {additions ? <span className="text-success">+{additions}</span> : null}
    </span>
  );
}

function describeLineCounts(deletions: number | null, additions: number | null): string {
  const parts: string[] = [];
  if (deletions) parts.push(`${deletions} ${deletions === 1 ? "deletion" : "deletions"}`);
  if (additions) parts.push(`${additions} ${additions === 1 ? "addition" : "additions"}`);
  return parts.join(", ");
}
