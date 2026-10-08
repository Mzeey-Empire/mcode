import {
  isDiffAnnotationPayload,
  type ComposerAnnotationPayload,
  type PreviewAnnotationBundle,
} from "@mcode/contracts";
import { FileCodeCorner, ImageIcon, MessageCircle, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { buildStoredAttachmentImageSrc } from "@/lib/attachment-url";
import {
  composerFeedbackAccessibleLabel,
  composerFeedbackLabel,
} from "@/lib/composer-feedback";
import { cn } from "@/lib/utils";
import { useRetriableAttachmentImage } from "./useRetriableAttachmentImage";

const MAX_DETAIL_LENGTH = 220;

function feedbackTargetLabel(item: ComposerAnnotationPayload): string {
  if (isDiffAnnotationPayload(item)) {
    return `${item.filePath}:${item.line}`;
  }
  return (
    item.targetContext.label?.trim() ||
    item.targetContext.selectorHint?.trim() ||
    "Element"
  );
}

function feedbackDetail(item: ComposerAnnotationPayload): string {
  const text = isDiffAnnotationPayload(item)
    ? item.note.trim()
    : item.note?.trim() || item.changeSummary?.trim() || "Visual annotation";
  return text.length <= MAX_DETAIL_LENGTH
    ? text
    : `${text.slice(0, MAX_DETAIL_LENGTH - 3).trimEnd()}...`;
}

function AnnotationSnapshotThumbnail({ src }: { readonly src: string }) {
  const image = useRetriableAttachmentImage(src);

  return (
    <span className="relative block aspect-video w-28 shrink-0 overflow-hidden rounded-md bg-hover/35 ring-1 ring-inset ring-border/60">
      {image.failed ? (
        <span className="flex h-full w-full items-center justify-center text-muted">
          <ImageIcon size={16} aria-hidden />
        </span>
      ) : (
        <>
          <img
            src={image.src}
            alt=""
            className={cn(
              "h-full w-full object-contain transition-opacity duration-150 motion-reduce:transition-none",
              image.retrying ? "opacity-0" : "opacity-100",
            )}
            loading="lazy"
            data-testid="preview-annotation-hover-thumbnail"
            onError={image.onError}
            onLoad={image.onLoad}
          />
          {image.retrying ? (
            <span className="absolute inset-0 flex items-center justify-center text-muted/70">
              <ImageIcon size={14} className="animate-pulse" aria-hidden />
            </span>
          ) : null}
        </>
      )}
    </span>
  );
}

/** Props for the compact feedback chip shown in composer and transcript surfaces. */
export interface PreviewAnnotationBundleChipProps {
  /** Saved Preview annotations and code comments to summarize. */
  readonly bundle: PreviewAnnotationBundle;
  /** Thread that owns the persisted annotation screenshots. */
  readonly threadId?: string;
  /** Optional removal action. Hidden until hover or focus. */
  readonly onRemove?: () => void;
  /** Extra classes for the chip root. */
  readonly className?: string;
  /** Test id for the chip root. */
  readonly testId?: string;
}

/** Renders a responsive feedback summary with hoverable item details. */
export function PreviewAnnotationBundleChip({
  bundle,
  threadId,
  onRemove,
  className,
  testId = "preview-annotation-bundle-chip",
}: PreviewAnnotationBundleChipProps) {
  if (bundle.annotations.length === 0) return null;

  const label = composerFeedbackLabel(bundle);
  const accessibleLabel = composerFeedbackAccessibleLabel(bundle);

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            data-testid={testId}
            tabIndex={0}
            aria-label={`${accessibleLabel}. Details available.`}
            className={cn(
              "group relative inline-flex max-w-full items-center gap-2 rounded-lg bg-selected px-2 py-1 text-xs font-medium text-ink ring-1 ring-inset ring-ink/10 transition-colors duration-150 hover:bg-selected/90 hover:ring-ink/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/25 motion-reduce:transition-none",
              className,
            )}
          >
            <MessageCircle size={14} aria-hidden />
            <span className="text-fade">{label}</span>
            {onRemove ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={`Remove ${label}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onRemove();
                }}
                className="pointer-events-none absolute -right-2 -top-2 size-5 rounded-full bg-selected text-ink/70 opacity-0 ring-1 ring-inset ring-ink/15 transition-opacity duration-150 hover:bg-ink/10 hover:text-ink focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 motion-reduce:transition-none"
              >
                <X size={12} aria-hidden />
              </Button>
            ) : null}
          </div>
        }
      />
      <TooltipContent
        side="top"
        align="end"
        sideOffset={8}
        className="w-[min(32rem,calc(100vw-1.6rem))] max-w-none items-stretch rounded-xl bg-panel p-3 text-ink ring-1 ring-inset ring-border/70"
      >
        <div className="max-h-80 min-w-0 divide-y divide-border/45 overflow-y-auto">
          {bundle.annotations.map((item) => {
            const isComment = isDiffAnnotationPayload(item);
            const snapshotSrc = threadId && !isComment
              ? buildStoredAttachmentImageSrc(
                  threadId,
                  item.snapshot.id,
                  item.snapshot.mimeType,
                )
              : null;
            return (
              <div
                key={item.id}
                className="flex min-w-0 items-start gap-3 py-3 first:pt-0 last:pb-0"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <span className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/80 text-xs font-semibold tabular-nums text-primary-ink/90">
                      {item.displayNumber}
                    </span>
                    {isComment ? (
                      <FileCodeCorner size={14} className="shrink-0 text-muted" aria-hidden />
                    ) : (
                      <ImageIcon size={14} className="shrink-0 text-muted" aria-hidden />
                    )}
                    <span className="shrink-0 text-xs font-medium text-ink">
                      {isComment ? "Comment" : "Annotation"}
                    </span>
                    <span aria-hidden className="text-muted/45">·</span>
                    <span className="min-w-0 text-fade font-mono text-[1.1rem] font-normal text-muted">
                      {feedbackTargetLabel(item)}
                    </span>
                  </div>
                  <p className="mt-2 min-w-0 whitespace-pre-wrap break-words text-xs leading-5 text-ink">
                    {feedbackDetail(item)}
                  </p>
                </div>
                {snapshotSrc ? <AnnotationSnapshotThumbnail src={snapshotSrc} /> : null}
              </div>
            );
          })}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
