import { storedAttachmentSuffix } from "@mcode/contracts";
import { AUTH_TOKEN_STORAGE_KEY } from "@/transport/scan-port-range";

/** Last WebSocket URL used by the transport; drives HTTP attachment URLs in browser builds. */
let transportWsUrl: string | null = null;

/**
 * Stores the active WebSocket URL so {@link buildStoredAttachmentImageSrc} can derive
 * the matching `http(s)` origin for `/attachments/` requests (called from ws `onopen`).
 */
export function setAttachmentTransportWsUrl(wsUrl: string): void {
  transportWsUrl = wsUrl;
}

/**
 * Returns the last URL passed to {@link setAttachmentTransportWsUrl}, if any.
 */
export function getAttachmentTransportWsUrl(): string | null {
  return transportWsUrl;
}

/**
 * Clears the cached transport URL. Lets unit tests reset state between cases.
 */
export function clearAttachmentTransportWsUrlCache(): void {
  transportWsUrl = null;
}

function wsUrlToHttpOrigin(wsUrl: string): string {
  const u = new URL(wsUrl);
  const proto = u.protocol === "wss:" ? "https:" : "http:";
  if (u.port) {
    return `${proto}//${u.hostname}:${u.port}`;
  }
  return `${proto}//${u.hostname}`;
}

/**
 * Builds a URL for loading a persisted attachment image (thumbnail or lightbox).
 * Electron continues to use `mcode-attachment:`; the standalone web app uses the local
 * HTTP server so `<img>` can load bytes without a custom protocol handler.
 */
export function buildStoredAttachmentImageSrc(
  threadId: string,
  id: string,
  mimeType: string,
): string {
  const ext = storedAttachmentSuffix(mimeType);
  const filename = `${id}${ext}`;
  if (typeof window !== "undefined" && window.desktopBridge) {
    return `mcode-attachment://${threadId}/${filename}`;
  }
  const ws = transportWsUrl;
  if (ws) {
    const base = wsUrlToHttpOrigin(ws);
    const token =
      typeof localStorage !== "undefined" ? localStorage.getItem(AUTH_TOKEN_STORAGE_KEY) ?? "" : "";
    const q = token ? `?token=${encodeURIComponent(token)}` : "";
    return `${base}/attachments/${threadId}/${filename}${q}`;
  }
  return `mcode-attachment://${threadId}/${filename}`;
}
