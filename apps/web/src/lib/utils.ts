import { clsx, type ClassValue } from "clsx"
import { extendTailwindMerge, validators } from "tailwind-merge"

// tailwind-merge reads an unknown `text-*` class as a colour, so without these
// entries `cn("text-muted", "text-caption")` would drop the colour,
// and `cn("text-fade", "text-xs")` would drop the fade.
// The radius roles from index.css are registered so a caller's `rounded-*` replaces them.
const twMerge = extendTailwindMerge<"text-fade">({
  extend: {
    theme: {
      radius: ["badge", "menu", "control", "composer", "dialog"],
    },
    classGroups: {
      "font-size": [{ text: ["body", "prose", "body-small", "caption", "label", "button", "code"] }, "type-link"],
      "font-family": [{ font: ["code"] }],
      "text-fade": ["text-fade", { "text-fade-lines": [validators.isInteger] }],
    },
  },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
