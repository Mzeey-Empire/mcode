import { createContext, forwardRef, useContext, useMemo, useState, type ComponentPropsWithoutRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent } from "@/components/ui/popover";
import { ATTACHED_RAIL_SURFACE_CLASS, POPOVER_MOUNT_FADE_CLASS } from "@/components/ui/overlay-surface";

const ComposerOverlayHost = createContext<HTMLDivElement | null>(null);

/** Inset of an attached rail from each side of the composer, matching its corner radius. */
const ATTACHED_RAIL_INSET_PX = 14;
const VIEWPORT_PADDING_PX = 8;
const FLOATING_GAP_PX = 4;

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
  /** Called when Escape is pressed while a floating overlay is open. The owner decides whether to close. */
  onEscapeKeyDown?: () => void;
}

function surfaceToneClass(tone: "default" | "dark"): string | undefined {
  return tone === "dark" ? "border-border bg-panel text-ink" : undefined;
}

function floatingWidth(anchorWidth: number, minWidth: number, maxWidth: number | undefined): number {
  const width = Math.max(anchorWidth, minWidth);
  return maxWidth === undefined ? width : Math.min(width, maxWidth);
}

/**
 * Shared autocomplete overlay. Inside a composer layout an attached overlay joins the composer
 * as an in-flow rail; everywhere else it floats above its anchor as a popover.
 */
export const ComposerOverlaySurface = forwardRef<HTMLDivElement, ComposerOverlaySurfaceProps>(
  function ComposerOverlaySurface(
    {
      anchorRect,
      minWidth = 0,
      maxWidth,
      attached = false,
      tone = "default",
      className,
      children,
      onEscapeKeyDown,
      ...props
    },
    ref,
  ) {
    const host = useContext(ComposerOverlayHost);
    const attachedHost = attached ? host : null;
    // An attached overlay lines up with the composer's straight edge, inside its rounded corners.
    const overlayAnchorRect = useMemo(
      () => attached
        ? new DOMRect(
            anchorRect.left + ATTACHED_RAIL_INSET_PX,
            anchorRect.top,
            Math.max(anchorRect.width - ATTACHED_RAIL_INSET_PX * 2, 0),
            anchorRect.height,
          )
        : anchorRect,
      [anchorRect, attached],
    );
    const anchor = useMemo(() => ({ getBoundingClientRect: () => overlayAnchorRect }), [overlayAnchorRect]);

    if (attachedHost) {
      return createPortal(
        <div
          {...props}
          ref={ref}
          data-composer-autocomplete="true"
          style={{
            width: `calc(100% - ${ATTACHED_RAIL_INSET_PX * 2}px)`,
            marginLeft: ATTACHED_RAIL_INSET_PX,
            maxHeight: Math.max(0, anchorRect.top - VIEWPORT_PADDING_PX),
          }}
          className={cn(
            "composer-autocomplete-surface overflow-hidden",
            POPOVER_MOUNT_FADE_CLASS,
            ATTACHED_RAIL_SURFACE_CLASS,
            surfaceToneClass(tone),
            className,
          )}
        >
          {children}
        </div>,
        attachedHost,
      );
    }

    // The owner opens and closes the overlay from editor state, and focus stays in the editor,
    // so the popover neither moves focus nor dismisses itself. Base UI keeps Escape from leaving
    // the popover, so it reaches the owner through `onEscapeKeyDown`.
    return (
      <Popover
        open
        modal={false}
        onOpenChange={(open, details) => {
          if (!open && details.reason === "escape-key") onEscapeKeyDown?.();
        }}
      >
        <PopoverContent
          {...props}
          ref={ref}
          data-composer-autocomplete="true"
          anchor={anchor}
          side="top"
          align="start"
          sideOffset={FLOATING_GAP_PX}
          collisionPadding={VIEWPORT_PADDING_PX}
          collisionAvoidance={{ side: "none", align: "shift" }}
          initialFocus={false}
          finalFocus={false}
          style={{ width: floatingWidth(overlayAnchorRect.width, minWidth, maxWidth) }}
          className={cn(
            "composer-autocomplete-surface max-h-(--available-height) max-w-[calc(100vw-16px)] overflow-hidden p-0",
            surfaceToneClass(tone),
            className,
          )}
        >
          {children}
        </PopoverContent>
      </Popover>
    );
  },
);
