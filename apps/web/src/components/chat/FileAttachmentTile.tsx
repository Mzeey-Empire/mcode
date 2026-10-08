import { FileText, File } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

import {
  attachmentIconKindFromMime,
  formatAttachmentByteSize,
} from "./attachment-display";

/** Layout presets for attachment tiles in composer vs transcript. */
export type FileAttachmentTileVariant = "composer" | "transcript";

/** Props for {@link FileAttachmentTile}. */
export interface FileAttachmentTileProps {
  /** Original filename for display. */
  name: string;
  sizeBytes: number;
  mimeType: string;
  variant: FileAttachmentTileVariant;
  /** Corner overlay such as remove control; parent Tile is `position: relative`. */
  accessory?: ReactNode;
  className?: string;
}

/**
 * Icon-led framed surface for non-image attachments (PDF, Office, generic).
 * Matches transcript and composer previews without rasterizing PDFs.
 */
export function FileAttachmentTile({
  name,
  sizeBytes,
  mimeType,
  variant,
  accessory,
  className,
}: FileAttachmentTileProps) {
  const kind = attachmentIconKindFromMime(mimeType);
  const icon =
    kind === "pdf" ? (
      <FileText size={18} className="shrink-0 text-muted" aria-hidden />
    ) : kind === "office" ? (
      <FileText size={18} className="shrink-0 text-muted" aria-hidden />
    ) : (
      <File size={18} className="shrink-0 text-muted" aria-hidden />
    );

  const isComposer = variant === "composer";

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            className={cn(
              "relative overflow-hidden rounded-xl",
              "border border-border/60 bg-hover/45 ring-1 ring-primary/15",
              isComposer ? "h-[72px] w-[140px]" : "min-h-[72px] w-full max-w-[260px]",
              className,
            )}
          >
            {accessory}
            <div
              className={cn(
                "flex h-full flex-col justify-center gap-1",
                isComposer ? "px-3 py-2" : "px-3 py-2.5",
              )}
            >
              <div className="flex min-w-0 items-center gap-2">
                {icon}
                <span className="text-fade text-xs font-medium text-ink">{name}</span>
              </div>
              <span className="pl-[26px] text-xs tabular-nums text-muted">
                {formatAttachmentByteSize(sizeBytes)}
              </span>
            </div>
          </div>
        }
      />
      <TooltipContent>{name}</TooltipContent>
    </Tooltip>
  );
}
