"use client";

import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group";
import { cn } from "@/lib/utils";

/**
 * A single-choice group. Arrow keys move focus and the selection together, and Tab enters and
 * leaves the group as one stop. Pass `value` and `onValueChange` to keep a choice pending, for
 * example behind a confirmation: the checked radio follows `value`, not the last key press.
 */
function RadioGroup<Value>({ className, ...props }: RadioGroupPrimitive.Props<Value>) {
  return <RadioGroupPrimitive data-slot="radio-group" className={cn("grid gap-2", className)} {...props} />;
}

/**
 * One radio on Paper's 20px circle. It renders a `span`, which takes no name from a wrapping
 * `<label>`: name it with `aria-labelledby` or `aria-label`, and wrap it in a label only to make
 * the text clickable.
 */
function RadioGroupItem<Value>({ className, ...props }: RadioPrimitive.Root.Props<Value>) {
  return (
    <RadioPrimitive.Root
      data-slot="radio-group-item"
      className={cn(
        "flex size-5 shrink-0 items-center justify-center rounded-full border border-control-border bg-selected transition-colors duration-(--duration-fast) ease-(--ease-standard) hover:not-aria-invalid:border-muted hover:bg-hover focus-ring aria-invalid:border-error data-[checked]:not-aria-invalid:border-primary data-[checked]:bg-primary data-[checked]:hover:not-aria-invalid:border-primary-hover data-[checked]:hover:bg-primary-hover data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        className,
      )}
      {...props}
    >
      <RadioPrimitive.Indicator data-slot="radio-group-indicator" className="size-2 rounded-full bg-primary-ink" />
    </RadioPrimitive.Root>
  );
}

export { RadioGroup, RadioGroupItem };
