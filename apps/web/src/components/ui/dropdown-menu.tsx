"use client"

import * as React from "react"
import { Menu as MenuPrimitive } from "@base-ui/react/menu"
import { ChevronRightIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import {
  MENU_LIST_CLASS,
  MENU_ROW_CLASS,
  MENU_ROW_DISABLED_CLASS,
  MenuRowBody,
  MenuRowCheck,
  type MenuRowContent,
} from "./menu-row"
import { POPOVER_FADE_CLASS, POPOVER_SURFACE_CLASS } from "./overlay-surface"
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip"

const MENU_ITEM_ROW_CLASS = cn(MENU_ROW_CLASS, MENU_ROW_DISABLED_CLASS, "data-highlighted:bg-hover")

/**
 * Dropdown menu root that allows pointer interaction outside the popup by default.
 */
function DropdownMenu({ modal = false, ...props }: MenuPrimitive.Root.Props) {
  return <MenuPrimitive.Root data-slot="dropdown-menu" modal={modal} {...props} />
}

/** The control that opens the menu and takes focus back when it closes. */
function DropdownMenuTrigger({ ...props }: MenuPrimitive.Trigger.Props) {
  return <MenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />
}

/** Paper's menu surface (I6X-0) holding the rows. */
function DropdownMenuContent({
  className,
  side,
  sideOffset = 4,
  align = "start",
  alignOffset,
  anchor,
  collisionAvoidance,
  ...props
}: MenuPrimitive.Popup.Props &
  Pick<
    MenuPrimitive.Positioner.Props,
    "side" | "align" | "sideOffset" | "alignOffset" | "anchor" | "collisionAvoidance"
  >) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner
        side={side}
        sideOffset={sideOffset}
        align={align}
        alignOffset={alignOffset}
        anchor={anchor}
        collisionAvoidance={collisionAvoidance}
        className="pointer-events-none isolate z-(--layer-modal)"
      >
        <MenuPrimitive.Popup
          data-slot="dropdown-menu-content"
          className={cn(
            "pointer-events-auto min-w-[8rem] overflow-hidden",
            MENU_LIST_CLASS,
            POPOVER_SURFACE_CLASS,
            POPOVER_FADE_CLASS,
            className,
          )}
          {...props}
        />
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  )
}

/** Groups related rows. Groups are split by separators and carry no visible label. */
function DropdownMenuGroup({ className, ...props }: MenuPrimitive.Group.Props) {
  return (
    <MenuPrimitive.Group
      data-slot="dropdown-menu-group"
      className={cn("flex flex-col gap-1", className)}
      {...props}
    />
  )
}

/** Base UI item props minus the ones the row recipe owns. */
type MenuItemPrimitiveProps = Omit<MenuPrimitive.Item.Props, "children" | "disabled" | "label">

/** Props for {@link DropdownMenuItem}. */
export interface DropdownMenuItemProps extends MenuItemPrimitiveProps, MenuRowContent {
  /**
   * Why the row is unavailable. Setting it dims the row, blocks activation, and explains the
   * reason in a tooltip and in the row's accessible description. A row cannot be disabled
   * without one.
   */
  readonly disabledReason?: string | null
}

/**
 * One menu row: a name with an optional icon, shortcut or trailing status. A `checked` row
 * reports itself as a radio choice so assistive tech reads the current selection.
 */
function DropdownMenuItem({
  label,
  icon,
  shortcut,
  trailing,
  checked,
  destructive,
  disabledReason,
  className,
  ...props
}: DropdownMenuItemProps) {
  const reasonId = React.useId()
  const disabled = Boolean(disabledReason)
  const choiceProps = checked === undefined
    ? {}
    : { role: "menuitemradio", "aria-checked": checked }
  const item = (
    <MenuPrimitive.Item
      data-slot="dropdown-menu-item"
      label={label}
      disabled={disabled}
      aria-describedby={disabled ? reasonId : undefined}
      className={cn(MENU_ITEM_ROW_CLASS, className)}
      {...choiceProps}
      {...props}
    >
      <MenuRowBody
        label={label}
        icon={icon}
        shortcut={shortcut}
        trailing={trailing}
        checked={checked}
        destructive={destructive}
      />
      {disabled ? <span id={reasonId} hidden>{disabledReason}</span> : null}
    </MenuPrimitive.Item>
  )
  return <DisabledReasonTooltip reason={disabledReason}>{item}</DisabledReasonTooltip>
}

/**
 * Explains an unavailable row on hover and focus. Base UI keeps disabled rows focusable, so
 * keyboard users reach the tooltip too.
 */
