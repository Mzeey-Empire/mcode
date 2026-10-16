import type { TerminalUrlMatch } from "./terminalLinkProvider";

/**
 * Opens a clicked Terminal URL. Loopback hosts are the user's own dev servers, so
 * they open in the thread's Browser tab; everything else goes to the system browser.
 *
 * The Browser tab code loads on first use. Importing it statically would pull the
 * whole preview module graph into every Terminal consumer.
 *
 * @param link - A URL validated by `findTerminalUrlLinks`.
 * @param threadId - The thread that owns the Browser tab. Without one, loopback links use the system browser.
 */
export async function openTerminalUrl(
  link: Pick<TerminalUrlMatch, "url" | "loopback">,
  threadId: string | undefined,
): Promise<void> {
  if (link.loopback && threadId) {
    const { openUrlInPreview } = await import("@/features/preview");
    openUrlInPreview({ url: link.url, threadId });
    return;
  }
  if (window.desktopBridge?.openExternalUrl) {
    await window.desktopBridge.openExternalUrl(link.url);
    return;
  }
  window.open(link.url, "_blank", "noopener,noreferrer");
}
