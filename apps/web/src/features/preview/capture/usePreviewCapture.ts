import { useCallback, useEffect, useRef, useState } from "react";
import { useToastStore } from "@/stores/toastStore";
import { usePreviewReferenceQueueStore } from "../state/previewReferenceQueueStore";
import type { McodeBrowserCaptureV2 } from "@mcode/contracts";
import type { PreviewPictureReferenceResult } from "@/transport/desktop-bridge";
import type { PendingAttachment } from "@/components/chat/AttachmentPreview";
import { usePreviewAnnotationStore, type PreviewCleanCapture } from "../state/previewAnnotationStore";
import { normalizePreviewPageIdentity } from "@mcode/shared/browser-page-identity";

type CaptureResult = PreviewPictureReferenceResult;

type CapturedPicture = Extract<CaptureResult, { ok: true }>;

function toCleanCapture(res: CaptureResult): PreviewCleanCapture | null {
  if (!res.ok || res.capture.schemaVersion !== 2) return null;
  const { scrollX = 0, scrollY = 0 } = res.capture.viewportScroll ?? {};
  return { bytes: res.previewBytes, capture: res.capture, scroll: { x: scrollX, y: scrollY } };
}

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

function showCaptureErrorIfNeeded(res: CaptureResult): void {
  if (res.ok || CAPTURE_ERROR_SILENT.has(res.error)) return;
  useToastStore.getState().show({
    kind: "failed",
    title: "Could not capture preview",
    meta: formatCaptureError(res.error),
  });
}

function enqueueCapturedPicture(threadId: string, res: CapturedPicture): void {
  const copied = Uint8Array.from(res.previewBytes);
  const blob = new Blob([copied], { type: "image/png" });
  const attachment: PendingAttachment = {
    id: res.meta.id,
    name: res.meta.name,
    mimeType: res.meta.mimeType,
    sizeBytes: res.meta.sizeBytes,
    previewUrl: URL.createObjectURL(blob),
    filePath: res.meta.sourcePath,
    browserCapture: res.capture,
  };
  usePreviewReferenceQueueStore.getState().enqueuePreviewReference(threadId, attachment);
}

function showScreenshotFailed(): void {
  useToastStore.getState().show({
    kind: "failed",
    title: "Could not capture preview",
    meta: "Screenshot failed.",
  });
}

/** Discriminator for the source of a successful capture. */
export type PreviewCaptureKind = "viewport" | "region" | "element";

/** Options for the {@link usePreviewCapture} hook. */
export interface UsePreviewCaptureOptions {
  /** Thread id that owns this capture session. */
  readonly threadId: string;
  /** Browser tab the Screenshot overlay targets. Changing it cancels an open Screenshot. */
  readonly activeTabId: string;
  /** False while the preview is hidden. Turning false cancels an open Screenshot. */
  readonly presentationActive: boolean;
  /** Callback to push bounds sync before capturing. */
  readonly pushSync: (visible: boolean) => Promise<void>;
  /**
   * Fires after every successful attachment so the host can surface an inline
   * confirmation. The composer chip already exists but may be off-screen at
   * narrow widths; this callback lets the preview surface acknowledge the
   * action where the user is actually looking.
   */
  readonly onSuccess?: (kind: PreviewCaptureKind) => void;
}

/** State and callbacks returned by {@link usePreviewCapture}. */
export interface PreviewCaptureState {
  /** True from the Screenshot press until it captures, cancels, or is invalidated. */
  readonly screenshotArmed: boolean;
  /** True while an element-pick capture is in progress. */
  readonly elementPickBusy: boolean;
  /** True when any capture mode is active (disables other capture buttons). */
  readonly anyCaptureActive: boolean;
  /**
   * Arms the Screenshot overlay, or cancels it when already armed. In the
   * overlay a click attaches the viewport and a drag attaches the region.
   */
  readonly onToggleScreenshot: () => Promise<void>;
  /**
   * Fires one element-pick session and resolves with whether the session
   * actually attached an element. Design mode reads this so it can re-arm on
   * success and exit on cancel / error / Esc without inspecting the queue.
   */
  readonly onAddElementPickPictureReference: () => Promise<{ ok: boolean }>;
  /** Create a saved Preview annotation from an element pick instead of a normal attachment. */
  readonly onAddElementAnnotation: () => Promise<{ ok: boolean }>;
  /** Capture the full visible viewport, unmarked, for a page's notes to be drawn on. */
  readonly captureCleanPage: () => Promise<PreviewCleanCapture | null>;
}

interface ScreenshotRequest {
  readonly id: number;
  readonly target: { readonly threadId: string; readonly tabId: string };
  phase: "syncing" | "armed";
}

