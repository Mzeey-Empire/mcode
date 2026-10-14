import { Fragment } from "react"
import type { LucideIcon } from "lucide-react"
import { ArrowBigUpIcon, CommandIcon, CornerDownLeftIcon } from "lucide-react"

import { isMac } from "@/lib/platform"
import { Kbd } from "./kbd"

/**
 * Keys with a well-known pictogram. Ctrl is absent on purpose: Windows has no standard icon for
 * it, and the chevron that Mac uses for Control reads as "up" there.
 */
const KEY_ICONS: Readonly<Record<string, LucideIcon>> = {
  Shift: ArrowBigUpIcon,
  "⇧": ArrowBigUpIcon,
  Enter: CornerDownLeftIcon,
  "⌘": CommandIcon,
}

/** A key drawn as its pictogram at 12px when it has one. The word stays in the DOM for screen readers. */
function KeyGlyph({ keyName }: { readonly keyName: string }) {
  const Icon = KEY_ICONS[keyName]
  if (!Icon) return <>{keyName}</>
  return (
    <>
      <Icon aria-hidden className="size-3 stroke-[1.75]" />
      <span className="sr-only">{keyName}</span>
    </>
  )
}

/** One keycap per key, as Paper draws tooltip shortcuts. */
export function ShortcutKeys({ keys }: { readonly keys: readonly string[] }) {
  return (
    <>
      {keys.map((key, index) => (
        <Kbd key={`${index}-${key}`} variant="keycap">
          <KeyGlyph keyName={key} />
        </Kbd>
      ))}
    </>
  )
}

/**
 * The whole shortcut in a single keycap, with a muted plus between keys off Mac. Mac shortcuts
 * run together (⌘⇧↵), matching `formatKeybinding`.
 */
export function ShortcutCombo({ keys }: { readonly keys: readonly string[] }) {
  return (
    <Kbd variant="keycap">
      <span className="flex items-center gap-1">
        {keys.map((key, index) => (
          <Fragment key={`${index}-${key}`}>
            {index > 0 && !isMac ? <span aria-hidden className="opacity-60">+</span> : null}
            <KeyGlyph keyName={key} />
          </Fragment>
        ))}
      </span>
    </Kbd>
  )
}
