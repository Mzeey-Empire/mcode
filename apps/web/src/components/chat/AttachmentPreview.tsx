import { X, FileText, File } from "lucide-react";
import type { McodeBrowserCapture } from "@mcode/contracts";
import { isVirtualBrowserContextAttachment } from "@mcode/contracts";
import { cn } from "@/lib/utils";

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

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
  if (attachments.length === 0) return null;

  return (
    <div className="flex gap-2 overflow-x-auto px-3 py-2">
      {attachments.map((att) => {
        const isImage = att.mimeType.startsWith("image/");
        const isPdf = att.mimeType === "application/pdf";
        const isContextOnly =
          att.contextOnly === true || isVirtualBrowserContextAttachment(att.mimeType);
        const spill = getBrowserCaptureSpillHints(att.browserCapture);
        const isOfficeDoc =
          att.mimeType.includes("officedocument") ||
          att.mimeType.includes("opendocument") ||
          att.mimeType === "application/rtf" ||
          att.mimeType === "text/rtf";

        return (
          <div
            key={att.id}
            className={cn(
              "group relative flex-shrink-0 overflow-hidden rounded-lg",
              "border border-border/60 bg-muted/60",
              "transition-all duration-150 hover:border-primary/40 hover:bg-muted/80",
            )}
            title={spill?.title}
          >
            {isContextOnly ? (
              <div className="flex h-[72px] w-[140px] flex-col justify-center gap-0.5 px-3 py-1">
                <div className="flex min-h-0 items-center gap-2">
                  <FileText size={18} className="shrink-0 text-cyan-500 dark:text-cyan-400" />
                  <span className="truncate text-xs font-medium text-foreground">Page context</span>
                </div>
                <span className="block max-w-[120px] truncate pl-[26px] text-[10px] leading-tight text-muted-foreground">
                  {spill ? spill.line : "No image"}
                </span>
              </div>
            ) : isImage ? (
              <div className="relative h-[72px] w-[72px]">
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
                />
                {/* Subtle gradient overlay so the X button is always readable */}
                <div className="absolute inset-0 bg-gradient-to-br from-black/30 via-transparent to-transparent opacity-0 transition-opacity group-hover:opacity-100" />
              </div>
            ) : (
              <div className="flex h-[72px] w-[140px] flex-col justify-center gap-1 px-3">
                <div className="flex items-center gap-2">
                  {isPdf ? (
                    <FileText size={18} className="shrink-0 text-red-600 dark:text-red-400" />
                  ) : isOfficeDoc ? (
                    <FileText size={18} className="shrink-0 text-blue-600 dark:text-blue-400" />
                  ) : (
                    <File size={18} className="shrink-0 text-muted-foreground" />
                  )}
                  <span className="truncate text-xs font-medium text-foreground">
                    {att.name}
                  </span>
                </div>
                <span className="pl-[26px] text-[10px] text-muted-foreground">
                  {formatSize(att.sizeBytes)}
                </span>
              </div>
            )}

            {/* Always-visible remove button with clear contrast */}
            <button
              type="button"
              onClick={() => onRemove(att.id)}
              className={cn(
                "absolute right-1 top-1 flex items-center justify-center",
                "h-5 w-5 rounded-full",
                "bg-foreground/75 text-background",
                "opacity-0 transition-all duration-150",
                "hover:bg-destructive hover:text-white",
                "group-hover:opacity-100",
                "focus:opacity-100 focus:outline-none focus:ring-1 focus:ring-primary",
              )}
              aria-label={`Remove ${att.name}`}
            >
              <X size={12} strokeWidth={2.5} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
