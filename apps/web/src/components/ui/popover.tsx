"use client"

import { Popover as PopoverPrimitive } from "@base-ui/react/popover"

import { cn } from "@/lib/utils"
import { useGatedOpen } from "./overlay-gate"
import { POPOVER_FADE_CLASS, POPOVER_SURFACE_CLASS } from "./overlay-surface"

function Popover({ open, defaultOpen, onOpenChange, ...props }: PopoverPrimitive.Root.Props) {
  const gated = useGatedOpen({ open, defaultOpen, onOpenChange })
  return <PopoverPrimitive.Root data-slot="popover" {...props} {...gated} />
}

function PopoverTrigger({ ...props }: PopoverPrimitive.Trigger.Props) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />
}

/** Renders collision-aware popover content in a portal. */
function PopoverContent({
  className,
  align = "center",
  sideOffset = 4,
  alignOffset,
  anchor,
  collisionBoundary,
  collisionPadding,
  collisionAvoidance,
  positionMethod,
  side,
  sticky,
  ...props
}: PopoverPrimitive.Popup.Props &
  Pick<
    PopoverPrimitive.Positioner.Props,
    "align" | "sideOffset" | "alignOffset" | "anchor" | "collisionBoundary" | "collisionPadding" | "collisionAvoidance" | "positionMethod" | "side" | "sticky"
  >) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner
        align={align}
        sideOffset={sideOffset}
        alignOffset={alignOffset}
        anchor={anchor}
        collisionBoundary={collisionBoundary}
        collisionPadding={collisionPadding}
        collisionAvoidance={collisionAvoidance}
        positionMethod={positionMethod}
        side={side}
        sticky={sticky}
        className="pointer-events-none isolate z-(--layer-modal)"
      >
        <PopoverPrimitive.Popup
          data-slot="popover-content"
          className={cn(
            "pointer-events-auto w-72 p-4 outline-none",
            POPOVER_SURFACE_CLASS,
            POPOVER_FADE_CLASS,
            className,
          )}
          {...props}
        />
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  )
}

/** Why a popover opened or closed, as passed to `onOpenChange`. */
type PopoverRootChangeEventDetails = PopoverPrimitive.Root.ChangeEventDetails

export { Popover, PopoverContent, PopoverTrigger, type PopoverRootChangeEventDetails }
