import { useEffect, useState } from "react";
import { EllipsisVertical, Minus, Plus } from "lucide-react";
import { usePanelHeaderMenuOpen } from "@/components/panels/shell/PanelHeader";
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
import { useToastStore } from "@/stores/toastStore";
import type { BrowserAction, BrowserTools, BrowserZoom } from "./browserToolbarModel";
import { browserCommands } from "./useBrowserCommands";

const ZOOM_STEP = 0.1;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function disabledReason(action: BrowserAction): string | null {
  return action.kind === "disabled" ? action.reason : null;
}

function runAction(action: BrowserAction): (() => void) | undefined {
  return action.kind === "enabled" ? action.run : undefined;
}

function useZoomFactor(zoom: BrowserZoom) {
  const [factor, setFactor] = useState<number | null>(null);
  const [applying, setApplying] = useState(false);
  const read = zoom.kind === "enabled" ? zoom.read : null;
  useEffect(() => {
    if (read === null) return undefined;
    let cancelled = false;
    read().then(
      (value) => {
        if (!cancelled) setFactor(value);
      },
      (error: unknown) => {
        if (!cancelled) useToastStore.getState().show({ kind: "failed", title: "Couldn't read zoom", meta: errorMessage(error) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [read]);

  const step = (delta: number) => {
    if (zoom.kind !== "enabled" || factor === null) return;
    setApplying(true);
    // Round so repeated 0.1 steps land on whole percentages instead of drifting.
    const next = Math.round((factor + delta) * 100) / 100;
    zoom.set(next).then(setFactor, (error: unknown) => {
      useToastStore.getState().show({ kind: "failed", title: "Couldn't change zoom", meta: errorMessage(error) });
    }).finally(() => setApplying(false));
  };
  return { factor, busy: factor === null || applying, step };
}

function ZoomRow({ zoom }: { readonly zoom: BrowserZoom }) {
  const { factor, busy, step } = useZoomFactor(zoom);
  const reason = zoom.kind === "disabled" ? zoom.reason : null;
  const stepperDisabled = reason !== null || busy;
  const stepper = { shape: "round", size: "inline", disabled: stepperDisabled, tooltip: reason ?? undefined } as const;
  return (
    // A plain row, not a menu item, so the popup stays open while the steppers are pressed repeatedly.
    <div className="flex h-row-compact items-center justify-between gap-2 px-3 text-body-small">
      <span className={reason === null ? "text-ink" : "text-muted"}>Zoom</span>
      <span className="flex items-center gap-1">
        <IconButton aria-label="Zoom out" {...stepper} onClick={() => step(-ZOOM_STEP)}>
          <Minus aria-hidden />
        </IconButton>
        <span className="w-11 text-center font-mono tabular-nums" aria-live="polite">
          {factor === null ? "" : `${Math.round(factor * 100)}%`}
        </span>
        <IconButton aria-label="Zoom in" {...stepper} onClick={() => step(ZOOM_STEP)}>
          <Plus aria-hidden />
        </IconButton>
      </span>
    </div>
  );
}

function commandShortcut(commandId: string): readonly string[] | undefined {
  const key = getKeybindingForCommand(commandId)?.key;
  return key === undefined ? undefined : keybindingKeycaps(key, isMac);
}

/** Browser tools and shortcuts. Unavailable actions retain their disabled reason. */
export function BrowserMoreMenu({ tools }: { readonly tools: BrowserTools }) {
  const [open, setOpen] = usePanelHeaderMenuOpen();
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        render={<Button type="button" variant="subtle" shape="round" size="icon-compact" aria-label="More" />}
      >
        <EllipsisVertical aria-hidden />
      </DropdownMenuTrigger>
      {/* The popup portals out of the Browser chrome, so it carries its own marker for Browser keys. */}
      <DropdownMenuContent data-browser-chrome="" align="end" sideOffset={4} className="w-[23.2rem]">
        <ZoomRow zoom={tools.zoom} />
        <DropdownMenuSeparator />
        {browserCommands.map((command) => (
          <DropdownMenuItem
            key={command.id}
            label={command.title}
            shortcut={commandShortcut(command.id)}
            disabledReason={disabledReason(tools[command.action])}
            onClick={runAction(tools[command.action])}
          />
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem label="Clear cookies" disabledReason={disabledReason(tools.clearCookies)} onClick={runAction(tools.clearCookies)} />
        <DropdownMenuItem label="Clear cache" disabledReason={disabledReason(tools.clearCache)} onClick={runAction(tools.clearCache)} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
