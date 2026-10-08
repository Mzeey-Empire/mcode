import type * as React from "react"
import { CircleAlert } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * The error line under an invalid control: a 16px alert icon and caption text in the error
 * colour. Give it an `id` and point the control's `aria-describedby` at it, and set
 * `aria-invalid` on the control so its edge turns red too.
 */
function FieldError({ className, children, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="field-error"
      className={cn("ml-1 flex items-center gap-1 text-caption text-error", className)}
      {...props}
    >
      <CircleAlert className="size-4 shrink-0" aria-hidden />
      {children}
    </p>
  )
}

export { FieldError }
