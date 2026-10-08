import * as React from "react"

import { cn } from "@/lib/utils"
import { FIELD_READ_ONLY_CLASS, FIELD_SURFACE_CLASS } from "./field-surface"

/** Multi-line text field with the shared field states and a 12px inset. */
function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-24 p-3",
        FIELD_SURFACE_CLASS,
        FIELD_READ_ONLY_CLASS,
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
