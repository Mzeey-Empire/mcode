import type { ReviewFileChange } from "@mcode/contracts";
import type { KeyboardEvent, Ref } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FileTypeIcon } from "@/components/ui/file-type-icon";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { CHANGE_TYPE_GLYPHS, CHANGE_TYPE_LABELS, changeTypeTone } from "@/components/diff/change-type";
import { cn } from "@/lib/utils";
import { basename } from "@/lib/path";

interface ReviewFileChangeRowProps {
  file: ReviewFileChange;
  active: boolean;
  depth: number;
  positionInSet: number;
  setSize: number;
  tabIndex: 0 | -1;
  buttonRef?: Ref<HTMLButtonElement>;
  onActivate: (path: string) => void;
  onFocus: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
}

/** Dense status and path row for one local Review comparison file. */
export function ReviewFileChangeRow({
  file,
  active,
  depth,
  positionInSet,
  setSize,
  tabIndex,
  buttonRef,
  onActivate,
  onFocus,
  onKeyDown,
}: ReviewFileChangeRowProps) {
  const pathLabel = file.previousPath ? `${file.previousPath} → ${file.path}` : file.path;
  // Rows sit inside a directory tree whose headers already carry the path,
  // so the label is the basename; the tooltip and aria-label keep the full
  // path (and rename arrow) reachable.
  const name = basename(file.path);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            ref={buttonRef}
            type="button"
            role="treeitem"
            variant="ghost"
            size="sm"
            tabIndex={tabIndex}
            aria-label={`${CHANGE_TYPE_LABELS[file.changeType]} ${pathLabel}${file.binary ? ", Binary" : ""}`}
            aria-level={depth}
            aria-posinset={positionInSet}
            aria-setsize={setSize}
            aria-selected={active}
            className={cn(
              "relative mx-1 h-8 w-[calc(100%-0.5rem)] justify-start gap-1.5 rounded-md px-2 font-normal",
              active ? "bg-muted/70 text-foreground" : "text-foreground/75 hover:bg-muted/40",
            )}
            style={{ paddingLeft: `${Math.max(8, depth * 12 - 4)}px` }}
            onClick={() => onActivate(file.path)}
            onFocus={onFocus}
            onKeyDown={onKeyDown}
          >
            <span aria-hidden className="flex size-4 shrink-0 items-center justify-center">
              <FileTypeIcon filePath={file.path} size={14} />
            </span>
            <span className="min-w-0 flex-1 truncate text-left font-mono text-xs">{name}</span>
            {file.binary ? (
              <Badge variant="ghost" size="sm" className="max-w-20 px-1 font-mono uppercase tracking-wide">
                Binary
              </Badge>
            ) : null}
            <Tooltip>
              <TooltipTrigger
                render={
                  <span
                    data-change-type={file.changeType}
                    aria-hidden
                    className={cn("w-3 shrink-0 text-center font-mono text-xs font-medium", changeTypeTone(file.changeType))}
                  >
                    {CHANGE_TYPE_GLYPHS[file.changeType]}
                  </span>
                }
              />
              <TooltipContent>{CHANGE_TYPE_LABELS[file.changeType]}</TooltipContent>
            </Tooltip>
          </Button>
        }
      />
      <TooltipContent>{pathLabel}</TooltipContent>
    </Tooltip>
  );
}
