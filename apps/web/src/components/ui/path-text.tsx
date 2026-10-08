import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/** Props for PathText. */
export interface PathTextProps {
  /** The full filesystem path to display. */
  path: string;
  /** Home directory prefix to collapse to ~ (e.g. "/Users/cj"). */
  home?: string;
  /** Additional className for the wrapping span. */
  className?: string;
}

/** A display path split into its last segment and the folder that holds it. */
interface PathParts {
  name: string;
  folder: string;
}

/** Collapses a leading home directory to `~`, for POSIX and Windows separators. */
function collapseHome(path: string, home?: string): string {
  if (!home) return path;
  if (path === home) return "~";
  if (path.startsWith(home + "/") || path.startsWith(home + "\\")) return "~" + path.slice(home.length);
  return path;
}

/** Splits a path at its last separator. A root folder keeps its separator so `/opt` reads `opt` in `/`. */
function splitPath(path: string): PathParts {
  const trimmed = path.length > 1 ? path.replace(/[\\/]+$/, "") : path;
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (index < 0 || index === trimmed.length - 1) return { name: trimmed || path, folder: "" };
  const folder = trimmed.slice(0, index);
  const separator = trimmed[index];
  const isRoot = folder === "" || /^[A-Za-z]:$/.test(folder);
  return { name: trimmed.slice(index + 1), folder: isRoot ? folder + separator : folder };
}

/**
 * A filesystem path that reads name first: the last segment in ink, then its folder in muted
 * text. Only the folder fades when the slot is too narrow. The full path stays in the
 * accessible name and in a tooltip.
 */
export function PathText({ path, home, className }: PathTextProps) {
  const { name, folder } = splitPath(collapseHome(path, home));
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className={cn("flex min-w-0 items-baseline gap-1.5 font-mono text-xs tabular-nums", className)}>
            <span className="sr-only">{path}</span>
            <span aria-hidden className="max-w-full shrink-0 text-fade text-ink">{name}</span>
            {folder ? <span aria-hidden className="text-fade text-muted">{folder}</span> : null}
          </span>
        }
      />
      <TooltipContent className="max-w-72 break-all font-mono">
        {path}
      </TooltipContent>
    </Tooltip>
  );
}
