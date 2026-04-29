import { cn } from "@/lib/utils";

/**
 * Renders a keyboard shortcut hint in mono small-caps style.
 * Used throughout the palette to display key combinations (e.g. ⌘K, Ctrl+Enter).
 *
 * `variant="inline"` adapts to its parent's text color via `currentColor`,
 * so the chip remains legible inside colored containers like a primary button.
 */
export function Kbd({
  children,
  variant = "default",
}: {
  children: React.ReactNode;
  variant?: "default" | "inline";
}) {
  return (
    <kbd
      className={cn(
        "inline-flex items-center px-1 py-0.5 font-mono text-[10.5px] uppercase tracking-[0.16em] rounded-sm",
        variant === "inline"
          ? // currentColor-derived border so the chip stays legible inside colored buttons.
            // The `border-current/30` syntax uses Tailwind 4's color-mix with currentColor.
            "border border-current/30 text-current"
          : "text-muted-foreground/60 border border-border/40",
      )}
    >
      {children}
    </kbd>
  );
}
