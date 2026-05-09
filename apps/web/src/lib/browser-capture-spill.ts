import type { AttachedBrowserCapture } from "@mcode/contracts";

/**
 * Collects `spillRelativePath` values from browser capture rows for cleanup after send or queue drop.
 */
export function collectBrowserCaptureSpillPaths(rows: readonly AttachedBrowserCapture[]): string[] {
  const out: string[] = [];
  for (const row of rows) {
    if (row.schemaVersion === 2 && row.spillRelativePath) {
      out.push(row.spillRelativePath);
    }
  }
  return out;
}

/**
 * Removes spill JSON files written under `.mcode-local/mcode-browser-capture/` (desktop only).
 */
export async function releaseBrowserCaptureSpills(paths: readonly string[]): Promise<void> {
  if (paths.length === 0) return;
  const preview = window.desktopBridge?.preview;
  if (!preview?.releaseBrowserCaptureSpills) return;
  await preview.releaseBrowserCaptureSpills(paths);
}
