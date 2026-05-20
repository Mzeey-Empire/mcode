import { useEffect, useRef } from "react";

/**
 * Renderer-hosted Electron `<webview>` that the host process can adopt by
 * `webContentsId`. Mirrors dpcode's renderer-attach flow: the renderer owns
 * the element lifetime; the host owns the WebContents lifecycle (debugger
 * attach, CDP routing) once the id is registered.
 *
 * Phase D scope: provide the adopt path so the Codex browser-use bridge can
 * drive a renderer-embedded tab via executeCdp. The component is opt-in -
 * tabs that don't request a webview keep the BrowserView path unchanged.
 */
export interface PreviewWebviewProps {
  readonly threadId: string;
  readonly tabId: string;
  readonly src: string;
  readonly className?: string;
}

/** Subset of Electron's WebviewTag API we actually call. */
interface ElectronWebviewElement {
  src: string;
  getWebContentsId(): number;
  addEventListener(type: string, listener: (ev: Event) => void): void;
  removeEventListener(type: string, listener: (ev: Event) => void): void;
}

export function PreviewWebview({ threadId, tabId, src, className }: PreviewWebviewProps) {
  const ref = useRef<ElectronWebviewElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!window.desktopBridge?.preview?.adoptWebview) return;

    let cancelled = false;
    const onAttached = (_ev: Event) => {
      if (cancelled) return;
      try {
        const wcId = el.getWebContentsId();
        if (Number.isFinite(wcId) && wcId > 0) {
          void window.desktopBridge!.preview!.adoptWebview!({
            webContentsId: wcId,
            threadId,
            tabId,
          });
        }
      } catch {
        /* webview not yet ready */
      }
    };
    el.addEventListener("did-attach", onAttached);
    return () => {
      cancelled = true;
      try {
        el.removeEventListener("did-attach", onAttached);
      } catch {
        /* webview gone */
      }
      void window.desktopBridge?.preview?.releaseWebview?.({ threadId, tabId });
    };
  }, [threadId, tabId]);

  // Use createElement via React JSX since <webview> is a custom Chromium
  // element; React 19 will pass unknown attributes through unchanged.
  // We cast to any here only because @types/react does not know about <webview>.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Tag = "webview" as any;
  return (
    <Tag
      ref={ref}
      src={src}
      data-testid="preview-webview"
      data-thread-id={threadId}
      data-tab-id={tabId}
      partition="persist:mcode-preview"
      className={className}
    />
  );
}