function DisabledReasonTooltip({
  reason,
  children,
}: {
  readonly reason: string | null | undefined
  readonly children: React.ReactElement
}) {
  if (!reason) return children
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent side="right">{reason}</TooltipContent>
    </Tooltip>
  )
}

/** Props for {@link DropdownMenuCheckboxItem}. */
export type DropdownMenuCheckboxItemProps =
  Omit<MenuPrimitive.CheckboxItem.Props, "children" | "label"> &
  Omit<MenuRowContent, "checked" | "shortcut" | "trailing">

/** A row that toggles on its own. The check sits on the right, matching checked rows. */
function DropdownMenuCheckboxItem({
  label,
  icon,
  destructive,
  className,
  ...props
}: DropdownMenuCheckboxItemProps) {
  return (
    <MenuPrimitive.CheckboxItem
      data-slot="dropdown-menu-checkbox-item"
      label={label}
      className={cn(MENU_ITEM_ROW_CLASS, className)}
      {...props}
    >
      <MenuRowBody
        label={label}
        icon={icon}
        destructive={destructive}
        trailing={
          <MenuPrimitive.CheckboxItemIndicator className="flex">
            <MenuRowCheck />
          </MenuPrimitive.CheckboxItemIndicator>
        }
      />
    </MenuPrimitive.CheckboxItem>
  )
}

/** Paper's separator (I78-0): a 1px line inside a 9px band, inset 8px. */
function DropdownMenuSeparator({ className, ...props }: MenuPrimitive.Separator.Props) {
  return (
    <MenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      className={cn(
        "flex h-[0.9rem] shrink-0 items-center px-2 before:h-px before:flex-1 before:bg-border",
        className,
      )}
      {...props}
    />
  )
}

/** Root of a submenu that opens beside its parent row. */
function DropdownMenuSub({ ...props }: MenuPrimitive.SubmenuRoot.Props) {
  return <MenuPrimitive.SubmenuRoot data-slot="dropdown-menu-sub" {...props} />
}

/** Props for {@link DropdownMenuSubTrigger}. */
export type DropdownMenuSubTriggerProps =
  Omit<MenuPrimitive.SubmenuTrigger.Props, "children" | "disabled" | "label"> &
  Pick<MenuRowContent, "label" | "icon"> &
  Pick<DropdownMenuItemProps, "disabledReason">

/** A row that opens a submenu, with a chevron in the trailing slot. */
function DropdownMenuSubTrigger({
  label,
  icon,
  disabledReason,
  className,
  delay = 0,
  closeDelay = 100,
  ...props
}: DropdownMenuSubTriggerProps) {
  const reasonId = React.useId()
  const disabled = Boolean(disabledReason)
  return (
    <DisabledReasonTooltip reason={disabledReason}>
      <MenuPrimitive.SubmenuTrigger
        data-slot="dropdown-menu-sub-trigger"
        label={label}
        disabled={disabled}
        aria-describedby={disabled ? reasonId : undefined}
        className={cn(MENU_ITEM_ROW_CLASS, "data-popup-open:bg-hover", className)}
        delay={delay}
        closeDelay={closeDelay}
        {...props}
      >
        <MenuRowBody
          label={label}
          icon={icon}
          trailing={<ChevronRightIcon aria-hidden className="size-[1.6rem] text-muted" strokeWidth={1.5} />}
        />
        {disabled ? <span id={reasonId} hidden>{disabledReason}</span> : null}
      </MenuPrimitive.SubmenuTrigger>
    </DisabledReasonTooltip>
  )
}

const cascadingMenuCollisionAvoidance = {
  side: "flip",
  align: "shift",
  fallbackAxisSide: "none",
} as const

/** The submenu surface. It opens to the side and flips when there is no room. */
function DropdownMenuSubContent({
  className,
  sideOffset = 4,
  collisionPadding = 8,
  ...props
}: MenuPrimitive.Popup.Props &
  Pick<MenuPrimitive.Positioner.Props, "sideOffset" | "collisionPadding">) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner
        side="inline-end"
        align="start"
        sideOffset={sideOffset}
        positionMethod="fixed"
        collisionPadding={collisionPadding}
        collisionAvoidance={cascadingMenuCollisionAvoidance}
        className="pointer-events-none isolate z-(--layer-modal)"
      >
        <MenuPrimitive.Popup
          data-slot="dropdown-menu-sub-content"
          className={cn(
            "pointer-events-auto max-h-(--available-height) min-w-[8rem] overflow-y-auto",
            MENU_LIST_CLASS,
            POPOVER_SURFACE_CLASS,
            POPOVER_FADE_CLASS,
            className,
          )}
          {...props}
        />
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  )
}

export {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
}
