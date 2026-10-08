import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "group/badge inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-4xl border border-transparent text-xs leading-4 font-medium whitespace-nowrap transition-all focus-visible:border-focus focus-visible:ring-[3px] focus-visible:ring-focus/50 has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&>svg]:pointer-events-none [&>svg]:size-3!",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-ink [a]:hover:bg-primary/80",
        secondary:
          "bg-button-secondary text-ink [a]:hover:bg-button-secondary/80",
        destructive:
          "bg-destructive/10 text-destructive focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:focus-visible:ring-destructive/40 [a]:hover:bg-destructive/20",
        outline:
          "border-border text-ink [a]:hover:bg-hover [a]:hover:text-muted",
        ghost:
          "hover:bg-hover hover:text-muted dark:hover:bg-hover/50",
        link: "text-link underline-offset-4 hover:underline",
      },
      size: {
        default: "h-5 px-2 py-0",
        sm: "h-4 px-1 py-0 [&>svg]:size-3!",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

/** Status/label badge with variant and size options. */
function Badge({
  className,
  variant = "default",
  size = "default",
  render,
  ...props
}: useRender.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(
      {
        className: cn(badgeVariants({ variant, size, className })),
      },
      props
    ),
    render,
    state: {
      slot: "badge",
      variant,
    },
  })
}

export { Badge, badgeVariants }
