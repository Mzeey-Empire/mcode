import { clsx, type ClassValue } from "clsx"
import { extendTailwindMerge } from "tailwind-merge"

// tailwind-merge reads an unknown `text-*` class as a colour, so without these
// entries `cn("text-muted", "text-caption")` would drop the colour.
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: ["body", "prose", "body-small", "caption", "label", "button", "code"] }, "type-link"],
      "font-family": [{ font: ["code"] }],
    },
  },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
