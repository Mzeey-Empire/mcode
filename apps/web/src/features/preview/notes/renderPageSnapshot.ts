import type { BrowserPreviewBounds } from "@mcode/contracts";
import type { PreviewCleanCapture } from "../state/previewAnnotationStore";

/** A note to mark on a page snapshot. Bounds are document pixels. */
export interface PageSnapshotMarker {
  readonly displayNumber: number;
  readonly bounds: BrowserPreviewBounds;
}

const MARKER_RADIUS_CSS_PX = 10;
const OUTLINE_WIDTH_CSS_PX = 2;

interface MarkerPalette {
  readonly fill: string;
  readonly ink: string;
}

function readMarkerPalette(): MarkerPalette {
  const style = getComputedStyle(document.documentElement);
  return { fill: style.getPropertyValue("--primary").trim(), ink: style.getPropertyValue("--primary-ink").trim() };
}

/** Where a marker lands in snapshot pixels, or null when its box is wholly outside the screenshot. */
export function markerRect(
  marker: PageSnapshotMarker,
  scroll: PreviewCleanCapture["scroll"],
  scale: number,
  imageSize: { readonly width: number; readonly height: number },
): { x: number; y: number; width: number; height: number } | null {
  const x = (marker.bounds.x - scroll.x) * scale;
  const y = (marker.bounds.y - scroll.y) * scale;
  const width = marker.bounds.width * scale;
  const height = marker.bounds.height * scale;
  const outside = x + width < 0 || y + height < 0 || x > imageSize.width || y > imageSize.height;
  return outside ? null : { x, y, width, height };
}

/**
 * Redraws a page's numbered markers over its clean screenshot. Runs in the renderer so a removed
 * note's number leaves the image without another trip to the page.
 */
export async function renderPageSnapshot(
  clean: PreviewCleanCapture,
  markers: readonly PageSnapshotMarker[],
): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(new Blob([clean.bytes.slice()], { type: "image/png" }));
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("2d canvas is unavailable");
    context.drawImage(bitmap, 0, 0);
    const palette = readMarkerPalette();
    const viewportWidth = clean.capture.bounds.width;
    const scale = viewportWidth > 0 ? bitmap.width / viewportWidth : 1;
    for (const marker of markers) {
      const rect = markerRect(marker, clean.scroll, scale, bitmap);
      if (rect) drawMarker(context, marker.displayNumber, rect, scale, palette);
    }
    const blob = await canvas.convertToBlob({ type: "image/png" });
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    bitmap.close();
  }
}

function drawMarker(
  context: OffscreenCanvasRenderingContext2D,
  displayNumber: number,
  rect: { x: number; y: number; width: number; height: number },
  scale: number,
  palette: MarkerPalette,
): void {
  const radius = MARKER_RADIUS_CSS_PX * scale;
  context.lineWidth = OUTLINE_WIDTH_CSS_PX * scale;
  context.strokeStyle = palette.fill;
  context.strokeRect(rect.x, rect.y, rect.width, rect.height);
  context.beginPath();
  context.arc(rect.x, rect.y, radius, 0, Math.PI * 2);
  context.fillStyle = palette.fill;
  context.fill();
  context.fillStyle = palette.ink;
  context.font = `700 ${radius * 1.1}px sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(String(displayNumber), rect.x, rect.y + scale * 0.5);
}
