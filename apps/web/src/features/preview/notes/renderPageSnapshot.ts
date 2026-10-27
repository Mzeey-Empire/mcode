import type { BrowserPreviewBounds } from "@mcode/contracts/models/browser-preview";
import type { PreviewCleanCapture } from "../state/previewAnnotationStore";
import { ANNOTATION_MARKER_TAIL_TIP } from "@/components/ui/annotation-marker";

/** A note to mark on a page snapshot. Bounds are document pixels. */
export interface PageSnapshotMarker {
  readonly displayNumber: number;
  readonly bounds: BrowserPreviewBounds;
}

const MARKER_SIZE_CSS_PX = 24;
const MARKER_VIEWBOX = 24;
const MARKER_STROKE_VIEWBOX = 2;
// Copied from lucide-react 0.577.0's MessageCircle to avoid an internal deep import; the snapshot
// and live marker must use the same geometry.
const MARKER_BUBBLE_PATH =
  "M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719";
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
  const size = MARKER_SIZE_CSS_PX * scale;
  context.lineWidth = OUTLINE_WIDTH_CSS_PX * scale;
  context.strokeStyle = palette.fill;
  context.strokeRect(rect.x, rect.y, rect.width, rect.height);
  const left = rect.x - ANNOTATION_MARKER_TAIL_TIP.x * size;
  const top = rect.y - ANNOTATION_MARKER_TAIL_TIP.y * size;
  context.save();
  context.translate(left, top);
  context.scale(size / MARKER_VIEWBOX, size / MARKER_VIEWBOX);
  const bubble = new Path2D(MARKER_BUBBLE_PATH);
  context.fillStyle = palette.fill;
  context.fill(bubble);
  context.lineWidth = MARKER_STROKE_VIEWBOX;
  context.lineJoin = "round";
  context.stroke(bubble);
  context.restore();
  context.fillStyle = palette.ink;
  context.font = `700 ${size * 0.5}px sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(String(displayNumber), left + size / 2, top + size / 2 + scale * 0.5);
}
