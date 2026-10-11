import { getAttachmentTransportWsUrl } from "@/lib/attachment-url";
import { AUTH_TOKEN_STORAGE_KEY } from "@/transport/scan-port-range";

/**
 * Turns a server-relative image path such as `/workspace-images/...` into an
 * absolute URL an `<img>` can load. Desktop and web both reach the local server
 * over HTTP, and the renderer origin differs from it, so the auth token rides
 * in the query instead of relying on a cookie. Returns null before the
 * transport has connected.
 */
export function buildServerImageUrl(relativeUrl: string): string | null {
  const wsUrl = getAttachmentTransportWsUrl();
  if (!wsUrl) return null;
  const transport = new URL(wsUrl);
  const url = new URL(relativeUrl, `${transport.protocol === "wss:" ? "https:" : "http:"}//${transport.host}`);
  const token = transport.searchParams.get("token") || readStoredAuthToken();
  if (token) url.searchParams.set("token", token);
  return url.toString();
}

function readStoredAuthToken(): string | null {
  return typeof localStorage === "undefined" ? null : localStorage.getItem(AUTH_TOKEN_STORAGE_KEY);
}
