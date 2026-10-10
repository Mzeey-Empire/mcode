import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip"

import { Kbd } from "@/components/ui/kbd"
import { cn } from "@/lib/utils"
import { useGatedOpen } from "./overlay-gate"

function TooltipProvider({
  delay = 0,
  ...props
}: TooltipPrimitive.Provider.Props) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delay={delay}
      {...props}
    />
  )
}

function Tooltip({ open, defaultOpen, onOpenChange, ...props }: TooltipPrimitive.Root.Props) {
  const gated = useGatedOpen({ open, defaultOpen, onOpenChange })
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} {...gated} />
}

function TooltipTrigger({ ...props }: TooltipPrimitive.Trigger.Props) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />
}

type TooltipContentProps = TooltipPrimitive.Popup.Props &
  Pick<
    TooltipPrimitive.Positioner.Props,
    "align" | "alignOffset" | "side" | "sideOffset"
  > & {
    /** Keys of the command's shortcut, one keycap each, e.g. `["Ctrl", "C"]`. */
    shortcut?: readonly string[]
    arrowClassName?: string
  }

/**
 * Paper's surface tooltip: panel fill, 1px border, caption text, an arrow toward the
 * trigger, and an opacity fade. Pass `shortcut` to show the command's keys as keycaps.
 */
function TooltipContent({
  arrowClassName,
  className,
  side = "top",
  // Clears the 6px arrow with a 2px gap to the trigger.
  sideOffset = 8,
  align = "center",
  alignOffset = 0,
  shortcut,
  children,
  ...props
}: TooltipContentProps) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        className="pointer-events-none isolate z-(--layer-modal)"
      >
        <TooltipPrimitive.Popup
          data-slot="tooltip-content"
          className={cn(
            "pointer-events-none z-(--layer-modal) inline-flex min-h-control-compact w-fit max-w-80 items-center gap-2 rounded-menu border border-border bg-panel px-3 py-[7px] text-caption text-ink transition-opacity duration-(--duration-standard) data-ending-style:opacity-0 data-instant:transition-none data-starting-style:opacity-0",
            className
          )}
          {...props}
        >
          {children}
          {shortcut && shortcut.length > 0 ? (
            <span data-slot="tooltip-shortcut" className="ml-1 flex shrink-0 items-center gap-1">
              {shortcut.map((key, index) => (
                <Kbd key={`${index}-${key}`} variant="keycap">
                  {key}
                </Kbd>
              ))}
            </span>
          ) : null}
          <TooltipPrimitive.Arrow
            data-slot="tooltip-arrow"
            className={cn(
              // A 10px square keeps Base UI's centring right on every side; the SVG draws the
              // 10x6 arrow in its top half and the box rotates so the tip faces the trigger.
              // The arrow is placed against the positioner's outer edge, so it starts 1px
              // inside it and its fill covers the popup border under the base.
              "size-2.5 fill-panel stroke-border data-[side=bottom]:bottom-[calc(100%-1px)] data-[side=bottom]:rotate-180 data-[side=inline-end]:right-[calc(100%-1px)] data-[side=inline-end]:rotate-90 data-[side=inline-start]:left-[calc(100%-1px)] data-[side=inline-start]:-rotate-90 data-[side=left]:left-[calc(100%-1px)] data-[side=left]:-rotate-90 data-[side=right]:right-[calc(100%-1px)] data-[side=right]:rotate-90 data-[side=top]:top-[calc(100%-1px)]",
              arrowClassName
            )}
          >
            <svg aria-hidden viewBox="0 0 10 10" className="block size-full overflow-visible">
              <path d="M0 0L5 5L10 0Z" stroke="none" />
              <path d="M0 0L5 5L10 0" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </TooltipPrimitive.Arrow>
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  )
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
