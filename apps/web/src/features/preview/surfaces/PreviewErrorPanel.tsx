import {
  ArrowClockwiseIcon,
  ArrowLeftIcon,
  FileXIcon,
  GlobeXIcon,
  ShieldWarningIcon,
  WarningDiamondIcon,
  WifiSlashIcon,
  type Icon,
} from "@phosphor-icons/react";
import type { PreviewPageError } from "@mcode/contracts";
import { Button } from "@/components/ui/button";

/** Per-kind glyph for the error headline. */
const ERROR_ICON: Record<PreviewPageError["kind"], Icon> = {
  http: GlobeXIcon,
  network: WifiSlashIcon,
  "file-not-found": FileXIcon,
  crash: WarningDiamondIcon,
  blocked: ShieldWarningIcon,
};

/** Props for {@link PreviewErrorPanel}. */
export interface PreviewErrorPanelProps {
  /** Classified failure that put the preview into its error phase. */
  readonly error: PreviewPageError;
  /** URL that failed to load; shown as diagnostic context under the headline. */
  readonly url: string | null;
  /** Whether the guest has back history; gates the secondary "Go back" action. */
  readonly canBack: boolean;
  /** Reload the failed page. */
  readonly onRetry: () => void;
  /** Navigate the guest back one entry. */
  readonly onGoBack: () => void;
}

/**
 * Error surface shown when a Browser page fails to load. Follows the browser
 * error-page grammar: a large duotone glyph, a display headline naming the
 * failure, a short next-move line, a mono diagnostic line carrying the code
 * and attempted address, and the recovery actions.
 *
 * Editing the address and opening in the system browser are intentionally NOT
 * here: the omnibox directly above is the URL editor, and the toolbar already
 * owns "Open in system browser" (which is meaningless on an unreachable site).
 */
export function PreviewErrorPanel({
  error,
  url,
  canBack,
  onRetry,
  onGoBack,
}: PreviewErrorPanelProps) {
  const Icon = ERROR_ICON[error.kind];
  // A blocked file stays blocked; retrying would only refuse again.
  const canRetry = error.kind !== "blocked";
  const diagnostic = error.status ? String(error.status) : (error.code ?? null);
  const diagnosticLine = [diagnostic, url].filter(Boolean).join(" · ");

  return (
    <div
      data-testid="preview-error-panel"
      role="alert"
      className="absolute inset-0 flex flex-col items-center justify-center gap-7 px-6 text-center motion-safe:animate-in motion-safe:fade-in"
    >
      {/* Duotone is the documented weight for large empty-state glyphs; clay
          tint marks the errored reading at glance speed. 48px steps past the
          32px display size because this glyph is the page hero, matching the
          browser error pages this surface emulates. */}
      <Icon size={48} weight="duotone" className="text-destructive/70" aria-hidden />
      <div className="flex max-w-md flex-col items-center gap-3">
        <p
          data-testid="preview-error-headline"
          className="text-[2.4rem] font-semibold leading-[2.8rem] tracking-[-0.01em] text-foreground"
        >
          {error.message}
        </p>
        {error.detail ? (
          <p
            data-testid="preview-error-detail"
            className="text-balance text-sm leading-relaxed text-muted-foreground"
          >
            {error.detail}
          </p>
        ) : null}
      </div>
      {diagnosticLine ? (
        <p className="max-w-md truncate font-mono text-[11px] text-muted-foreground/70">
          {diagnosticLine}
        </p>
      ) : null}
      <div className="flex items-center justify-center gap-2">
        {canRetry ? (
          // The lamp hue as a tonal wash: still the primary recovery action,
          // but the solid fill reads muddy at control scale.
          <Button
            size="sm"
            variant="ghost"
            onClick={onRetry}
            data-testid="preview-error-retry"
            className="rounded-2xl bg-primary/[0.12] text-primary ring-1 ring-inset ring-primary/20 hover:bg-primary/[0.2] hover:text-primary"
          >
            <ArrowClockwiseIcon aria-hidden />
            Retry
          </Button>
        ) : null}
        {canBack ? (
          <Button size="sm" variant="ghost" onClick={onGoBack} className="rounded-2xl">
            <ArrowLeftIcon aria-hidden />
            Go back
          </Button>
        ) : null}
      </div>
    </div>
  );
}
