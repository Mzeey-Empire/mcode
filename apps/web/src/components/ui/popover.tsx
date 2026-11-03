"use client"

import { Popover as PopoverPrimitive } from "@base-ui/react/popover"
import { createContext, useCallback, useContext, useLayoutEffect, useRef, useState, type Ref } from "react"

import { cn } from "@/lib/utils"
import { GenieMotion } from "./genie"
import { useGatedOpen } from "./overlay-gate"
import { POPOVER_FADE_CLASS, POPOVER_SURFACE_CLASS } from "./overlay-surface"

/**
 * How a popover enters and leaves. `"fade"` is the standard opacity fade; `"genie"` pours the popup out of `origin`
 * (usually its trigger) and back into it. Reduced motion always fades.
 */
type PopoverMotion = "fade" | { readonly kind: "genie"; readonly origin: () => HTMLElement | null }

const PopupRefContext = createContext<((popup: HTMLElement | null) => void) | null>(null)

type PopoverProps = PopoverPrimitive.Root.Props & { readonly motion?: PopoverMotion | undefined }

/** A popover root under the overlay gate, with an optional Genie entry and exit. */
function Popover({ open, defaultOpen, onOpenChange, motion = "fade", actionsRef, ...props }: PopoverProps) {
  const genie = useGenie(motion === "fade" ? null : motion.origin)
  const ownActionsRef = useRef<PopoverPrimitive.Root.Actions | null>(null)
  const actions = actionsRef ?? ownActionsRef
  const handleOpenChange = useCallback(
    (next: boolean, details: PopoverPrimitive.Root.ChangeEventDetails) => {
      onOpenChange?.(next, details)
      if (next || !genie || details.isCanceled) return
      // Base UI holds the closed popup mounted until `unmount()`, so it can pour back into the trigger.
      if (genie.close(() => actions.current?.unmount())) details.preventUnmountOnClose()
    },
    [onOpenChange, genie, actions],
  )
  const gated = useGatedOpen({ open, defaultOpen, onOpenChange: handleOpenChange })
  useGenieOpenState(genie, gated.open)
  return (
    <PopupRefContext.Provider value={genie ? genie.setPopup : null}>
      <PopoverPrimitive.Root data-slot="popover" actionsRef={actions} {...props} {...gated} />
    </PopupRefContext.Provider>
  )
}

function useGenie(origin: (() => HTMLElement | null) | null): GenieMotion | null {
  const [genie] = useState(() => (origin ? new GenieMotion(origin) : null))
  if (genie && origin) genie.setOrigin(origin)
  useLayoutEffect(() => (genie ? () => genie.dispose() : undefined), [genie])
  return genie
}

/**
 * Starts the pour when the root goes from closed to open. A close the wrapper did not see (the overlay gate, or a
 * caller setting `open` itself) has no details to hold the unmount with, so it falls back to the plain fade. A switch
 * of trigger or payload keeps the root open and never reaches here.
 */
function useGenieOpenState(genie: GenieMotion | null, open: boolean) {
  const wasOpen = useRef(open)
  useLayoutEffect(() => {
    if (!genie || wasOpen.current === open) return
    wasOpen.current = open
    if (open) genie.open()
    else genie.cancelUnlessClosing()
  }, [genie, open])
}

function PopoverTrigger({ ...props }: PopoverPrimitive.Trigger.Props) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />
}

function useMergedPopupRef(ref: Ref<HTMLDivElement> | undefined) {
  const registerPopup = useContext(PopupRefContext)
  return useCallback(
    (popup: HTMLDivElement | null) => {
      registerPopup?.(popup)
      if (typeof ref === "function") ref(popup)
      else if (ref) ref.current = popup
    },
    [registerPopup, ref],
  )
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
  ref,
  ...props
}: PopoverPrimitive.Popup.Props &
  Pick<
    PopoverPrimitive.Positioner.Props,
    "align" | "sideOffset" | "alignOffset" | "anchor" | "collisionBoundary" | "collisionPadding" | "collisionAvoidance" | "positionMethod" | "side" | "sticky"
  > & { readonly ref?: Ref<HTMLDivElement> | undefined }) {
  const popupRef = useMergedPopupRef(ref)
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
          ref={popupRef}
          data-slot="popover-content"
          className={cn(
            "pointer-events-auto w-72 p-4 outline-none data-genie:transition-none",
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

/** Imperative handles for a popover root; `close()` reports through `onOpenChange`, so a Genie pours back. */
type PopoverRootActions = PopoverPrimitive.Root.Actions

export { Popover, PopoverContent, PopoverTrigger, type PopoverMotion, type PopoverRootActions, type PopoverRootChangeEventDetails }
