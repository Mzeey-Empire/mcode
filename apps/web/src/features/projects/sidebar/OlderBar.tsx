import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronUp } from "lucide-react";
import type { VirtualViewport } from "@/components/ui/virtual-viewport";
import { cn } from "@/lib/utils";
import type { SidebarItem } from "./sidebar-model";

/** The Older bar's virtual row key, which is also the viewport's sticky flow host id. */
export const OLDER_BAR_KEY = "older-bar";

type OlderBarItem = Extract<SidebarItem, { kind: "older-bar" }>;

// Sticky positioning moves the bar visually, not its slot, so the slot bottom still reports the
// natural position. Below the scroller's bottom edge means the bar is stuck there.
function isPinned(viewport: VirtualViewport): boolean {
  const bottom = viewport.rowBottom(OLDER_BAR_KEY);
  return bottom !== undefined && bottom > viewport.clientHeight + 0.5;
}

function usePinned(viewport: VirtualViewport): boolean {
  const [pinned, setPinned] = useState(() => isPinned(viewport));
  useEffect(() => {
    const update = () => setPinned(isPinned(viewport));
    update();
    return viewport.onLayout(update);
  }, [viewport]);
  return pinned;
}

interface OlderBarProps {
  readonly item: OlderBarItem;
  readonly viewport: VirtualViewport;
  readonly onToggle: () => void;
}

/**
 * The one Older bar, portalled into the viewport's sticky flow host. It sits on the list's bottom
 * edge with a fade above it until the list scrolls it into its own place.
 */
export function OlderBar({ item, viewport, onToggle }: OlderBarProps) {
  const pinned = usePinned(viewport);
  const host = viewport.flowHost;
  if (!host) return null;
  const Chevron = item.open ? ChevronDown : ChevronUp;
  return createPortal(
    <div data-testid="older-bar" data-pinned={pinned || undefined} className="relative bg-page">
      <div aria-hidden className={cn("pointer-events-none absolute inset-x-0 bottom-full h-6 bg-linear-to-t from-page to-transparent", !pinned && "hidden")} />
      <button
        type="button"
        aria-expanded={item.open}
        onClick={onToggle}
        className="flex h-8 w-full items-center gap-2 px-3 text-caption text-muted outline-none transition-colors hover:text-ink focus-visible:ring-2 focus-visible:ring-focus/70"
      >
        <span className="min-w-0 flex-1 text-left">Older</span>
        <span className="tabular-nums">{item.count}</span>
        <Chevron aria-hidden className="size-3.5 shrink-0" />
      </button>
    </div>,
    host,
  );
}
