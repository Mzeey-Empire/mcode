import type { ReactNode } from "react"
import { CheckIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import { ShortcutKeys } from "./shortcut-keys"
import { FOCUS_RING_CLASS } from "./focus-ring"

/**
 * Paper's menu row (HZI-0): 40px tall, 12px inline padding, 8px radius and gap, body-small ink
 * text. Highlight state is left to each surface because Base UI menus and selects mark it with
 * `data-highlighted`, while the plain context menu relies on `:hover`.
 */
export const MENU_ROW_CLASS = cn(
  "relative flex h-row-default w-full min-w-0 shrink-0 cursor-pointer select-none items-center gap-2 rounded-menu px-3 text-left text-body-small text-ink outline-none",
  FOCUS_RING_CLASS,
)

/** Menu surface (I6X-0) spacing: 8px padding and a 4px gap between rows. */
export const MENU_LIST_CLASS = "flex flex-col gap-1 p-2"

/**
 * A disabled row stays listed and dimmed. It keeps pointer events so hovering it still shows
 * the tooltip that explains why it is unavailable.
 */
export const MENU_ROW_DISABLED_CLASS = "data-disabled:cursor-default data-disabled:opacity-50"

/** The content every menu row shares, named so callers never hand-build row layout. */
export interface MenuRowContent {
  /** The row's name. Menus list names only, without descriptions. */
  readonly label: string
  /** A Lucide icon, drawn at 16px in a 20px leading lane. */
  readonly icon?: ReactNode
  /** Keys of the command's shortcut, one muted keycap each on the right, e.g. `["Ctrl", "Shift", "M"]`. */
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
  return <CheckIcon aria-hidden className="size-[1.6rem] text-ink" strokeWidth={1.5} />
}

function MenuRowShortcut({ keys }: { readonly keys: readonly string[] }) {
  return (
    <span aria-hidden data-slot="menu-row-shortcut" className="flex shrink-0 items-center gap-1 text-muted">
      <ShortcutKeys keys={keys} />
    </span>
  )
}

/** Lays out a row's icon lane, fading label and trailing slot. */
export function MenuRowBody({
  label,
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
      <span className={cn("min-w-0 flex-1 text-fade", destructive && "text-error")}>{label}</span>
      {trailingContent ? (
        <span className="flex h-[2rem] min-w-[2.4rem] shrink-0 items-center justify-end gap-2">
          {trailingContent}
        </span>
      ) : null}
    </>
  )
}
