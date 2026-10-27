import { useState, type CSSProperties } from "react";
import type { FileReadResult } from "@mcode/contracts/models/workspace-file";
import { buildServerImageUrl } from "@/lib/server-image-url";
import type { ImageScale } from "./filesTabsStore";

/** An image read result. */
export type ImageReadResult = Extract<FileReadResult, { kind: "image" }>;

/** Intrinsic size of a loaded image, in px. */
export interface ImageDimensions {
  readonly width: number;
  readonly height: number;
}

/** Props for {@link ImageFileView}. */
export interface ImageFileViewProps {
  readonly result: ImageReadResult;
  readonly scale: ImageScale;
  readonly onDimensions: (dimensions: ImageDimensions) => void;
}

// Painted on the <img> itself so the checker shows only through transparent pixels, never around the image.
const CHECKER: CSSProperties = {
  backgroundImage: "repeating-conic-gradient(var(--color-border) 0% 25%, transparent 0% 50%)",
  backgroundSize: "16px 16px",
};

const SCALE_FACTOR: Record<Exclude<ImageScale, "fit">, number> = { "100": 1, "200": 2 };

function imageStyle(scale: ImageScale, natural: ImageDimensions | null): CSSProperties {
  if (scale === "fit") return { ...CHECKER, maxWidth: "100%", maxHeight: "100%", objectFit: "contain" };
  if (!natural) return CHECKER;
  const factor = SCALE_FACTOR[scale];
  return { ...CHECKER, width: natural.width * factor, height: natural.height * factor, maxWidth: "none" };
}

/** An image tab: the picture at Fit, 100% or 200%, scrolling when larger than the body. */
export function ImageFileView({ result, scale, onDimensions }: ImageFileViewProps) {
  const [natural, setNatural] = useState<ImageDimensions | null>(null);
  const [failed, setFailed] = useState(false);
  const src = buildServerImageUrl(result.url);
  if (!src) return <p className="px-4 py-3 font-mono text-code-small text-muted">Loading…</p>;
  if (failed) return <p className="px-4 py-3 text-body-small text-muted">Couldn't load image</p>;
  return (
    <div
      data-testid="image-file-view"
      className={`flex min-h-0 flex-1 bg-background p-4 ${scale === "fit" ? "items-center justify-center overflow-hidden" : "overflow-auto"}`}
    >
      <img
        src={src}
        alt={result.path}
        className={scale === "fit" ? undefined : "m-auto shrink-0"}
        style={imageStyle(scale, natural)}
        onError={() => setFailed(true)}
        onLoad={(event) => {
          const { naturalWidth: width, naturalHeight: height } = event.currentTarget;
          // An SVG without intrinsic size reports 0; leave its size unknown rather than claim 0×0.
          if (width <= 0 || height <= 0) return;
          setNatural({ width, height });
          onDimensions({ width, height });
        }}
      />
    </div>
  );
}
