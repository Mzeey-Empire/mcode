import { useState, type KeyboardEvent, type ReactNode } from "react";
import {
  ChevronDown,
  Laptop,
  Monitor,
  RectangleHorizontal,
  RotateCwSquare,
  Smartphone,
  Tablet,
  X,
} from "lucide-react";
import { PanelHeaderSlot, usePanelHeaderMenuOpen } from "@/components/panels/shell/PanelHeader";
import { Button, IconButton } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { getKeybindingForCommand, keybindingKeycaps } from "@/lib/keybinding-manager";
import { isMac } from "@/lib/platform";
import { cn } from "@/lib/utils";
import {
  clampViewportSize,
  VIEWPORT_PRESETS,
  ViewportCoordinator,
  type ViewportCoordinatorState,
  type ViewportPresentation,
  type ViewportPreset,
  type ViewportSize,
} from "../automation/services/viewportCoordinator";
import { useViewportDragStore, type ViewportDragEdge } from "../state/viewportDragStore";

const VIEWPORT_ZOOM_PRESETS = ["50%", "75%", "100%", "125%", "150%", "200%"] as const;

/** Presets before this one are handheld devices; the rest are laptop sizes. */
const FIRST_LAPTOP_PRESET_ID = "laptop";

const PRESET_ICONS: Record<string, typeof Smartphone> = {
  "iphone-15-pro": Smartphone,
  "pixel-8": Smartphone,
  "ipad-air": Tablet,
  "surface-pro-7": Tablet,
  laptop: Laptop,
  desktop: Monitor,
};

const FIRST_LAPTOP_INDEX = VIEWPORT_PRESETS.findIndex((preset) => preset.id === FIRST_LAPTOP_PRESET_ID);
const HANDHELD_PRESETS = VIEWPORT_PRESETS.slice(0, FIRST_LAPTOP_INDEX);
const LAPTOP_PRESETS = VIEWPORT_PRESETS.slice(FIRST_LAPTOP_INDEX);

/** Props for the Browser's device row. */
export interface BrowserDeviceRowProps {
  readonly coordinator: ViewportCoordinator;
  readonly state: ViewportCoordinatorState;
  readonly onClose: () => void;
  readonly onUserViewportChange?: () => void;
  /** Fitted scale the page is drawn at. */
  readonly scale?: number;
}

function parseDimension(value: string): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function sameSize(left: ViewportSize, right: ViewportSize): boolean {
  return left.width === right.width && left.height === right.height;
}

function PresetIcon({ preset }: { readonly preset: ViewportPreset | undefined }) {
  if (!preset) {
    return <RectangleHorizontal className="size-3.5 text-muted [stroke-dasharray:3_2]" aria-hidden />;
  }
  const Icon = PRESET_ICONS[preset.id] ?? Smartphone;
  return <Icon className="size-3.5 text-muted" aria-hidden />;
}

function presetSize(preset: ViewportPreset): string {
  return `${preset.width} × ${preset.height}`;
}

interface DevicePickerProps {
  readonly open: boolean;
  readonly selected: ViewportPreset | undefined;
  readonly onOpenChange: (open: boolean) => void;
  readonly onResponsive: () => void;
  readonly onPreset: (preset: ViewportPreset) => void;
}

interface DevicePresetItemProps {
  readonly preset: ViewportPreset;
  readonly selected: boolean;
  readonly onPreset: (preset: ViewportPreset) => void;
}

function DevicePresetItem({ preset, selected, onPreset }: DevicePresetItemProps) {
  return (
    <DropdownMenuItem
      label={preset.label}
      checked={selected}
      trailing={<span className="font-mono text-caption text-muted">{presetSize(preset)}</span>}
      onClick={() => onPreset(preset)}
    />
  );
}

