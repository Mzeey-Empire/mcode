"use client"

import { Children, isValidElement, type MouseEvent, type ReactNode } from "react"
import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"

import { Spinner } from "@/components/ui/spinner"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

// Pressed is a 2px inset ring in the variant's foreground colour, never a translation.
// Focus is a 2px ring 2px outside the control; an outline keeps the gap transparent on any surface.
const buttonVariants = cva(
  "group/button relative inline-flex shrink-0 items-center justify-center border border-transparent text-button whitespace-nowrap transition-colors duration-(--duration-fast) ease-(--ease-standard) select-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-solid focus-visible:outline-focus disabled:pointer-events-none disabled:opacity-50 aria-busy:cursor-progress aria-invalid:border-error [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-ink hover:bg-primary-hover active:bg-primary-hover active:inset-ring-2 active:inset-ring-primary-ink",
        outline:
          "border-control-border bg-background text-ink hover:bg-hover aria-expanded:bg-hover active:bg-selected active:inset-ring-2 active:inset-ring-ink",
        secondary:
          "bg-button-secondary text-ink hover:bg-button-secondary-hover aria-expanded:bg-button-secondary-hover active:bg-button-secondary-hover active:inset-ring-2 active:inset-ring-ink",
        ghost:
          "text-ink hover:bg-hover aria-expanded:bg-hover aria-pressed:bg-selected active:bg-selected active:inset-ring-2 active:inset-ring-ink",
        destructive:
          "bg-destructive text-destructive-ink hover:bg-button-destructive-hover active:bg-button-destructive-hover active:inset-ring-2 active:inset-ring-destructive-ink",
        link: "text-link underline underline-offset-4 hover:text-focus active:text-ink",
        // The round icon button's resting fill; switched on, it takes the control-border fill.
        subtle:
          "bg-selected text-ink hover:bg-button-secondary-hover aria-expanded:bg-control-border aria-pressed:bg-control-border active:inset-ring-2 active:inset-ring-ink",
        // Composer Stop: neutral by rule, never amber or red.
        ink: "bg-ink text-background hover:bg-ink/90 active:inset-ring-2 active:inset-ring-background",
      },
      size: {
        compact: "h-8 gap-2 px-3 [&_svg:not([class*='size-'])]:size-4",
        default: "h-10 gap-2 px-4 [&_svg:not([class*='size-'])]:size-5",
        comfortable: "h-12 gap-2 px-5 [&_svg:not([class*='size-'])]:size-5",
        "icon-compact": "size-8 [&_svg:not([class*='size-'])]:size-4",
        "icon-default": "size-10 [&_svg:not([class*='size-'])]:size-5",
        "icon-comfortable": "size-12 [&_svg:not([class*='size-'])]:size-5",
        // Inline row actions (revert file, a row's Stop, a toast's close); the row stays the larger target.
        "icon-inline": "size-7 [&_svg:not([class*='size-'])]:size-4",
        "icon-inline-sm": "size-6 [&_svg:not([class*='size-'])]:size-4",
      },
      shape: {
        square: "rounded-control",
        round: "rounded-full",
      },
    },
    compoundVariants: [
      {
        variant: "ghost",
        size: ["icon-compact", "icon-default", "icon-comfortable", "icon-inline", "icon-inline-sm"],
        className: "text-muted hover:text-ink aria-expanded:text-ink aria-pressed:text-ink",
      },
    ],
    defaultVariants: {
      variant: "default",
      size: "compact",
      shape: "square",
    },
  }
)

const SPINNER_PX_BY_SIZE: Record<ButtonSize, number> = {
  compact: 16,
  default: 20,
  comfortable: 20,
  "icon-compact": 16,
  "icon-default": 20,
  "icon-comfortable": 20,
  "icon-inline": 16,
  "icon-inline-sm": 16,
}

type ButtonSize = NonNullable<VariantProps<typeof buttonVariants>["size"]>

/** Props for {@link Button}. */
type ButtonProps = ButtonPrimitive.Props &
  VariantProps<typeof buttonVariants> & {
    /** Shows a spinner, keeps the width, and blocks repeat activation until cleared. */
    loading?: boolean
  }

/**
 * Swaps the leading icon for the spinner so the label and width stay put. Text-first
 * content has no icon slot, so the spinner overlays the content, which keeps its box.
 */
function renderLoadingContent(children: ReactNode, spinnerPx: number): ReactNode {
  const [first, ...rest] = Children.toArray(children)
  const spinner = <Spinner key="loading-spinner" size={spinnerPx} className="text-current" />
  if (isValidElement(first) && typeof first.type !== "string") return [spinner, ...rest]
  return (
    <>
      <span className="invisible inline-flex items-center gap-[inherit]">{children}</span>
      <span className="absolute inset-0 flex items-center justify-center">{spinner}</span>
    </>
  )
}

/** Shared button primitive: six Paper variants plus the round and ink fills, three sizes, and loading. */
function Button({
  className,
  variant = "default",
  size = "compact",
  shape = "square",
  loading = false,
  children,
  onClick,
  ...props
}: ButtonProps) {
  const handleClick = loading
    ? (event: MouseEvent<HTMLButtonElement>) => event.preventDefault()
    : onClick
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, shape, className }))}
      aria-busy={loading || undefined}
      aria-disabled={loading || undefined}
      onClick={handleClick}
      {...props}
    >
      {loading ? renderLoadingContent(children, SPINNER_PX_BY_SIZE[size ?? "compact"]) : children}
    </ButtonPrimitive>
  )
}

type IconButtonSize = "compact" | "default" | "comfortable" | "inline" | "inline-sm"

const ICON_BUTTON_SIZE: Record<IconButtonSize, ButtonSize> = {
  compact: "icon-compact",
  default: "icon-default",
  comfortable: "icon-comfortable",
  inline: "icon-inline",
  "inline-sm": "icon-inline-sm",
}

/** Props for {@link IconButton}. The accessible name is required because there is no visible label. */
interface IconButtonProps extends Omit<ButtonProps, "size" | "aria-label"> {
  "aria-label": string
  /** Tooltip text; defaults to the accessible name. */
  tooltip?: ReactNode
  /** Shortcut keys shown as keycaps in the tooltip. */
  tooltipShortcut?: readonly string[]
  size?: IconButtonSize
  /** Toggle state: drives `aria-pressed` and, on a round button, the control-border fill. */
  pressed?: boolean
  /** A round button floating over content: 40px with the floating shadow. */
  floating?: boolean
}

/**
 * Icon-only button with a required name and tooltip. Square defaults to ghost; round
 * defaults to the selected fill and is the 32px top-level and panel-header control.
 */
function IconButton({
  tooltip,
  tooltipShortcut,
  shape = "square",
  variant = shape === "round" ? "subtle" : "ghost",
  size = "compact",
  pressed,
  floating = false,
  className,
  ...props
}: IconButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant={variant}
            shape={shape}
            size={ICON_BUTTON_SIZE[floating ? "default" : size]}
            aria-pressed={pressed}
            className={cn(floating && "shadow-floating", className)}
            {...props}
          />
        }
      />
      <TooltipContent shortcut={tooltipShortcut}>{tooltip ?? props["aria-label"]}</TooltipContent>
    </Tooltip>
  )
}

export { Button, IconButton, buttonVariants }
export type { ButtonProps, ButtonSize, IconButtonProps }
