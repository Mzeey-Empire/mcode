import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  ArrowLeft,
  ArrowRight,
  Crosshair,
  Crop,
  ExternalLink,
  FileText,
  Globe,
  ImagePlus,
  Loader2,
  RotateCw,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import { useDiffStore } from "@/stores/diffStore";
import type { PendingAttachment } from "@/components/chat/AttachmentPreview";
import { useToastStore } from "@/stores/toastStore";
import { usePreviewReferenceQueueStore } from "@/stores/previewReferenceQueueStore";
import type { McodeBrowserCapture } from "@mcode/contracts";
import { SmartOmnibox } from "./SmartOmnibox";
import { MCODE_BROWSER_CONTEXT_ATTACHMENT_MIME } from "@mcode/contracts";

const NAV_ERROR_LABEL: Record<string, string> = {
  "no-bounds": "Wait for the panel to finish layout, then try again.",
  "invalid-url": "Only http and https URLs are allowed.",
  "empty-url": "Enter a URL.",
  "no-window": "Preview is unavailable.",
};

const CAPTURE_ERROR_SILENT = new Set(["cancelled", "capture-interrupted", "navigated-away"]);

const CAPTURE_ERROR_LABEL: Record<string, string> = {
  "no-window": "Preview is unavailable.",
  "no-preview": "Keep the preview visible and load a page first.",
  "empty-capture": "Nothing was captured.",
  "capture-failed": "Screenshot failed.",
  "region-too-small": "Drag a larger box (at least a few pixels).",
  "no-hit": "Click an element on the page.",
};

function formatCaptureError(code: string): string {
  return CAPTURE_ERROR_LABEL[code] ?? code;
}

type CaptureResult =
  | {
      ok: true;
      meta: {
        id: string;
        name: string;
        mimeType: string;
        sizeBytes: number;
        sourcePath: string;
      };
      previewBytes: Uint8Array;
      capture: McodeBrowserCapture;
    }
  | { ok: false; error: string };

type ContextCaptureResult =
  | { ok: true; capture: McodeBrowserCapture }
  | { ok: false; error: string };

function showCaptureErrorIfNeeded(res: CaptureResult | ContextCaptureResult): void {
  if (res.ok || CAPTURE_ERROR_SILENT.has(res.error)) return;
  useToastStore.getState().show("error", "Could not capture preview", formatCaptureError(res.error));
}

/** Resolves an IPC error code to a short user-visible hint. */
function formatNavError(code: string): string {
  return NAV_ERROR_LABEL[code] ?? code;
}

export interface PreviewPanelProps {
  /** Thread that owns preview state (URL memory and future captures). */
  readonly threadId: string;
  /** Active workspace id; scopes spill files under the Mcode app data dir (not the project tree). */
  readonly workspaceId?: string | null;
}

/**
 * Embedded site preview: omnibox and toolbar above a region aligned to an Electron BrowserView.
 * A loading banner sits between the form and guest region because the BrowserView stacks above HTML and would hide in-surface overlays. Full viewport, drag-selected region, element-pick PNGs, or fence-only page context attach to the composer. The chrome uses a
 * two-row header so the omnibox keeps usable width on narrow panels. Tooltips open upward so they stay
 * readable: the guest BrowserView is stacked above shell HTML and would hide downward popups.
 * In web-only builds without `desktopBridge.preview`, renders an explanatory empty state.
 */
