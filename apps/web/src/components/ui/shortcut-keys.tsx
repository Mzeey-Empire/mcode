import type { LucideIcon } from "lucide-react"
import { ArrowBigUpIcon, CommandIcon, CornerDownLeftIcon } from "lucide-react"

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

/**
 * One muted keycap per key. Keys with a known pictogram draw it at 12px in place of the word;
 * the word stays in the DOM for screen readers.
 */
export function ShortcutKeys({ keys }: { readonly keys: readonly string[] }) {
  return (
    <>
      {keys.map((key, index) => {
        const Icon = KEY_ICONS[key]
        return (
          <Kbd key={`${index}-${key}`} variant="keycap">
            {Icon ? (
              <>
                <Icon aria-hidden className="size-3 stroke-[1.75]" />
                <span className="sr-only">{key}</span>
              </>
            ) : (
              key
            )}
          </Kbd>
        )
      })}
    </>
  )
}