/** Screenshot and element-pick capture state and callbacks. */
export function usePreviewCapture({
  threadId,
  activeTabId,
  presentationActive,
  pushSync,
  onSuccess,
}: UsePreviewCaptureOptions): PreviewCaptureState {
  const [screenshotArmed, setScreenshotArmed] = useState(false);
  const [elementPickBusy, setElementPickBusy] = useState(false);
  // React state updates are batched; the ref makes request ownership immediate.
  const screenshotRequestRef = useRef<ScreenshotRequest | null>(null);
  const nextScreenshotIdRef = useRef(0);

  const anyCaptureActive = screenshotArmed || elementPickBusy;

  const settleScreenshot = useCallback((request: ScreenshotRequest): boolean => {
    if (screenshotRequestRef.current !== request) return false;
    screenshotRequestRef.current = null;
    setScreenshotArmed(false);
    return true;
  }, []);

  const cancelScreenshot = useCallback((): void => {
    const request = screenshotRequestRef.current;
    if (!request) return;
    settleScreenshot(request);
    if (request.phase === "armed") void window.desktopBridge?.preview?.cancelCapture();
  }, [settleScreenshot]);

  const runScreenshot = useCallback(async (
    request: ScreenshotRequest,
    capture: () => Promise<CaptureResult>,
  ): Promise<CaptureResult | null> => {
    try {
      await pushSync(true);
      if (screenshotRequestRef.current !== request) return null;
      request.phase = "armed";
      return await capture();
    } catch {
      if (settleScreenshot(request)) showScreenshotFailed();
      return null;
    }
  }, [pushSync, settleScreenshot]);

  const deliverScreenshot = useCallback((request: ScreenshotRequest, res: CaptureResult): void => {
    if (!settleScreenshot(request)) return;
    showCaptureErrorIfNeeded(res);
    if (!res.ok) return;
    enqueueCapturedPicture(request.target.threadId, res);
    onSuccess?.(res.capture.captureKind ?? "viewport");
  }, [onSuccess, settleScreenshot]);

  const onToggleScreenshot = useCallback(async (): Promise<void> => {
    if (screenshotRequestRef.current) {
      cancelScreenshot();
      return;
    }
    const preview = window.desktopBridge?.preview;
    if (!preview?.capturePictureReference || !threadId || !presentationActive) return;

    nextScreenshotIdRef.current += 1;
    const request: ScreenshotRequest = {
      id: nextScreenshotIdRef.current,
      target: { threadId, tabId: activeTabId },
      phase: "syncing",
    };
    screenshotRequestRef.current = request;
    setScreenshotArmed(true);

    const res = await runScreenshot(request, () => preview.capturePictureReference());
    if (res) deliverScreenshot(request, res);
  }, [activeTabId, cancelScreenshot, deliverScreenshot, presentationActive, runScreenshot, threadId]);

  useEffect(() => {
    if (!screenshotArmed) return;
    // Capture phase so Esc cancels the Screenshot before the preview's own Esc handlers run.
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      cancelScreenshot();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [cancelScreenshot, screenshotArmed]);

  useEffect(() => {
    return () => cancelScreenshot();
  }, [activeTabId, cancelScreenshot, presentationActive, threadId]);

  const onAddElementPickPictureReference = useCallback(async (): Promise<{ ok: boolean }> => {
    const preview = window.desktopBridge?.preview;
    if (!preview?.capturePictureReferenceElementPick || !threadId) return { ok: false };

    setElementPickBusy(true);
    try {
      await pushSync(true);

      let res: CaptureResult;
      try {
        res = await preview.capturePictureReferenceElementPick();
      } catch {
        showScreenshotFailed();
        return { ok: false };
      }

      showCaptureErrorIfNeeded(res);
      if (!res.ok) return { ok: false };

      enqueueCapturedPicture(threadId, res);
      onSuccess?.("element");
      return { ok: true };
    } finally {
      setElementPickBusy(false);
    }
  }, [pushSync, threadId, onSuccess]);

  const captureCleanPage = useCallback(async (): Promise<PreviewCleanCapture | null> => {
    const preview = window.desktopBridge?.preview;
    if (!preview?.captureAnnotationSnapshot || !threadId) return null;
    await pushSync(true);
    let res: CaptureResult;
    try {
      res = await preview.captureAnnotationSnapshot();
    } catch {
      useToastStore.getState().show({
        kind: "failed",
        title: "Could not save annotation",
        meta: "Screenshot failed.",
      });
      return null;
    }
    showCaptureErrorIfNeeded(res);
    return toCleanCapture(res);
  }, [pushSync, threadId]);

  const captureElementPick = useCallback(async (): Promise<CaptureResult | null> => {
    const preview = window.desktopBridge?.preview;
    if (!preview?.capturePictureReferenceElementPick || !threadId) return null;
    try {
      return await preview.capturePictureReferenceElementPick();
    } catch {
      showScreenshotFailed();
      return null;
    }
  }, [threadId]);

  const saveElementAnnotation = useCallback((capture: McodeBrowserCaptureV2): void => {
    usePreviewAnnotationStore.getState().setDraft(threadId, {
      threadId,
      pageIdentity: normalizePreviewPageIdentity(capture.pageUrl),
      bounds: capture.bounds,
      selectorHint: capture.selectorHint ?? null,
      label: capture.selectorHint ?? null,
      pageContext: capture,
      note: "",
    });
  }, [threadId]);

  const onAddElementAnnotation = useCallback(async (): Promise<{ ok: boolean }> => {
    setElementPickBusy(true);
    try {
      await pushSync(true);
      const res = await captureElementPick();
      if (!res) return { ok: false };
      showCaptureErrorIfNeeded(res);
      if (!res.ok || res.capture.schemaVersion !== 2) return { ok: false };
      saveElementAnnotation(res.capture);
      onSuccess?.("element");
      return { ok: true };
    } finally {
      setElementPickBusy(false);
    }
  }, [captureElementPick, pushSync, saveElementAnnotation, onSuccess]);

  return {
    screenshotArmed,
    elementPickBusy,
    anyCaptureActive,
    onToggleScreenshot,
    onAddElementPickPictureReference,
    onAddElementAnnotation,
    captureCleanPage,
  };
}
