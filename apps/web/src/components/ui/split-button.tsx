"use client"

import { useRef, type ReactNode } from "react"
import { ChevronDown } from "lucide-react"

import { Button, type ButtonProps } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"

type SplitButtonVariant = "default" | "outline" | "secondary" | "ghost"
type SplitButtonSize = "compact" | "default" | "comfortable"

// Object props skip JSX's data-attribute allowance, so test ids need an explicit slot.
type DataAttributes = { [key: `data-${string}`]: string | undefined }

const CHEVRON_SIZE: Record<SplitButtonSize, ButtonProps["size"]> = {
  compact: "icon-compact",
  default: "icon-default",
  comfortable: "icon-comfortable",
}

/** Props for {@link SplitButton}. */
interface SplitButtonProps {
  /** The action's label, optionally led by an icon. */
  children: ReactNode
  onClick?: ButtonProps["onClick"]
  /** Accessible name of the chevron that opens the alternates menu. */
  menuLabel: string
  /** The alternates, as `DropdownMenuItem`s listed by name. */
  menu: ReactNode
  /** Amber `default` only when the action is the state's primary. */
  variant?: SplitButtonVariant
  size?: SplitButtonSize
  disabled?: boolean
  loading?: boolean
  className?: string
  /** Extra props for the action half, such as a test id or a longer accessible name. */
  actionProps?: Omit<ButtonProps, "children" | "onClick" | "variant" | "size" | "disabled" | "loading"> & DataAttributes
  /** Menu placement against the whole control, e.g. `left` to open beside a column. */
  menuSide?: "top" | "bottom" | "left" | "right"
  menuAlign?: "start" | "center" | "end"
  menuSideOffset?: number
  /** Extra props for the chevron half. */
  menuTriggerProps?: Omit<ButtonProps, "children" | "variant" | "size" | "disabled" | "aria-label"> & DataAttributes
}

/**
 * One control with the action on the left and a chevron on the right that opens a
 * menu of alternate methods. Both halves share one outline; focus order is action,
 * then chevron.
 */
function SplitButton({
  children,
  onClick,
  menuLabel,
  menu,
  variant = "outline",
  size = "compact",
  disabled = false,
  loading = false,
  className,
  actionProps,
  menuTriggerProps,
  menuSide = "bottom",
  menuAlign = "end",
  menuSideOffset,
}: SplitButtonProps) {
  // The menu belongs to the whole control, so it positions against both halves, not the chevron.
  const rootRef = useRef<HTMLDivElement>(null)
  return (
    <div ref={rootRef} data-slot="split-button" className={cn("inline-flex min-w-0 rounded-control", className)}>
      <Button
        {...actionProps}
        variant={variant}
        size={size}
        disabled={disabled}
        loading={loading}
        onClick={onClick}
        className={cn("min-w-0 rounded-r-none", variant === "outline" && "border-r-0", actionProps?.className)}
      >
        {children}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              {...menuTriggerProps}
              variant={variant}
              size={CHEVRON_SIZE[size]}
              disabled={disabled || loading}
              aria-label={menuLabel}
              className={cn(
                // The divider sits inside the chevron half so both fills stay continuous.
                // Outline already divides with the chevron's own left border.
                "rounded-l-none before:absolute before:inset-y-2 before:left-0 before:w-px before:bg-current before:opacity-25",
                variant === "outline" && "before:hidden",
                menuTriggerProps?.className,
              )}
            >
              <ChevronDown aria-hidden />
            </Button>
          }
        />
        <DropdownMenuContent anchor={rootRef} side={menuSide} align={menuAlign} sideOffset={menuSideOffset}>
          {menu}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

export { SplitButton }
export type { SplitButtonProps }
