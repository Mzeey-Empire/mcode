import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/** A quiet status word beside a row's name, such as "Beta" or "In use": muted text on a faint ink tint. */
export function SettingsTag({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      className={cn("inline-flex h-5 shrink-0 items-center rounded-sm bg-ink/7 px-1.5 text-caption font-medium whitespace-nowrap text-muted", className)}
      {...props}
    />
  );
}
