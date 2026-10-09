/**
 * Owns the visual proposal inspector controls and their existing interaction state, separate from annotation persistence and picker lifecycle.
 */
import {
  Fragment,
  useCallback,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { ChevronDown, ChevronRight, Link2, Pipette } from "lucide-react";
import type { PreviewAnnotationVisualProposal } from "@mcode/contracts";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  type VisualProposalKey,
  visualControlAffordance,
  displayVisualControlValue,
  type ColorVisualProposalKey,
  COLOR_CONTROL_DEFAULTS,
  type ExpandableVisualGroupId,
  type VisualLinkPairId,
} from "./visualProposalModel";
import {
  type ColorFormat,
  parseColorValue,
  colorSwatchValue,
  rgbToHsv,
  hsvToRgb,
  type RgbaColor,
  formatColorValue,
  clampUnit,
  clampColorChannel,
  rgbToHsl,
  hslToRgb,
  colorToHex,
  formatColorNumber,
  colorEditableSelectionRange,
} from "./visualProposalColor";

function linkedPairActiveClass(active: boolean): string {
  return active
    ? "border-control-border bg-selected text-ink"
    : "border-border bg-selected text-muted hover:border-control-border hover:text-ink";
}

function VisualLinkButton({
  active,
  label,
  onClick,
}: {
  readonly active: boolean;
  readonly label: string;
  readonly onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-compact"
      aria-label={label}
      aria-pressed={active}
      className={cn(
        "size-5 rounded-full border p-0 shadow-none hover:bg-hover",
        linkedPairActiveClass(active),
      )}
      onClick={onClick}
    >
      <Link2 size={11} aria-hidden />
    </Button>
  );
}

/** Edits a proposal value with its existing unit or format affordance. */
export function InspectorValueInput({
  controlKey,
  label,
  value,
  onChange,
  className,
}: {
  readonly controlKey: VisualProposalKey;
  readonly label: string;
  readonly value: unknown;
  readonly onChange: (key: VisualProposalKey, value: string | number) => void;
  readonly className?: string;
}) {
  const affordance = visualControlAffordance(controlKey);
  return (
    <span className="relative flex min-w-0 items-center">
      <Input
        size="compact"
        aria-label={label}
        value={displayVisualControlValue(controlKey, value)}
        onChange={(event) => onChange(controlKey, event.target.value)}
        placeholder={affordance === "0-1" ? "0-1" : undefined}
        inputMode={affordance === "0-1" || affordance === "px" ? "decimal" : undefined}
        className={cn(
          "h-7 rounded-md border-control-border bg-selected text-xs text-ink shadow-none placeholder:text-muted hover:border-border focus-visible:border-focus focus-visible:outline-0 focus-visible:ring-1 focus-visible:ring-focus",
          affordance === "px" && "pr-8",
          className,
        )}
      />
      {affordance === "px" ? (
        <span className="pointer-events-none absolute right-2 text-xs text-muted">
          px
        </span>
      ) : null}
    </span>
  );
}

/** Places an inspector label beside its controls. */
export function InspectorRow({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="grid grid-cols-[5.25rem_minmax(0,1fr)] items-center gap-2 text-xs text-muted">
      <span className="text-fade text-muted/90">{label}</span>
      {children}
    </div>
  );
}

