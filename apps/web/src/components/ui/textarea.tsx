import * as React from "react"

import { cn } from "@/lib/utils"

/** Styled textarea input with shared UI states and accessibility styles. */
function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-16 w-full rounded-lg border border-control-border bg-transparent px-2.5 py-2 text-base transition-colors outline-none placeholder:text-muted focus-visible:border-focus focus-visible:ring-3 focus-visible:ring-focus/50 disabled:cursor-not-allowed disabled:bg-selected/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-selected/30 dark:disabled:bg-selected/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
