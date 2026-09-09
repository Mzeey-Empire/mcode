import { createContext, forwardRef, useContext, useState, type ComponentPropsWithoutRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import { computeFixedPopupPosition } from "./popup-position";

const ComposerOverlayHost = createContext<HTMLDivElement | null>(null);

/** Keeps attached overlays in the composer's layout so content reserves its own height. */
export function ComposerOverlayLayout({ children, className }: {
  readonly children: ReactNode;
  readonly className?: string;
}) {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  return (
    <ComposerOverlayHost.Provider value={host}>
      <div className={className}>
        <div ref={setHost} data-testid="composer-overlay-host" />
        {children}
      </div>
    </ComposerOverlayHost.Provider>
  );
}

interface ComposerOverlaySurfaceProps
  extends Omit<ComponentPropsWithoutRef<"div">, "children" | "className" | "style"> {
  /** Viewport anchor for the composer overlay. */
  anchorRect: DOMRect;
  /** Height used to keep the overlay inside the viewport. */
  estimatedHeight: number;
  /** Smallest allowed surface width. Defaults to the anchor's width. */
  minWidth?: number;
  /** Optional cap for compact non-composer contexts. */
  maxWidth?: number;
  /** Whether the overlay should join the composer as a context rail. */
  attached?: boolean;
  /** Visual palette used when the overlay appears in a preview annotation. */
  tone?: "default" | "dark";
  /** Additional surface classes for the owning autocomplete. */
  className?: string;
  /** Contents rendered inside the shared surface. */
  children: ReactNode;
}

function surfaceToneClass(tone: "default" | "dark", attached: boolean): string {
  if (tone === "dark") return "border-white/10 bg-[#1e1e1e] text-neutral-100";
  return attached ? "text-popover-foreground" : "bg-popover text-popover-foreground";
}

/** Shared overlay with in-flow composer placement and fixed placement in other contexts. */
export const ComposerOverlaySurface = forwardRef<HTMLDivElement, ComposerOverlaySurfaceProps>(
  function ComposerOverlaySurface(
    {
      anchorRect,
      estimatedHeight,
      minWidth = 0,
      maxWidth,
      attached = false,
      tone = "default",
      className,
      children,
      ...props
    },
    ref,
  ) {
    const host = useContext(ComposerOverlayHost);
    const attachedHost = attached ? host : null;
    const overlayAnchorRect = attached
      ? new DOMRect(
          anchorRect.left + 14,
          anchorRect.top,
          Math.max(anchorRect.width - 28, 0),
          anchorRect.height,
        )
      : anchorRect;
    const style = computeFixedPopupPosition({
      anchorRect: overlayAnchorRect,
      estimatedHeight,
      minWidth,
      maxWidth,
      preferredPlacement: "above",
      gap: attached ? 0 : undefined,
    });

    return createPortal(
      <div
        {...props}
        ref={ref}
        data-composer-autocomplete="true"
        style={attachedHost ? { width: "calc(100% - 28px)", marginLeft: 14, maxHeight: style.maxHeight } : style}
        className={cn(
          "composer-autocomplete-surface overflow-hidden animate-composer-popup-enter",
          attached
            ? "rounded-t-xl bg-popover ring-1 ring-inset ring-border/60"
            : "rounded-xl border border-border/70",
          surfaceToneClass(tone, attached),
          className,
        )}
      >
        {children}
      </div>,
      attachedHost ?? document.body,
    );
  },
);
