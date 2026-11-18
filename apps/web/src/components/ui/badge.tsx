import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "group/badge inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-badge border border-transparent px-2 whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus aria-invalid:border-error aria-invalid:bg-selected [&>svg]:pointer-events-none [&>svg]:size-3!",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-ink",
        secondary: "bg-selected text-ink",
        destructive: "bg-destructive text-destructive-ink",
        outline: "border-control-border text-ink",
        ghost: "text-ink",
        link: "text-link underline-offset-4 hover:underline",
      },
      size: {
        default: "h-6 text-label",
        compact: "h-5 text-caption",
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