function DevicePicker({ open, selected, onOpenChange, onResponsive, onPreset }: DevicePickerProps) {
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="subtle"
            className="h-8 shrink-0 gap-2 rounded-control px-2.5 text-label font-medium text-ink"
            aria-label="Viewport preset"
          >
            <PresetIcon preset={selected} />
            <span className="text-fade @max-[420px]:hidden">{selected?.label ?? "Responsive"}</span>
            <ChevronDown className="size-3 text-muted" aria-hidden />
          </Button>
        }
      />
      <DropdownMenuContent align="start" className="min-w-[24rem]">
        <DropdownMenuItem label="Responsive" checked={!selected} onClick={onResponsive} />
        <DropdownMenuSeparator />
        {HANDHELD_PRESETS.map((preset) => (
          <DevicePresetItem key={preset.id} preset={preset} selected={selected?.id === preset.id} onPreset={onPreset} />
        ))}
        <DropdownMenuSeparator />
        {LAPTOP_PRESETS.map((preset) => (
          <DevicePresetItem key={preset.id} preset={preset} selected={selected?.id === preset.id} onPreset={onPreset} />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface SizeFieldProps {
  readonly label: string;
  readonly value: string;
  readonly dragging: boolean;
  readonly onChange: (value: string) => void;
  readonly onSubmit: () => void;
}

function SizeField({ label, value, dragging, onChange, onSubmit }: SizeFieldProps) {
  const submitOnEnter = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") onSubmit();
  };
  return (
    <input
      inputMode="numeric"
      aria-label={label}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={submitOnEnter}
      data-dragging={dragging ? "" : undefined}
      className={cn(
        "h-7 w-13 shrink-0 rounded-md bg-selected @max-[420px]:w-10 text-center font-mono text-caption text-ink outline-none",
        "focus-visible:shadow-[inset_0_0_0_1px_var(--color-focus)]",
        dragging && "shadow-[inset_0_0_0_1px_var(--color-primary)]",
      )}
    />
  );
}

interface ScaleMenuProps {
  readonly open: boolean;
  readonly percent: number;
  readonly presentation: ViewportPresentation;
  readonly onOpenChange: (open: boolean) => void;
  readonly onPresentation: (presentation: ViewportPresentation) => void;
}

function presentationName(presentation: ViewportPresentation): string {
  if (presentation === "fit") return "Fit";
  return presentation === "actual" ? "Actual" : "Zoom";
}

function ScaleMenu({ open, percent, presentation, onOpenChange, onPresentation }: ScaleMenuProps) {
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="subtle"
            className="h-8 shrink-0 gap-1.5 rounded-full pr-2.5 pl-3 text-label font-medium text-ink"
            aria-label="Viewport scale and presentation"
          >
            {presentationName(presentation)}
            <span className="font-mono text-caption font-normal text-muted">{percent}%</span>
            <ChevronDown className="size-3 text-muted" aria-hidden />
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="min-w-[16rem]">
        <DropdownMenuItem label="Fit to panel" checked={presentation === "fit"} onClick={() => onPresentation("fit")} />
        <DropdownMenuItem label="Actual size" checked={presentation === "actual"} onClick={() => onPresentation("actual")} />
        <DropdownMenuSeparator />
        {VIEWPORT_ZOOM_PRESETS.map((zoom) => (
          <DropdownMenuItem key={zoom} label={zoom} checked={presentation === zoom} onClick={() => onPresentation(zoom)} />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function useDeviceRowSizing(
  coordinator: ViewportCoordinator,
  state: ViewportCoordinatorState,
  onUserViewportChange: (() => void) | undefined,
) {
  const requested = state.pending?.requested ?? state.confirmed;
  const [draft, setDraft] = useState(() => ({ requested, width: String(requested.width), height: String(requested.height) }));
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null);
  const fromRequested = { requested, width: String(requested.width), height: String(requested.height) };
  // A drag or preset moves `requested` away from the draft, so the fields show the live size.
  const dimensions = sameSize(draft.requested, requested) ? draft : fromRequested;

  const submitSize = (size: ViewportSize, presetId: string | null = null): void => {
    setSelectedPresetId(presetId);
    onUserViewportChange?.();
    coordinator.setUserMode("responsive");
    void coordinator.requestUserResize(clampViewportSize(size));
  };
  const submitDraft = (): void => {
    const width = parseDimension(dimensions.width);
    const height = parseDimension(dimensions.height);
    if (width === null || height === null) {
      setDraft(fromRequested);
      return;
    }
    submitSize({ width, height });
  };
  const editDraft = (edit: Partial<Pick<typeof draft, "width" | "height">>): void => {
    setDraft((current) => ({ ...(sameSize(current.requested, requested) ? current : fromRequested), ...edit }));
  };
  const selectedPreset = state.mode === "responsive"
    ? VIEWPORT_PRESETS.find((preset) => preset.id === selectedPresetId && sameSize(preset, requested))
    : undefined;

  return { requested, dimensions, selectedPreset, submitSize, submitDraft, editDraft, clearPreset: () => setSelectedPresetId(null) };
}

// The panel can shrink to 384px, where the full-width controls overflow, so the row compacts by container width.
function DeviceRowFrame({ children }: { readonly children: ReactNode }) {
  return (
    <div
      data-testid="browser-device-row"
      role="group"
      aria-label="Browser viewport controls"
      className="@container h-10 min-w-0 flex-1"
    >
      <div className="flex h-full items-center gap-2 @max-[420px]:gap-1">{children}</div>
    </div>
  );
}

/**
 * Third row of the Browser header: device picker, size fields, rotate, scale and close.
 * It mounts into row 3, so opening or closing it never moves rows 1 and 2.
 */
export function BrowserDeviceRow({
  coordinator,
  state,
  onClose,
  onUserViewportChange,
  scale = 1,
}: BrowserDeviceRowProps) {
  const [presetOpen, setPresetOpen] = usePanelHeaderMenuOpen();
  const [scaleOpen, setScaleOpen] = usePanelHeaderMenuOpen();
  const dragEdge: ViewportDragEdge | null = useViewportDragStore((store) => store.edge);
  const sizing = useDeviceRowSizing(coordinator, state, onUserViewportChange);
  const { requested, dimensions } = sizing;
  const isLandscape = state.mode === "responsive" && requested.width > requested.height;
  const rotateLabel = isLandscape ? "Rotate viewport to portrait" : "Rotate viewport to landscape";
  const closeShortcut = keybindingKeycaps(getKeybindingForCommand("preview.deviceToolbar.toggle")?.key ?? "mod+shift+m", isMac);

  return (
    <PanelHeaderSlot slot="row3">
      <DeviceRowFrame>
        <DevicePicker
          open={presetOpen}
          selected={sizing.selectedPreset}
          onOpenChange={setPresetOpen}
          onResponsive={() => {
            setPresetOpen(false);
            sizing.clearPreset();
            onUserViewportChange?.();
            void coordinator.requestUserMode("responsive");
          }}
          onPreset={(preset) => {
            setPresetOpen(false);
            sizing.submitSize(preset, preset.id);
          }}
        />
        <div className="flex shrink-0 items-center gap-1.5">
          <SizeField
            label="Viewport width"
            value={dimensions.width}
            dragging={dragEdge === "right"}
            onChange={(width) => sizing.editDraft({ width })}
            onSubmit={sizing.submitDraft}
          />
          <span className="text-caption text-muted" aria-hidden>×</span>
          <SizeField
            label="Viewport height"
            value={dimensions.height}
            dragging={dragEdge === "bottom"}
            onChange={(height) => sizing.editDraft({ height })}
            onSubmit={sizing.submitDraft}
          />
        </div>
        <IconButton
          shape="round"
          aria-label={rotateLabel}
          onClick={() => sizing.submitSize({ width: requested.height, height: requested.width })}
        >
          <RotateCwSquare aria-hidden />
        </IconButton>
        <div className="min-w-0 flex-1" />
        <ScaleMenu
          open={scaleOpen}
          percent={Math.round(scale * 100)}
          presentation={state.presentation}
          onOpenChange={setScaleOpen}
          onPresentation={(presentation) => {
            setScaleOpen(false);
            onUserViewportChange?.();
            void coordinator.setPresentation(presentation);
          }}
        />
        <IconButton
          shape="round"
          aria-label="Close viewport toolbar"
          tooltipShortcut={closeShortcut}
          onClick={() => {
            onUserViewportChange?.();
            onClose();
          }}
        >
          <X aria-hidden />
        </IconButton>
      </DeviceRowFrame>
    </PanelHeaderSlot>
  );
}
