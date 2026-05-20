import { useState } from "react";
import { Monitor, Smartphone, Tablet, Crosshair, Maximize2 } from "lucide-react";
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

/**
 * Phase G design-mode bar. Sits above the omnibox when the user toggles
 * design mode on. Provides viewport presets and a read-only inspect toggle
 * that overlays element bounds inside the guest page.
 */
export function PreviewDesignBar() {
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
    </div>
  );
}