export function PreviewPanel({ threadId, workspaceId }: PreviewPanelProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [inputUrl, setInputUrl] = useState("");
  const [navError, setNavError] = useState<string | null>(null);
  const [canBack, setCanBack] = useState(false);
  const [canFwd, setCanFwd] = useState(false);

  const [captureBusy, setCaptureBusy] = useState(false);
  const [regionBusy, setRegionBusy] = useState(false);
  const [elementPickBusy, setElementPickBusy] = useState(false);
  const [contextBusy, setContextBusy] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [pageTitle, setPageTitle] = useState<string | null>(null);
  const [faviconUrl, setFaviconUrl] = useState<string | null>(null);

  const storedUrl = useDiffStore(
    (s) => s.previewUrlByThread[threadId] ?? "",
  );

  useEffect(() => {
    setInputUrl(storedUrl);
    setNavError(null);
  }, [threadId, storedUrl]);

  const refreshNav = useCallback(async () => {
    const preview = window.desktopBridge?.preview;
    if (!preview) return;
    const s = await preview.getNavigationState();
    setCanBack(s.canGoBack);
    setCanFwd(s.canGoForward);
  }, []);

  const pushSync = useCallback(
    async (visible: boolean) => {
      const preview = window.desktopBridge?.preview;
      if (!preview) return;
      const el = surfaceRef.current;
      const hint = storedUrl.trim() || null;
      if (!visible || !el) {
        await preview.sync({
          visible: false,
          bounds: null,
          threadId,
          resumeUrlHint: hint,
          workspaceId: workspaceId ?? null,
        });
        return;
      }
      const r = el.getBoundingClientRect();
      await preview.sync({
        visible: true,
        bounds: {
          x: Math.round(r.left),
          y: Math.round(r.top),
          width: Math.round(r.width),
          height: Math.round(r.height),
        },
        threadId,
        resumeUrlHint: hint,
        workspaceId: workspaceId ?? null,
      });
    },
    [threadId, storedUrl, workspaceId],
  );

  useEffect(() => {
    const preview = window.desktopBridge?.preview;
    if (!preview) return;
    const unsub = preview.onDidNavigate((p) => {
      if (
        p.url &&
        !p.url.startsWith("chrome-error://") &&
        !p.url.startsWith("about:")
      ) {
        useDiffStore.getState().setPreviewUrlForThread(threadId, p.url);
        setInputUrl(p.url);
        setPageTitle(p.title ?? null);
        setFaviconUrl(p.favicon ?? null);
      }
      void refreshNav();
    });
    return unsub;
  }, [threadId, refreshNav]);

  useEffect(() => {
    const preview = window.desktopBridge?.preview;
    if (!preview?.onDidUpdateFavicon) return;
    return preview.onDidUpdateFavicon((p) => {
      setFaviconUrl(p.favicon);
    });
  }, []);

  useEffect(() => {
    const preview = window.desktopBridge?.preview;
    if (!preview) return;
    return preview.onLoadingState((p) => setPreviewLoading(p.loading));
  }, []);

  useEffect(() => {
    const preview = window.desktopBridge?.preview;
    if (!preview) return;
    const el = surfaceRef.current;
    if (!el) return;

    let raf = 0;
    const schedule = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        raf = 0;
        void pushSync(true);
        void refreshNav();
      });
    };

    const ro = new ResizeObserver(schedule);
    ro.observe(el);
    schedule();

    window.addEventListener("resize", schedule);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", schedule);
      if (raf) cancelAnimationFrame(raf);
      void pushSync(false);
    };
  }, [pushSync, refreshNav]);

  const onGoBack = async () => {
    const preview = window.desktopBridge?.preview;
    if (!preview) return;
    await pushSync(true);
    await preview.goBack();
    await refreshNav();
  };

  const onGoForward = async () => {
    const preview = window.desktopBridge?.preview;
    if (!preview) return;
    await pushSync(true);
    await preview.goForward();
    await refreshNav();
  };

  const onReload = async () => {
    const preview = window.desktopBridge?.preview;
    if (!preview) return;
    await pushSync(true);
    await preview.reload();
    await refreshNav();
  };

  const onOpenExternal = async () => {
    const preview = window.desktopBridge?.preview;
    if (!preview) return;
    await preview.openExternal();
  };

  const onAddPictureReference = useCallback(async () => {
    const preview = window.desktopBridge?.preview;
    if (!preview?.capturePictureReference || !threadId) return;

    setCaptureBusy(true);
    try {
      await pushSync(true);

      let res: CaptureResult;
      try {
        res = (await preview.capturePictureReference()) as CaptureResult;
      } catch {
        useToastStore.getState().show("error", "Could not capture preview", "Screenshot failed.");
        return;
      }

      showCaptureErrorIfNeeded(res);
      if (!res.ok) return;

      const copied = Uint8Array.from(res.previewBytes);
      const blob = new Blob([copied], { type: "image/png" });
      const previewUrl = URL.createObjectURL(blob);
      const attachment: PendingAttachment = {
        id: res.meta.id,
        name: res.meta.name,
        mimeType: res.meta.mimeType,
        sizeBytes: res.meta.sizeBytes,
        previewUrl,
        filePath: res.meta.sourcePath,
        browserCapture: res.capture,
      };
      usePreviewReferenceQueueStore.getState().enqueuePreviewReference(threadId, attachment);
    } finally {
      setCaptureBusy(false);
    }
  }, [pushSync, threadId]);

  const onAddRegionPictureReference = useCallback(async () => {
    const preview = window.desktopBridge?.preview;
    if (!preview?.capturePictureReferenceRegion || !threadId) return;

    setRegionBusy(true);
    try {
      await pushSync(true);

      let res: CaptureResult;
      try {
        res = (await preview.capturePictureReferenceRegion()) as CaptureResult;
      } catch {
        useToastStore.getState().show("error", "Could not capture preview", "Screenshot failed.");
        return;
      }

      showCaptureErrorIfNeeded(res);
      if (!res.ok) return;

      const copied = Uint8Array.from(res.previewBytes);
      const blob = new Blob([copied], { type: "image/png" });
      const previewUrl = URL.createObjectURL(blob);
      const attachment: PendingAttachment = {
        id: res.meta.id,
        name: res.meta.name,
        mimeType: res.meta.mimeType,
        sizeBytes: res.meta.sizeBytes,
        previewUrl,
        filePath: res.meta.sourcePath,
        browserCapture: res.capture,
      };
      usePreviewReferenceQueueStore.getState().enqueuePreviewReference(threadId, attachment);
    } finally {
      setRegionBusy(false);
    }
  }, [pushSync, threadId]);

  const onAddElementPickPictureReference = useCallback(async () => {
    const preview = window.desktopBridge?.preview;
    if (!preview?.capturePictureReferenceElementPick || !threadId) return;

    setElementPickBusy(true);
    try {
      await pushSync(true);

      let res: CaptureResult;
      try {
        res = (await preview.capturePictureReferenceElementPick()) as CaptureResult;
      } catch {
        useToastStore.getState().show("error", "Could not capture preview", "Screenshot failed.");
        return;
      }

      showCaptureErrorIfNeeded(res);
      if (!res.ok) return;

      const copied = Uint8Array.from(res.previewBytes);
      const blob = new Blob([copied], { type: "image/png" });
      const previewUrl = URL.createObjectURL(blob);
      const attachment: PendingAttachment = {
        id: res.meta.id,
        name: res.meta.name,
        mimeType: res.meta.mimeType,
        sizeBytes: res.meta.sizeBytes,
        previewUrl,
        filePath: res.meta.sourcePath,
        browserCapture: res.capture,
      };
      usePreviewReferenceQueueStore.getState().enqueuePreviewReference(threadId, attachment);
    } finally {
      setElementPickBusy(false);
    }
  }, [pushSync, threadId]);

  const onAddPageContextOnly = useCallback(async () => {
    const preview = window.desktopBridge?.preview;
    if (!preview?.capturePageContext || !threadId) return;

    setContextBusy(true);
    try {
      await pushSync(true);

      let res: ContextCaptureResult;
      try {
        res = (await preview.capturePageContext()) as ContextCaptureResult;
      } catch {
        useToastStore.getState().show("error", "Could not capture preview", "Context capture failed.");
        return;
      }

      if (!res.ok) {
        showCaptureErrorIfNeeded(res);
        return;
      }

      const attachment: PendingAttachment = {
        id: crypto.randomUUID(),
        name: "Page context",
        mimeType: MCODE_BROWSER_CONTEXT_ATTACHMENT_MIME,
        sizeBytes: 0,
        previewUrl: "",
        filePath: null,
        browserCapture: res.capture,
        contextOnly: true,
      };
      usePreviewReferenceQueueStore.getState().enqueuePreviewReference(threadId, attachment);
    } finally {
      setContextBusy(false);
    }
  }, [pushSync, threadId]);

  if (!window.desktopBridge?.preview) {
    return (
      <div
        className="flex flex-1 flex-col items-center justify-center gap-2 px-4 py-8 text-center text-sm text-muted-foreground"
        data-testid="preview-panel-unavailable"
      >
        <Globe className="size-8 opacity-50" aria-hidden />
        <p className="max-w-xs text-balance">
          Embedded preview runs in the desktop app. Open Mcode from Electron to
          browse http and https sites alongside this thread.
        </p>
      </div>
    );
  }

  const anyCaptureActive = captureBusy || regionBusy || elementPickBusy || contextBusy;
  const hasLoadedPage = storedUrl.trim().length > 0;

  return (
    <div
      data-testid="preview-panel"
      className="flex min-h-0 min-w-[20rem] flex-1 flex-col"
    >
      <form
        onSubmit={(e) => e.preventDefault()}
        className="flex-none space-y-1.5 border-b border-border/40 px-2 pt-2 pb-1.5"
      >
        <SmartOmnibox
          url={inputUrl}
          pageTitle={pageTitle}
          faviconUrl={faviconUrl}
          onNavigate={(target) => {
            setInputUrl(target);
            void window.desktopBridge?.preview.navigate(target).then((r) => {
              if (!r.ok) setNavError(formatNavError(r.error));
            });
          }}
        />

        {/* Toolbar: nav | capture | external */}
        <div className="flex min-w-0 items-center">
          {/* Navigation group */}
          <div className="flex items-center gap-0.5">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button type="button" variant="ghost" size="icon-xs" className="shrink-0" disabled={!canBack} onClick={() => void onGoBack()} aria-label="Back">
                    <ArrowLeft size={14} />
                  </Button>
                }
              />
              <TooltipContent side="top" sideOffset={6} className="text-xs">Navigate back</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button type="button" variant="ghost" size="icon-xs" className="shrink-0" disabled={!canFwd} onClick={() => void onGoForward()} aria-label="Forward">
                    <ArrowRight size={14} />
                  </Button>
                }
              />
              <TooltipContent side="top" sideOffset={6} className="text-xs">Navigate forward</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button type="button" variant="ghost" size="icon-xs" className="shrink-0" onClick={() => void onReload()} aria-label="Reload">
                    <RotateCw size={14} />
                  </Button>
                }
              />
              <TooltipContent side="top" sideOffset={6} className="text-xs">Reload page</TooltipContent>
            </Tooltip>
          </div>

          {/* Separator: nav | capture */}
          <div className="mx-1 h-4 w-px bg-border/40" aria-hidden />

          {/* Capture group */}
          <div className="flex items-center gap-0.5">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className={cn("shrink-0", regionBusy && "bg-primary/10 text-primary")}
                    disabled={anyCaptureActive || !threadId}
                    onClick={() => void onAddRegionPictureReference()}
                    aria-label="Crop region"
                  >
                    {regionBusy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Crop size={14} aria-hidden />}
                  </Button>
                }
              />
              <TooltipContent side="top" sideOffset={6} className="max-w-[18rem] text-xs">
                Drag to select a region and attach as PNG
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className={cn("shrink-0", elementPickBusy && "bg-primary/10 text-primary")}
                    disabled={anyCaptureActive || !threadId}
                    onClick={() => void onAddElementPickPictureReference()}
                    aria-label="Pick element"
                  >
                    {elementPickBusy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Crosshair size={14} aria-hidden />}
                  </Button>
                }
              />
              <TooltipContent side="top" sideOffset={6} className="max-w-[19rem] text-xs">
                Hover to highlight, click to attach element crop and context
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className={cn("shrink-0", captureBusy && "bg-primary/10 text-primary")}
                    disabled={anyCaptureActive || !threadId}
                    onClick={() => void onAddPictureReference()}
                    aria-label="Capture viewport"
                  >
                    {captureBusy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <ImagePlus size={14} aria-hidden />}
                  </Button>
                }
              />
              <TooltipContent side="top" sideOffset={6} className="max-w-[16rem] text-xs">
                Capture full viewport as PNG
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className={cn("shrink-0", contextBusy && "bg-primary/10 text-primary")}
                    disabled={anyCaptureActive || !threadId}
                    onClick={() => void onAddPageContextOnly()}
                    aria-label="Attach page context"
                  >
                    {contextBusy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <FileText size={14} aria-hidden />}
                  </Button>
                }
              />
              <TooltipContent side="top" sideOffset={6} className="max-w-[17rem] text-xs">
                Attach page text, headings, and diagnostics (no image)
              </TooltipContent>
            </Tooltip>
          </div>

          {/* Separator: capture | external */}
          <div className="mx-1 h-4 w-px bg-border/40" aria-hidden />

          {/* External group */}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button type="button" variant="ghost" size="icon-xs" className="shrink-0" onClick={() => void onOpenExternal()} aria-label="Open in system browser">
                  <ExternalLink size={14} aria-hidden />
                </Button>
              }
            />
            <TooltipContent side="top" sideOffset={6} className="text-xs">
              Open in system browser
            </TooltipContent>
          </Tooltip>

          {/* Cancel capture pill (visible during region/element-pick capture) */}
          {(regionBusy || elementPickBusy) ? (
            <>
              <div className="flex-1" />
              <button
                type="button"
                className="flex shrink-0 items-center gap-1 rounded border border-destructive/20 bg-destructive/10 px-2 py-0.5 text-[11px] text-destructive/80 transition-colors hover:bg-destructive/15"
                onClick={() => void window.desktopBridge?.preview.cancelCapture()}
              >
                <kbd className="rounded border border-destructive/15 bg-destructive/5 px-1 py-px text-[10px] font-medium">
                  Esc
                </kbd>
                Cancel
              </button>
            </>
          ) : null}
        </div>

        {navError ? (
          <p className="text-xs text-destructive" role="status">
            {navError}
          </p>
        ) : null}
      </form>

      {/* BrowserView placeholder / empty state */}
      <div
        ref={surfaceRef}
        className="relative mx-2 mb-2 mt-1 min-h-[min(40vh,20rem)] min-w-0 flex-1 rounded-md border border-dashed border-border/50 bg-muted/10"
        aria-hidden
      >
        {/* Loading: thin indeterminate progress bar at top of content area */}
        {previewLoading ? (
          <div
            data-testid="preview-loading-banner"
            className="absolute inset-x-0 top-0 z-10 h-0.5 overflow-hidden rounded-t-md"
            role="status"
            aria-live="polite"
            aria-label="Page loading"
          >
            <div className="h-full w-1/3 animate-preview-loading rounded-full bg-primary/80" />
          </div>
        ) : null}
        {!hasLoadedPage && !previewLoading ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
            <Globe className="size-7 text-muted-foreground/15" aria-hidden />
            <span className="font-mono text-[10px] tracking-[0.16em] uppercase text-muted-foreground/40">
              enter a url to preview
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
