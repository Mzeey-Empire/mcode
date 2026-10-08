import { Switch as SwitchPrimitive } from "@base-ui/react/switch"

import { cn } from "@/lib/utils"

/**
 * Switch on Paper's 36 by 20 track. The knob moves without a transition: DESIGN.md's switch
 * contract changes position instantly and lets only the colours update.
 */
function Switch({
  className,
  ...props
}: SwitchPrimitive.Root.Props) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-control-border bg-selected p-px transition-colors duration-(--duration-fast) ease-(--ease-standard) hover:not-aria-invalid:border-muted hover:bg-hover focus-ring aria-invalid:border-error data-[checked]:not-aria-invalid:border-primary data-[checked]:bg-primary data-[checked]:hover:not-aria-invalid:border-primary-hover data-[checked]:hover:bg-primary-hover data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block size-4 rounded-full bg-muted data-[checked]:translate-x-4 data-[checked]:bg-primary-ink"
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
