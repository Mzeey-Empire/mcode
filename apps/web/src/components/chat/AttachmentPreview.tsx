import { FileText, X } from "lucide-react";
import { useMemo, useState } from "react";
import type { McodeBrowserCapture } from "@mcode/contracts";
import { isVirtualBrowserContextAttachment } from "@mcode/contracts";
import { cn } from "@/lib/utils";

import { FileAttachmentTile } from "./FileAttachmentTile";
import { ImageAttachmentLightbox } from "./ImageAttachmentLightbox";

/** Represents a user-selected file staged on the composer before send (preview URL may be an object URL). */
export interface PendingAttachment {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  previewUrl: string;
  filePath: string | null;
  /** Structured BrowserView preview context bundled with PNG references from desktop. */
  browserCapture?: McodeBrowserCapture;
  /** When true, only structured `browserCapture` is sent (no image file). */
  contextOnly?: boolean;
}

interface AttachmentPreviewProps {
  attachments: PendingAttachment[];
  onRemove: (id: string) => void;
}

/** Spill file hints for v2 preview captures (Mcode app data dir, not the project). */
function getBrowserCaptureSpillHints(capture: McodeBrowserCapture | undefined): {
  line: string;
  title: string;
} | undefined {
  if (capture?.schemaVersion !== 2) return undefined;
  const rel = capture.spillAppDataPath;
  const abs = capture.spillAbsolutePath;
  if (!rel && !abs) return undefined;
  const line = rel ?? abs ?? "";
  const title = [
    "Full preview text is stored in the Mcode application data directory (for example ~/.mcode or %USERPROFILE%\\.mcode in production, ~/.mcode-dev in development), not inside your project folder.",
    abs ? `Open this file:\n${abs}` : null,
    rel ? `Relative to that folder:\n${rel}` : null,
  ]
    .filter(Boolean)
    .join("\n\n");
  return { line, title };
}

/** Horizontal strip of pending attachment thumbnails or file tiles with per-item remove actions. */
export function AttachmentPreview({ attachments, onRemove }: AttachmentPreviewProps) {
  const previewableImages = useMemo(
    () => attachments.filter((a) => a.mimeType.startsWith("image/") && !!a.previewUrl),
    [attachments],
  );

  const [imagePreview, setImagePreview] = useState<{
    items: { src: string; title: string }[];
    initialIndex: number;
  } | null>(null);

  if (attachments.length === 0) return null;

  const removeButton = (name: string, id: string) => (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onRemove(id);
      }}
      className={cn(
        "absolute right-1 top-1 z-20 flex items-center justify-center",
        "h-5 w-5 rounded-full",
        "bg-foreground/75 text-background",
        "opacity-0 transition-all duration-150",
        "hover:bg-destructive hover:text-white",
        "group-hover:opacity-100",
        "focus:opacity-100 focus:outline-none focus:ring-1 focus:ring-primary",
      )}
      aria-label={`Remove ${name}`}
    >
      <X size={12} strokeWidth={2.5} />
    </button>
  );

  return (
    <>
      <div className="flex gap-2 overflow-x-auto px-3 py-2">
        {attachments.map((att) => {
          // Image tiles need a blob preview URL. Attachments rehydrated from
          // disk-side metadata (e.g. restored from the message queue) have no
          // blob URL, so they fall through to the generic file tile instead of
          // rendering a broken <img>.
          const isImage = att.mimeType.startsWith("image/") && !!att.previewUrl;
          const isContextOnly =
            att.contextOnly === true || isVirtualBrowserContextAttachment(att.mimeType);
          const spill = getBrowserCaptureSpillHints(att.browserCapture);

          if (isContextOnly) {
            return (
              <div
                key={att.id}
                className={cn(
                  "group relative flex-shrink-0 overflow-hidden rounded-lg border border-border/60 bg-muted/60 transition-all duration-150",
                  "hover:border-primary/40 hover:bg-muted/80",
                )}
                title={spill?.title}
              >
                <div className="flex h-[72px] w-[140px] flex-col justify-center gap-0.5 px-3 py-1">
                  <div className="flex min-h-0 items-center gap-2">
                    <FileText size={18} className="shrink-0 text-cyan-500 dark:text-cyan-400" />
                    <span className="truncate text-xs font-medium text-foreground">Page context</span>
                  </div>
                  <span className="block max-w-[120px] truncate pl-[26px] text-[10px] leading-tight text-muted-foreground">
                    {spill ? spill.line : "No image"}
                  </span>
                  {removeButton(att.name, att.id)}
                </div>
              </div>
            );
          }

          if (isImage) {
            const slideIndex = previewableImages.findIndex((x) => x.id === att.id);
            return (
              <button
                key={att.id}
                type="button"
                className={cn(
                  "group relative flex h-[72px] w-[72px] flex-shrink-0 cursor-pointer overflow-hidden rounded-lg border p-0 text-left outline-none",
                  "border-border/60 bg-muted/60 transition-[border-color,background-color,filter]",
                  "hover:border-primary/45 hover:bg-muted/80 hover:brightness-[1.04]",
                  "focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                )}
                title={spill?.title}
                aria-label={`Preview image ${att.name}`}
                onClick={() =>
                  setImagePreview({
                    items: previewableImages.map((a) => ({
                      src: a.previewUrl,
                      title: a.name,
                    })),
                    initialIndex: slideIndex >= 0 ? slideIndex : 0,
                  })
                }
              >
                {spill ? (
                  <span
                    className="absolute bottom-0.5 left-0.5 right-0.5 z-10 truncate rounded bg-background/85 px-0.5 text-center text-[8px] font-medium text-foreground/90 shadow-sm"
                    title={spill.title}
                  >
                    + spill file
                  </span>
                ) : null}
                <img
                  src={att.previewUrl}
                  alt={att.name}
                  className="h-full w-full object-cover"
                  draggable={false}
                />
                <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-black/25 via-transparent to-transparent opacity-0 transition-opacity group-hover:opacity-100" />
                {removeButton(att.name, att.id)}
              </button>
            );
          }

          return (
            <div
              key={att.id}
              className={cn(
                "group relative flex-shrink-0 overflow-hidden rounded-lg transition-all duration-150",
                "border border-transparent hover:border-primary/40 hover:bg-muted/50",
              )}
            >
              <FileAttachmentTile
                variant="composer"
                name={att.name}
                sizeBytes={att.sizeBytes}
                mimeType={att.mimeType}
                accessory={removeButton(att.name, att.id)}
              />
            </div>
          );
        })}
      </div>
      <ImageAttachmentLightbox
        open={imagePreview !== null}
        onOpenChange={(open) => {
          if (!open) setImagePreview(null);
        }}
        items={imagePreview?.items ?? []}
        initialIndex={imagePreview?.initialIndex ?? 0}
      />
    </>
  );
}
