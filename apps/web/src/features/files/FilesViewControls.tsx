import { ChevronDown } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { formatFileSize } from "./CodeFileView";
import type { FileViewKind } from "./file-view-kind";
import type { FileViewMode, ImageScale } from "./filesTabsStore";
import type { ImageDimensions } from "./ImageFileView";

const MODE_OPTIONS: readonly { readonly value: FileViewMode; readonly label: string }[] = [
  { value: "rendered", label: "Preview" },
  { value: "source", label: "Source" },
];

const SCALE_LABELS: Record<ImageScale, string> = { fit: "Fit", "100": "100%", "200": "200%" };
const SCALES: readonly ImageScale[] = ["fit", "100", "200"];

/** Props for {@link FilesViewControls}. */
export interface FilesViewControlsProps {
  readonly kind: FileViewKind;
  readonly mode: FileViewMode;
  readonly scale: ImageScale;
  readonly size: number;
  readonly dimensions: ImageDimensions | null;
  readonly onModeChange: (mode: FileViewMode) => void;
  readonly onScaleChange: (scale: ImageScale) => void;
}

/** Row-2 controls for the shown file's view kind; nothing for code files. */
export function FilesViewControls({ kind, mode, scale, size, dimensions, onModeChange, onScaleChange }: FilesViewControlsProps) {
  if (kind === "code") return null;
  const showsImage = kind === "image" || (kind === "svg" && mode === "rendered");
  return (
    <>
      {showsImage ? <ImageChip size={size} dimensions={dimensions} /> : null}
      {showsImage ? <ScalePill scale={scale} onChange={onScaleChange} narrowHidden={kind === "svg"} /> : null}
      {kind === "image" ? null : <ModePill mode={mode} onChange={onModeChange} />}
    </>
  );
}

function ModePill({ mode, onChange }: { readonly mode: FileViewMode; readonly onChange: (mode: FileViewMode) => void }) {
  return (
    <div role="radiogroup" aria-label="View" className="flex shrink-0 items-center rounded-full bg-selected p-0.5">
      {MODE_OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={mode === option.value}
          onClick={() => onChange(option.value)}
          className={`h-7 rounded-full px-2.5 text-body-small font-medium ${mode === option.value ? "bg-border text-ink" : "text-muted hover:text-ink"}`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function ImageChip({ size, dimensions }: { readonly size: number; readonly dimensions: ImageDimensions | null }) {
  const text = dimensions ? `${dimensions.width}×${dimensions.height} · ${formatFileSize(size)}` : formatFileSize(size);
  return (
    // The panel's default width has no room for the chip beside the path pill and the other controls.
    <span data-testid="files-image-chip" className="hidden h-8 shrink-0 items-center rounded-full bg-selected px-3 font-mono text-code-small text-muted @[440px]:flex">
      {text}
    </span>
  );
}

/** `narrowHidden` drops the pill below the row width the SVG's Preview/Source pill also needs. */
function ScalePill({
  scale,
  onChange,
  narrowHidden,
}: {
  readonly scale: ImageScale;
  readonly onChange: (scale: ImageScale) => void;
  readonly narrowHidden: boolean;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button type="button" aria-label={`Scale ${SCALE_LABELS[scale]}`} className={`h-8 shrink-0 items-center gap-1 rounded-full bg-selected px-3 text-body-small text-ink ${narrowHidden ? "hidden @[440px]:flex" : "flex"}`}>
            {SCALE_LABELS[scale]}
            <ChevronDown aria-hidden size={14} className="text-muted" />
          </button>
        }
      />
      <DropdownMenuContent align="end" sideOffset={6}>
        {SCALES.map((option) => (
          <DropdownMenuItem key={option} label={SCALE_LABELS[option]} onClick={() => onChange(option)} />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
