"use client";

import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";
import { Check, Minus } from "lucide-react";
import { cn } from "@/lib/utils";

/** A checked state, or `"mixed"` for a parent row whose children are partly checked. */
type CheckboxChecked = boolean | "mixed";

/** Checkbox on Paper's 20px box, with a mixed state that reads as `aria-checked="mixed"`. */
function Checkbox({
  className,
  checked,
  ...props
}: Omit<CheckboxPrimitive.Root.Props, "checked" | "indeterminate"> & {
  checked?: CheckboxChecked;
}) {
  const mixed = checked === "mixed";
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      checked={mixed ? false : checked}
      indeterminate={mixed}
      className={cn(
        "peer flex size-5 shrink-0 items-center justify-center rounded-badge border border-control-border bg-selected text-primary-ink transition-colors duration-(--duration-fast) ease-(--ease-standard) hover:border-muted hover:bg-hover focus-ring aria-invalid:border-error data-[checked]:border-primary data-[checked]:bg-primary data-[checked]:hover:border-primary-hover data-[checked]:hover:bg-primary-hover data-[indeterminate]:border-primary data-[indeterminate]:bg-primary data-[indeterminate]:hover:border-primary-hover data-[indeterminate]:hover:bg-primary-hover data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator data-slot="checkbox-indicator">
        {mixed ? (
          <Minus className="size-4" strokeWidth={2} aria-hidden />
        ) : (
          <Check className="size-4" strokeWidth={2} aria-hidden />
        )}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
export type { CheckboxChecked };
