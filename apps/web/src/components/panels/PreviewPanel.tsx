import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
  /** Active workspace checkout root; enables large preview text spill files under `.mcode-local/`. */
  readonly workspaceRootPath?: string | null;
}

/**
 * Embedded site preview: omnibox and toolbar above a region aligned to an Electron BrowserView.
 * A loading banner sits between the form and guest region because the BrowserView stacks above HTML and would hide in-surface overlays. Full viewport, drag-selected region, element-pick PNGs, or fence-only page context attach to the composer. The chrome uses a
 * two-row header so the omnibox keeps usable width on narrow panels. Tooltips open upward so they stay
 * readable: the guest BrowserView is stacked above shell HTML and would hide downward popups.
 * In web-only builds without `desktopBridge.preview`, renders an explanatory empty state.
 */
export function PreviewPanel({ threadId, workspaceRootPath }: PreviewPanelProps) {
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
          workspaceRootPath: workspaceRootPath ?? null,
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
        workspaceRootPath: workspaceRootPath ?? null,
      });
    },
    [threadId, storedUrl, workspaceRootPath],
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
      }
      void refreshNav();
    });
    return unsub;
  }, [threadId, refreshNav]);

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

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const preview = window.desktopBridge?.preview;
    if (!preview) return;
    setNavError(null);
    await pushSync(true);
    const res = await preview.navigate(inputUrl);
    if (!res.ok) {
      setNavError(formatNavError(res.error));
    }
    await refreshNav();
  };

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

  return (
    <div
      data-testid="preview-panel"
      className="flex min-h-0 min-w-[20rem] flex-1 flex-col"
    >
      <form
        onSubmit={(e) => void onSubmit(e)}
        className="flex-none space-y-2 border-b border-border/40 p-2"
      >
        <div className="flex min-w-0 flex-wrap items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="shrink-0"
            disabled={!canBack}
            onClick={() => void onGoBack()}
            aria-label="Back"
          >
            <ArrowLeft size={14} />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="shrink-0"
            disabled={!canFwd}
            onClick={() => void onGoForward()}
            aria-label="Forward"
          >
            <ArrowRight size={14} />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="shrink-0"
            onClick={() => void onReload()}
            aria-label="Reload"
          >
            <RotateCw size={14} />
          </Button>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="shrink-0"
                  disabled={regionBusy || captureBusy || elementPickBusy || contextBusy || !threadId}
                  onClick={() => void onAddRegionPictureReference()}
                  aria-label="Select region to capture"
                >
                  <Crop size={14} aria-hidden />
                </Button>
              }
            />
            <TooltipContent side="top" sideOffset={6} className="max-w-[18rem] text-xs">
              Drag on the page to choose a rectangle, then release to attach that crop
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="shrink-0"
                  disabled={elementPickBusy || regionBusy || captureBusy || contextBusy || !threadId}
                  onClick={() => void onAddElementPickPictureReference()}
                  aria-label="Pick element to capture"
                >
                  <Crosshair size={14} aria-hidden />
                </Button>
              }
            />
            <TooltipContent side="top" sideOffset={6} className="max-w-[19rem] text-xs">
              Hover to highlight an element, then click to attach a crop plus selector and HTML excerpt
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="shrink-0"
                  disabled={captureBusy || regionBusy || elementPickBusy || contextBusy || !threadId}
                  onClick={() => void onAddPictureReference()}
                  aria-label="Add visible preview as image attachment"
                >
                  <ImagePlus size={14} aria-hidden />
                </Button>
              }
            />
            <TooltipContent side="top" sideOffset={6} className="max-w-[16rem] text-xs">
              Capture the full preview viewport as a PNG and attach it to the composer
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="shrink-0"
                  disabled={contextBusy || captureBusy || regionBusy || elementPickBusy || !threadId}
                  onClick={() => void onAddPageContextOnly()}
                  aria-label="Add page context without screenshot"
                >
                  <FileText size={14} aria-hidden />
                </Button>
              }
            />
            <TooltipContent side="top" sideOffset={6} className="max-w-[17rem] text-xs">
              Attach URL, visible text, headings, and diagnostics as structured context (no PNG)
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="shrink-0"
                  onClick={() => void onOpenExternal()}
                  aria-label="Open in system browser"
                >
                  <ExternalLink size={14} aria-hidden />
                </Button>
              }
            />
            <TooltipContent side="top" sideOffset={6} className="max-w-[14rem] text-xs">
              Open this URL in your default browser
            </TooltipContent>
          </Tooltip>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-1.5 sm:flex-nowrap">
          <Input
            value={inputUrl}
            onChange={(e) => setInputUrl(e.target.value)}
            placeholder="https://example.com"
            className="h-8 min-w-[12rem] flex-1 font-mono text-xs sm:min-w-[16rem]"
            aria-label="Preview URL"
            title={inputUrl.trim() ? inputUrl : undefined}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
          <Button type="submit" size="sm" className="h-8 shrink-0 text-xs">
            Go
          </Button>
        </div>
        {navError ? (
          <p className="text-xs text-destructive" role="status">
            {navError}
          </p>
        ) : null}
      </form>
      {previewLoading ? (
        <div
          data-testid="preview-loading-banner"
          className="mx-2 mt-1 flex min-h-9 items-center gap-2 rounded-md border border-border/40 bg-muted/50 px-3 py-2 text-xs text-muted-foreground"
          role="status"
          aria-live="polite"
        >
          <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" aria-hidden />
          <span>Loading page…</span>
        </div>
      ) : null}
      <div
        ref={surfaceRef}
        className="mx-2 mb-2 mt-1 min-h-[min(40vh,20rem)] min-w-0 flex-1 rounded-md border border-dashed border-border/50 bg-muted/10"
        aria-hidden
      />
    </div>
  );
}