/** Edits a proposal color through text, spectrum controls and the eyedropper. */
export function ColorInspectorControl({
  colorFormat,
  controlKey,
  label,
  value,
  onChange,
  onFormatChange,
}: {
  readonly colorFormat: ColorFormat;
  readonly controlKey: ColorVisualProposalKey;
  readonly label: string;
  readonly value: unknown;
  readonly onChange: (key: VisualProposalKey, value: string | number) => void;
  readonly onFormatChange: (key: ColorVisualProposalKey, format: ColorFormat) => void;
}) {
  const parsed = parseColorValue(value);
  const fallback = parseColorValue(COLOR_CONTROL_DEFAULTS[controlKey]) ?? {
    r: 0,
    g: 0,
    b: 0,
  };
  const pickerColor = parsed ?? fallback;
  const swatch = colorSwatchValue(controlKey, value);
  const displayValue = String(value ?? "");
  const hsv = rgbToHsv(pickerColor);
  const hueColor = hsvToRgb(hsv.h, 1, 1);
  const EyeDropperApi = (
    window as Window & { EyeDropper?: EyeDropperConstructor }
  ).EyeDropper;
  const commitColor = useCallback(
    (next: RgbaColor) => {
      onChange(controlKey, formatColorValue(next, colorFormat));
    },
    [colorFormat, controlKey, onChange],
  );
  const pickFromScreen = useCallback(() => {
    if (!EyeDropperApi) return;
    const eyeDropper = new EyeDropperApi();
    void eyeDropper
      .open()
      .then(({ sRGBHex }) => {
        const next = parseColorValue(sRGBHex);
        if (!next) return;
        commitColor({ ...next, a: pickerColor.a });
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        throw error;
      });
  }, [EyeDropperApi, commitColor, pickerColor.a]);
  const updateFromPlane = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const saturation = clampUnit((event.clientX - rect.left) / rect.width);
      const value = clampUnit(1 - (event.clientY - rect.top) / rect.height);
      commitColor(hsvToRgb(hsv.h, saturation, value, pickerColor.a));
    },
    [commitColor, hsv.h, pickerColor.a],
  );
  const updateFromHue = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      if (rect.width <= 0) return;
      const hue = clampUnit((event.clientX - rect.left) / rect.width) * 360;
      commitColor(hsvToRgb(hue, hsv.s, hsv.v, pickerColor.a));
    },
    [commitColor, hsv.s, hsv.v, pickerColor.a],
  );
  const updatePlaneFromKeyboard = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const step = event.shiftKey ? 0.1 : 0.01;
      let nextSaturation = hsv.s;
      let nextValue = hsv.v;
      switch (event.key) {
        case "ArrowLeft":
          nextSaturation = clampUnit(hsv.s - step);
          break;
        case "ArrowRight":
          nextSaturation = clampUnit(hsv.s + step);
          break;
        case "ArrowDown":
          nextValue = clampUnit(hsv.v - step);
          break;
        case "ArrowUp":
          nextValue = clampUnit(hsv.v + step);
          break;
        case "Home":
          nextSaturation = 0;
          nextValue = 0;
          break;
        case "End":
          nextSaturation = 1;
          nextValue = 1;
          break;
        default:
          return;
      }
      event.preventDefault();
      commitColor(hsvToRgb(hsv.h, nextSaturation, nextValue, pickerColor.a));
    },
    [commitColor, hsv.h, hsv.s, hsv.v, pickerColor.a],
  );
  const updateHueFromKeyboard = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const step = event.shiftKey ? 10 : 1;
      let nextHue: number;
      switch (event.key) {
        case "ArrowLeft":
        case "ArrowDown":
          nextHue = Math.max(0, hsv.h - step);
          break;
        case "ArrowRight":
        case "ArrowUp":
          nextHue = Math.min(360, hsv.h + step);
          break;
        case "Home":
          nextHue = 0;
          break;
        case "End":
          nextHue = 360;
          break;
        default:
          return;
      }
      event.preventDefault();
      commitColor(hsvToRgb(nextHue, hsv.s, hsv.v, pickerColor.a));
    },
    [commitColor, hsv.h, hsv.s, hsv.v, pickerColor.a],
  );
  const updateRgbChannel = (channel: keyof Pick<RgbaColor, "r" | "g" | "b">) =>
    (event: ChangeEvent<HTMLInputElement>) => {
      commitColor({
        ...pickerColor,
        [channel]: clampColorChannel(Number(event.target.value)),
      });
    };
  const hsl = rgbToHsl(pickerColor);
  const updateHslChannel = (channel: "h" | "s" | "l") =>
    (event: ChangeEvent<HTMLInputElement>) => {
      const numeric = Number(event.target.value);
      const next = {
        h: channel === "h" ? numeric : hsl.h,
        s: channel === "s" ? numeric / 100 : hsl.s,
        l: channel === "l" ? numeric / 100 : hsl.l,
      };
      commitColor(hslToRgb(next.h, next.s, next.l, pickerColor.a));
    };
  const formatFields =
    colorFormat === "hex" ? (
      <Input
        size="compact"
        aria-label={`${label} HEX value`}
        value={colorToHex(pickerColor)}
        onChange={(event) => {
          const next = parseColorValue(event.target.value);
          if (next) commitColor({ ...next, a: pickerColor.a });
        }}
        className="h-7 rounded-md border-control-border bg-selected font-mono text-xs text-ink shadow-none focus-visible:border-focus focus-visible:outline-0 focus-visible:ring-1 focus-visible:ring-focus"
      />
    ) : colorFormat === "hsl" ? (
      <div className="grid grid-cols-3 gap-1.5">
        {([
          ["H", "h", Math.round(hsl.h), "numeric"],
          ["S", "s", Math.round(hsl.s * 100), "numeric"],
          ["L", "l", Math.round(hsl.l * 100), "numeric"],
        ] as const).map(([fieldLabel, channel, channelValue, inputMode]) => (
          <label key={channel} className="min-w-0 space-y-1">
            <span className="block text-center font-mono text-xs uppercase text-muted">
              {fieldLabel}
            </span>
            <Input
              size="compact"
              aria-label={`${label} ${fieldLabel}`}
              value={formatColorNumber(channelValue)}
              inputMode={inputMode}
              onChange={updateHslChannel(channel)}
              className="h-7 rounded-md border-control-border bg-selected text-center font-mono text-xs text-ink shadow-none focus-visible:border-focus focus-visible:outline-0 focus-visible:ring-1 focus-visible:ring-focus"
            />
          </label>
        ))}
      </div>
    ) : (
      <div className="grid grid-cols-3 gap-1.5">
        {([
          ["R", "r", pickerColor.r, "numeric"],
          ["G", "g", pickerColor.g, "numeric"],
          ["B", "b", pickerColor.b, "numeric"],
        ] as const).map(([fieldLabel, channel, channelValue, inputMode]) => (
          <label key={channel} className="min-w-0 space-y-1">
            <span className="block text-center font-mono text-xs uppercase text-muted">
              {fieldLabel}
            </span>
            <Input
              size="compact"
              aria-label={`${label} ${fieldLabel}`}
              value={formatColorNumber(channelValue)}
              inputMode={inputMode}
              onChange={updateRgbChannel(channel)}
              className="h-7 rounded-md border-control-border bg-selected text-center font-mono text-xs text-ink shadow-none focus-visible:border-focus focus-visible:outline-0 focus-visible:ring-1 focus-visible:ring-focus"
            />
          </label>
        ))}
      </div>
    );
  return (
    <InspectorRow label={label}>
      <div className="relative flex min-w-0 items-center">
        <Popover>
          <PopoverTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-compact"
                aria-label={`Open ${label} picker`}
                className="absolute left-2 z-(--layer-sticky) size-4 rounded-full border border-border p-0 shadow-none ring-1 ring-ink/20 hover:ring-border"
                style={{ background: swatch }}
              />
            }
          />
          <PopoverContent
            side="bottom"
            align="start"
            sideOffset={6}
            collisionPadding={8}
            data-preview-design-keep-open="true"
            data-testid={`preview-color-popover-${controlKey}`}
            className="w-64 rounded-lg border-border bg-panel p-2.5 text-ink shadow-popover"
          >
            <div className="space-y-2.5">
              <div
                role="slider"
                tabIndex={0}
                aria-label={`Saturation and value for ${label}`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(hsv.s * 100)}
                aria-valuetext={`${Math.round(hsv.s * 100)}% saturation, ${Math.round(hsv.v * 100)}% value`}
                data-testid={`preview-color-plane-${controlKey}`}
                className="relative h-28 touch-none overflow-hidden rounded-md border border-border outline-none ring-ink/30 focus-visible:ring-2 focus-visible:ring-focus"
                style={{
                  // oxlint-disable-next-line mcode/no-raw-color -- Saturation and value encode user colour content across the full gamut.
                  background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${colorToHex(hueColor)})`,
                }}
                onPointerDown={(event) => {
                  event.currentTarget.setPointerCapture(event.pointerId);
                  updateFromPlane(event);
                }}
                onPointerMove={(event) => {
                  if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
                  updateFromPlane(event);
                }}
                onKeyDown={updatePlaneFromKeyboard}
              >
                <span
                  aria-hidden
                  className="absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-background ring-1 ring-ink/70"
                  style={{
                    left: `${hsv.s * 100}%`,
                    top: `${(1 - hsv.v) * 100}%`,
                  }}
                />
              </div>
              <div
                role="slider"
                tabIndex={0}
                aria-label={`Hue for ${label}`}
                aria-valuemin={0}
                aria-valuemax={360}
                aria-valuenow={Math.round(hsv.h)}
                data-testid={`preview-color-hue-${controlKey}`}
                className="relative h-4 touch-none rounded-full border border-border outline-none ring-ink/30 focus-visible:ring-2 focus-visible:ring-focus"
                style={{
                  background:
                    // oxlint-disable-next-line mcode/no-raw-color -- The hue spectrum is user colour content, independent of the app theme.
                    "linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)",
                }}
                onPointerDown={(event) => {
                  event.currentTarget.setPointerCapture(event.pointerId);
                  updateFromHue(event);
                }}
                onPointerMove={(event) => {
                  if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
                  updateFromHue(event);
                }}
                onKeyDown={updateHueFromKeyboard}
              >
                <span
                  aria-hidden
                  className="absolute top-1/2 size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-background ring-1 ring-ink/70"
                  style={{ left: `${(hsv.h / 360) * 100}%`, background: colorToHex(hueColor) }}
                />
              </div>
              <div className="flex items-center gap-2">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span className="inline-flex shrink-0 rounded-full">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-compact"
                          aria-label={`Pick ${label} from screen`}
                          disabled={!EyeDropperApi}
                          onClick={pickFromScreen}
                          className="size-6 rounded-full text-ink hover:bg-hover disabled:cursor-not-allowed disabled:text-muted"
                        >
                          <Pipette size={14} aria-hidden />
                        </Button>
                      </span>
                    }
                  />
                  <TooltipContent>
                    {EyeDropperApi
                      ? "Pick a color from the screen"
                      : "Screen color picker unavailable"}
                  </TooltipContent>
                </Tooltip>
                <span
                  aria-label={`Current ${label}`}
                  className="size-5 shrink-0 rounded-full border border-border ring-1 ring-ink/30"
                  style={{ background: colorToHex(pickerColor) }}
                />
                <div className="min-w-0 flex-1">{formatFields}</div>
              </div>
              <Input
                size="compact"
                aria-label={`Color picker for ${label}`}
                value={formatColorValue(pickerColor, colorFormat)}
                onChange={(event) => onChange(controlKey, event.target.value)}
                className="h-7 rounded-md border-control-border bg-selected font-mono text-xs text-ink shadow-none focus-visible:border-focus focus-visible:outline-0 focus-visible:ring-1 focus-visible:ring-focus"
              />
              <div className="grid grid-cols-3 overflow-hidden rounded-md border border-border bg-selected">
                {(["rgb", "hsl", "hex"] as const).map((format) => (
                  <Button
                    key={format}
                    type="button"
                    variant="ghost"
                    size="compact"
                    aria-label={`Use ${format.toUpperCase()} for ${label}`}
                    aria-pressed={colorFormat === format}
                    className={cn(
                      "h-7 rounded-none border-r border-border text-xs uppercase last:border-r-0",
                      colorFormat === format
                        ? "bg-selected text-ink"
                        : "text-muted hover:bg-hover hover:text-ink",
                    )}
                    onPointerDown={(event) => {
                      event.preventDefault();
                      onFormatChange(controlKey, format);
                    }}
                  >
                    {format}
                  </Button>
                ))}
              </div>
            </div>
          </PopoverContent>
        </Popover>
        <Input
          size="compact"
          aria-label={label}
          value={displayValue}
          onFocus={(event) => {
            const range = colorEditableSelectionRange(event.currentTarget.value);
            if (!range) return;
            window.setTimeout(() => {
              event.currentTarget.setSelectionRange(range[0], range[1]);
            }, 0);
          }}
          onChange={(event) => onChange(controlKey, event.target.value)}
          className="h-7 rounded-md border-control-border bg-selected pl-8 font-mono text-xs text-ink shadow-none placeholder:text-muted hover:border-border focus-visible:border-focus focus-visible:outline-0 focus-visible:ring-1 focus-visible:ring-focus"
        />
      </div>
    </InspectorRow>
  );
}

/** Edits width and height with the existing link toggle. */
export function LinkedSizeControls({
  linked,
  onChange,
  onToggleLinked,
  values,
}: {
  readonly linked: boolean;
  readonly onChange: (key: VisualProposalKey, value: string | number) => void;
  readonly onToggleLinked: () => void;
  readonly values: PreviewAnnotationVisualProposal;
}) {
  return (
    <div className="grid grid-cols-[5.25rem_1.5rem_minmax(0,1fr)] items-center gap-x-2 gap-y-1 text-xs text-muted">
      <span className="text-muted/90">Width</span>
      <div className="row-span-2 flex items-center justify-center">
        <VisualLinkButton
          active={linked}
          label="Link width and height"
          onClick={onToggleLinked}
        />
      </div>
      <InspectorValueInput
        controlKey="width"
        label="Width"
        value={values.width}
        onChange={onChange}
      />
      <span className="text-muted/90">Height</span>
      <InspectorValueInput
        controlKey="height"
        label="Height"
        value={values.height}
        onChange={onChange}
      />
    </div>
  );
}

function QuadInputStrip({
  entries,
  onChange,
  values,
}: {
  readonly entries: readonly {
    readonly key: VisualProposalKey;
    readonly ariaLabel: string;
    readonly label: string;
    readonly shortLabel: string;
  }[];
  readonly onChange: (key: VisualProposalKey, value: string | number) => void;
  readonly values: PreviewAnnotationVisualProposal;
}) {
  return (
    <div className="grid min-w-0 grid-cols-4 overflow-hidden rounded-md border border-border bg-selected">
      {entries.map((entry) => (
        <label
          key={entry.key}
          className="relative min-w-0 border-r border-border last:border-r-0"
        >
          <span className="sr-only">{entry.ariaLabel}</span>
          <Input
            size="compact"
            aria-label={entry.ariaLabel}
            value={displayVisualControlValue(entry.key, values[entry.key])}
            onChange={(event) => onChange(entry.key, event.target.value)}
            inputMode="decimal"
            className="h-7 rounded-none border-0 bg-transparent px-0 text-center font-mono text-xs tabular-nums text-ink shadow-none placeholder:text-muted hover:bg-hover focus-visible:outline-0 focus-visible:ring-1 focus-visible:ring-focus"
          />
        </label>
      ))}
    </div>
  );
}

/** Renders collapsed or individual side controls and their link toggles. */
export function ExpandableQuadGroup({
  entries,
  expanded,
  groupId,
  label,
  linkedPairs,
  linkedPairState,
  onChange,
  onToggleExpanded,
  onToggleLinked,
  values,
}: {
  readonly entries: readonly {
    readonly key: VisualProposalKey;
    readonly ariaLabel: string;
    readonly label: string;
    readonly shortLabel: string;
  }[];
  readonly expanded: boolean;
  readonly groupId: ExpandableVisualGroupId;
  readonly label: string;
  readonly linkedPairs: readonly {
    readonly id: VisualLinkPairId;
    readonly label: string;
  }[];
  readonly linkedPairState: Partial<Record<VisualLinkPairId, boolean>>;
  readonly onChange: (key: VisualProposalKey, value: string | number) => void;
  readonly onToggleExpanded: (groupId: ExpandableVisualGroupId) => void;
  readonly onToggleLinked: (pairId: VisualLinkPairId) => void;
  readonly values: PreviewAnnotationVisualProposal;
}) {
  if (!expanded) {
    return (
      <div className="grid grid-cols-[5.25rem_minmax(0,1fr)] items-center gap-2 text-xs text-muted">
        <Button
          type="button"
          variant="ghost"
          size="compact"
          className="-ml-1 h-7 justify-start gap-1 rounded-md px-1 text-xs text-muted/90 hover:bg-transparent hover:text-ink focus-visible:!border-focus focus-visible:!ring-1 focus-visible:!ring-focus"
          aria-expanded={false}
          onClick={() => onToggleExpanded(groupId)}
        >
          <ChevronRight size={13} aria-hidden />
          {label}
        </Button>
        <QuadInputStrip entries={entries} values={values} onChange={onChange} />
      </div>
    );
  }

  const [firstPair, secondPair] = linkedPairs;
  return (
    <div className="grid grid-cols-[4.5rem_1.25rem_minmax(3rem,1fr)] items-center gap-x-1.5 gap-y-1.5 border-t border-border pt-2 text-xs text-muted first:border-t-0 first:pt-0">
      <Button
        type="button"
        variant="ghost"
        size="compact"
        className="col-span-3 -ml-1 h-6 w-[calc(100%+0.25rem)] justify-start gap-1 rounded-md px-1 text-xs text-muted/90 hover:bg-hover hover:text-ink focus-visible:!border-focus focus-visible:!bg-hover focus-visible:!ring-1 focus-visible:!ring-focus"
        aria-expanded
        onClick={() => onToggleExpanded(groupId)}
      >
        <ChevronDown size={13} aria-hidden />
        {label}
      </Button>
      {entries.map((entry, index) => {
        const link =
          index === 0 && firstPair
            ? firstPair
            : index === 2 && secondPair
              ? secondPair
              : undefined;
        return (
          <Fragment key={entry.key}>
            <span className="text-fade text-muted/[0.85]">{entry.label}</span>
            <div className="flex items-center justify-center">
              {link ? (
                <VisualLinkButton
                  active={Boolean(linkedPairState[link.id])}
                  label={link.label}
                  onClick={() => onToggleLinked(link.id)}
                />
              ) : null}
            </div>
            <InspectorValueInput
              controlKey={entry.key}
              label={entry.ariaLabel}
              value={values[entry.key]}
              onChange={onChange}
            />
          </Fragment>
        );
      })}
    </div>
  );
}

interface EyeDropperConstructor {
  new (): {
    open: () => Promise<{ sRGBHex: string }>;
  };
}
