import type { ReactNode } from "react"
import { CheckIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import { ShortcutCombo } from "./shortcut-keys"
import { FOCUS_RING_CLASS } from "./focus-ring"

/**
 * Paper's compact menu row (161H-0): 32px tall, 12px inline padding, 6px radius, 8px gap,
 * body-small ink text. Highlight state is left to each surface because Base UI menus and
 * selects mark it with `data-highlighted`, while the plain context menu relies on `:hover`.
 */
export const MENU_ROW_CLASS = cn(
  "relative flex h-row-compact w-full min-w-0 shrink-0 cursor-pointer select-none items-center gap-2 rounded-sm px-3 text-left text-body-small text-ink outline-none",
  FOCUS_RING_CLASS,
)

/** Menu surface (I6X-0) spacing: 4px padding, with rows sitting flush. */
export const MENU_LIST_CLASS = "flex flex-col p-1"

/**
 * A disabled row stays listed and dimmed. It keeps pointer events so hovering it still shows
 * the tooltip that explains why it is unavailable.
 */
export const MENU_ROW_DISABLED_CLASS = "data-disabled:cursor-default data-disabled:opacity-50"

/** The content every menu row shares, named so callers never hand-build row layout. */
export interface MenuRowContent {
  /** The row's name. */
  readonly label: string
  /**
   * A muted second line for a row whose consequence depends on current state, such as
   * uncommitted changes that stay behind. Menus otherwise list names only; the row grows to fit.
   */
  readonly description?: string
  /** A Lucide icon, drawn at 16px in a 20px leading lane. */
  readonly icon?: ReactNode
  /** Keys of the command's shortcut, shown as one muted keycap on the right, e.g. `["Ctrl", "Shift", "M"]`. */
  readonly shortcut?: readonly string[]
  /** Status shown on the right, such as a run indicator or a "Soon" badge. */
  readonly trailing?: ReactNode
  /** Marks the current choice with a check on the right, after any trailing detail, instead of a fill. */
  readonly checked?: boolean
  /** Paints the label and icon in the error colour for actions that destroy something. */
  readonly destructive?: boolean
}

/** The check that marks a row as the current choice. */
export function MenuRowCheck() {
  return <CheckIcon aria-hidden className="size-[1.6rem] text-ink" />
}

function MenuRowShortcut({ keys }: { readonly keys: readonly string[] }) {
  return (
    <span aria-hidden data-slot="menu-row-shortcut" className="flex shrink-0 items-center gap-1 text-muted">
      <ShortcutCombo keys={keys} />
    </span>
  )
}

function MenuRowLabel({ label, description, destructive }: Pick<MenuRowContent, "label" | "description" | "destructive">) {
  const name = (
    <span className={cn("min-w-0 text-fade", !description && "flex-1", destructive && "text-error")}>{label}</span>
  )
  if (!description) return name
  return (
    <span className="flex min-w-0 flex-1 flex-col">
      {name}
      <span className="min-w-0 text-fade text-caption text-muted">{description}</span>
    </span>
  )
}

/** Lays out a row's icon lane, fading label and trailing slot. */
export function MenuRowBody({
  label,
  description,
  icon,
  shortcut,
  trailing,
  checked,
  destructive,
}: MenuRowContent) {
  const detail = trailing ?? (shortcut && shortcut.length > 0 ? <MenuRowShortcut keys={shortcut} /> : null)
  const trailingContent = checked ? <>{detail}<MenuRowCheck /></> : detail
  return (
    <>
      {icon ? (
        <span
          aria-hidden
          className={cn(
            "flex size-[2rem] shrink-0 items-center justify-center [&_svg]:size-[1.6rem] [&_svg]:stroke-[1.5]",
            destructive ? "text-error" : "text-muted",
          )}
        >
          {icon}
        </span>
      ) : null}
      <MenuRowLabel label={label} description={description} destructive={destructive} />
      {trailingContent ? (
        <span className="flex h-[2rem] min-w-[2.4rem] shrink-0 items-center justify-end gap-2">
          {trailingContent}
        </span>
      ) : null}
    </>
  )
}
