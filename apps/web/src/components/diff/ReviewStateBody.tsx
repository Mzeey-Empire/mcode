import { useState } from "react";
import { CircleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { cn } from "@/lib/utils";
import { useDiffStore } from "@/stores/diffStore";
import type { ReviewBody } from "./review-body";

/** Every Review body except a comparison with files to show. */
export type ReviewStateBodyKind = Exclude<ReviewBody, { kind: "ready" }>;

/** The three-dot pulse a Review body shows while nothing has settled yet. */
export function ReviewLoadingPulse() {
  return (
    <div data-testid="review-loading" className="flex min-h-full items-center justify-center gap-1.5 py-10">
      {[0, 150, 300].map((delay) => (
        <div key={delay} className="h-1 w-1 rounded-full bg-muted/25 animate-pulse" style={{ animationDelay: `${delay}ms` }} />
      ))}
    </div>
  );
}

/**
 * The centred body for an empty, failed, oversized, or expired comparison.
 * The toolbar above stays mounted, so Refresh is always one click away.
 */
export function ReviewStateBody({ body, onRetry }: { readonly body: ReviewStateBodyKind; readonly onRetry: () => void }) {
  return (
    <div data-testid="review-state" data-review-state={body.kind} className="flex min-h-full flex-col items-center justify-center gap-3 px-6 py-14 text-center">
      <ReviewStateContent body={body} onRetry={onRetry} />
    </div>
  );
}

function ReviewStateContent({ body, onRetry }: { readonly body: ReviewStateBodyKind; readonly onRetry: () => void }) {
  switch (body.kind) {
    case "empty":
      return <ReviewStateText title={body.title} detail={body.detail} />;
    case "gone":
      return <>
        <CircleAlert aria-hidden="true" className="size-5 text-muted" />
        <ReviewStateText title={body.title} detail={body.detail} />
      </>;
    case "too-many-files":
      return <TooManyFilesBody fileCount={body.fileCount} limit={body.limit} />;
    case "failed":
      return <FailedBody summary={body.summary} detail={body.detail} onRetry={onRetry} />;
  }
}

function ReviewStateText({ title, detail }: { readonly title: string; readonly detail?: string }) {
  return (
    <div className="flex flex-col items-center gap-1">
      <p className="text-body-small font-medium text-ink">{title}</p>
      {detail ? <p className="text-body-small text-muted">{detail}</p> : null}
    </div>
  );
}

function TooManyFilesBody({ fileCount, limit }: { readonly fileCount: number; readonly limit: number }) {
  const openViewMenu = useDiffStore((s) => s.setReviewViewMenuOpen);
  return <>
    <CircleAlert aria-hidden="true" className="size-5 text-primary" />
    <ReviewStateText
      title="Too many files to show"
      detail={`${fileCount.toLocaleString("en-US")} changed files. Review shows up to ${limit.toLocaleString("en-US")}.`}
    />
    <Button type="button" variant="subtle" shape="round" className="h-7 px-3 text-label" onClick={() => openViewMenu(true)}>
      Choose another view
    </Button>
  </>;
}

function FailedBody({ summary, detail, onRetry }: { readonly summary: string; readonly detail: string; readonly onRetry: () => void }) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  return <>
    <CircleAlert aria-hidden="true" className="size-5 text-error" />
    <ReviewStateText title="Couldn't load this comparison" detail={summary} />
    <div className="flex gap-2">
      <Button
        type="button"
        variant="ghost"
        className={cn("h-7 px-2.5 text-label text-muted", detailsOpen && "text-ink")}
        aria-expanded={detailsOpen}
        onClick={() => setDetailsOpen((open) => !open)}
      >
        Details
      </Button>
      <Button type="button" variant="subtle" shape="round" className="h-7 px-3 text-label" onClick={onRetry}>
        Retry
      </Button>
    </div>
    {detailsOpen ? <FailureDetail detail={detail} /> : null}
  </>;
}

function FailureDetail({ detail }: { readonly detail: string }) {
  return (
    <div className="relative mt-1 w-full max-w-xl rounded-control border border-border bg-panel text-left">
      <CopyButton text={detail} label="Copy error details" className="absolute top-1 right-1" />
      <pre data-testid="review-failure-detail" className="max-h-60 overflow-auto whitespace-pre-wrap break-words py-2 pr-10 pl-3 font-mono text-caption text-ink">
        {detail}
      </pre>
    </div>
  );
}
