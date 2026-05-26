import { useState } from "react";
import {
  Crosshair,
  Loader2,
  Maximize2,
  Monitor,
  PenTool,
  Smartphone,
  Tablet,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { DesignViewportPresetId } from "@/transport/desktop-bridge";

interface Preset {
  readonly id: DesignViewportPresetId;
  readonly label: string;
  readonly icon: typeof Monitor;
}

const PRESETS: ReadonlyArray<Preset> = [
  { id: "phone", label: "Phone", icon: Smartphone },
  { id: "tablet", label: "Tablet", icon: Tablet },
  { id: "desktop", label: "Desktop", icon: Monitor },
];

/** Props for the design-mode bar. The bar owns the Pick affordance now; the
 *  toolbar's Design button is purely a mode toggle. */
export interface PreviewDesignBarProps {
  /** True while an element-pick session is in flight; the Pick button shows a
   *  spinner and click toggles to cancel. */
  readonly elementPickBusy: boolean;
  /** Fires a single element-pick session. Called from the bar's Pick button. */
  readonly onPick: () => void;
  /** Exits design mode entirely (closes the bar). */
  readonly onExit: () => void;
}

/**
 * Design-mode bar. Sits above the omnibox whenever design mode is active.
 * Houses three concerns:
 *
 * 1. Viewport presets (Phone / Tablet / Desktop) that resize the embedded
 *    guest WebContents through the existing `preview.design` IPC.
 * 2. Read-only Inspect toggle that overlays element bounds inside the guest.
 * 3. Pick — the affordance that captures the next-clicked element as a PNG
 *    attachment. Pick lives here (not the primary toolbar) so design mode
 *    is the single surface that owns "do something with elements on the page".
 *
 * Cancelling an active pick session uses the preview's cancelCapture IPC; the
 * design mode itself stays on so the user can keep picking, switch presets,
 * or exit cleanly via the Exit button.
 */
export function PreviewDesignBar({
  elementPickBusy,
  onPick,
  onExit,
}: PreviewDesignBarProps) {
  const [activePreset, setActivePreset] = useState<DesignViewportPresetId | null>(null);
  const [inspect, setInspect] = useState(false);
  const design = window.desktopBridge?.preview?.design;
  if (!design) return null;

  const onPreset = async (preset: DesignViewportPresetId) => {
    if (activePreset === preset) {
      await design.resetViewport();
      setActivePreset(null);
      return;
    }
    const r = await design.setViewport({ presetId: preset });
    if (r.ok) setActivePreset(preset);
  };

  const onReset = async () => {
    await design.resetViewport();
    setActivePreset(null);
  };

  const onToggleInspect = async () => {
    const next = !inspect;
    const r = await design.setInspect(next);
    if (r.ok) setInspect(next);
  };

  const onPickClick = () => {
    // Mid-flight pick: route the click to the existing cancel-capture IPC so
    // the in-guest highlight tears down and the host promise resolves with
    // a "cancelled" error (silent on the React side).
    if (elementPickBusy) {
      void window.desktopBridge?.preview?.cancelCapture();
      return;
    }
    onPick();
  };

  return (
    <div
      data-testid="preview-design-bar"
      className="flex items-center gap-1 border-b border-border/30 px-2 py-1 text-xs"
      role="toolbar"
      aria-label="Design mode"
    >
      <span className="mr-1 font-mono text-[10px] tracking-[0.12em] uppercase text-muted-foreground/70">
        design
      </span>
      <button
        type="button"
        aria-pressed={elementPickBusy}
        data-testid="preview-design-pick"
        onClick={onPickClick}
        className={cn(
          "inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-muted",
          elementPickBusy
            ? "bg-primary/10 text-primary"
            : "text-muted-foreground hover:text-foreground",
        )}
        title={elementPickBusy ? "Cancel pick (Esc)" : "Click an element to attach"}
      >
        {elementPickBusy ? (
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
        ) : (
          <PenTool className="size-3.5" aria-hidden />
        )}
        <span>{elementPickBusy ? "Picking..." : "Pick"}</span>
      </button>
      <div className="mx-2 h-4 w-px bg-border/40" />
      {PRESETS.map((p) => {
        const Icon = p.icon;
        const active = activePreset === p.id;
        return (
          <button
            key={p.id}
            type="button"
            aria-pressed={active}
            data-testid={`preview-design-preset-${p.id}`}
            onClick={() => onPreset(p.id)}
            className={cn(
              "inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-muted",
              active && "bg-muted text-foreground",
            )}
          >
            <Icon className="size-3.5" aria-hidden />
            <span>{p.label}</span>
          </button>
        );
      })}
      <button
        type="button"
        aria-label="Reset viewport"
        data-testid="preview-design-reset"
        onClick={onReset}
        className="ml-1 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <Maximize2 className="size-3.5" aria-hidden />
      </button>
      <div className="mx-2 h-4 w-px bg-border/40" />
      <button
        type="button"
        aria-pressed={inspect}
        data-testid="preview-design-inspect"
        onClick={onToggleInspect}
        className={cn(
          "inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-muted",
          inspect && "bg-muted text-foreground",
        )}
      >
        <Crosshair className="size-3.5" aria-hidden />
        <span>Inspect</span>
      </button>
      <div className="flex-1" />
      <button
        type="button"
        data-testid="preview-design-exit"
        aria-label="Exit design mode"
        onClick={onExit}
        className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground/70 hover:bg-muted hover:text-foreground"
      >
        exit
      </button>
    </div>
  );
}
