import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"
import { FIELD_READ_ONLY_CLASS, FIELD_SURFACE_CLASS } from "./field-surface"

const inputVariants = cva(
  cn(
    "flex px-3 file:border-0 file:bg-transparent file:font-medium file:text-ink file:text-body-small",
    FIELD_SURFACE_CLASS,
    FIELD_READ_ONLY_CLASS,
  ),
  {
    variants: {
      size: {
        compact: "h-control-compact",
        default: "h-control-default",
        comfortable: "h-control-comfortable",
      },
    },
    defaultVariants: {
      size: "default",
    },
  }
)

/** Text input on Paper's control scale: 40 by default, 32 in dense chrome, 48 for prominent fields. */
function Input({
  className,
  type,
  size = "default",
  ref,
  ...props
}: Omit<React.ComponentProps<"input">, "size"> &
  VariantProps<typeof inputVariants> & {
    ref?: React.Ref<HTMLInputElement>;
  }) {
  return (
    <input
      ref={ref}
      type={type}
      data-slot="input"
      className={cn(inputVariants({ size, className }))}
      {...props}
    />
  )
}

export { Input, inputVariants }
