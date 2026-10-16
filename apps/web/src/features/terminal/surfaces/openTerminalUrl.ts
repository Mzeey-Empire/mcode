import { openUrlInPreview } from "@/features/preview";
import type { TerminalUrlMatch } from "./terminalLinkProvider";

/**
 * Opens a clicked Terminal URL. Loopback hosts are the user's own dev servers, so
 * they open in the thread's Browser tab; everything else goes to the system browser.
 *
 * @param link - A URL validated by `findTerminalUrlLinks`.
 * @param threadId - The thread that owns the Browser tab. Without one, loopback links use the system browser.
 */
export function openTerminalUrl(link: Pick<TerminalUrlMatch, "url" | "loopback">, threadId: string | undefined): void {
  if (link.loopback && threadId) {
    openUrlInPreview({ url: link.url, threadId });
    return;
  }
  if (window.desktopBridge?.openExternalUrl) {
    void window.desktopBridge.openExternalUrl(link.url);
    return;
  }
  window.open(link.url, "_blank", "noopener,noreferrer");
}
