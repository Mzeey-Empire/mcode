import { cn } from "@/lib/utils";

/**
 * Renders a keyboard shortcut hint.
 *
 * `variant="default"` is the muted mono small-caps chip used in the palette and menus.
 * `variant="inline"` adapts to its parent's text color via `currentColor`,
 * so the chip remains legible inside colored containers like a primary button.
 * `variant="keycap"` is the tooltip, menu and picker keycap: a 20px key filled from `currentColor`,
 * so it reads on any tooltip fill. It has no outline and uses the UI font, because a column of
 * outlined monospace keys reads as noise beside the labels it serves.
 * `variant="hint"` is Paper's palette footer key: a filled 20px key in ink.
 */
export function Kbd({
  children,
  variant = "default",
}: {
  children: React.ReactNode;
  variant?: "default" | "inline" | "keycap" | "hint";
}) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        variant === "keycap" &&
          "inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-sm bg-current/10 px-1.5 font-sans text-caption tabular-nums text-current",
        variant === "hint" &&
          "inline-flex h-5 shrink-0 items-center justify-center rounded-[0.5rem] bg-selected px-1.5 font-sans text-caption font-medium text-ink",
        (variant === "default" || variant === "inline") &&
          "inline-flex items-center px-1 py-0.5 font-mono text-caption uppercase tracking-[0.16em] rounded-sm",
        variant === "inline" &&
          // currentColor-derived border so the chip stays legible inside colored buttons.
          // The `border-current/30` syntax uses Tailwind 4's color-mix with currentColor.
          "border border-current/30 text-current",
        variant === "default" && "text-muted/60 border border-border/40",
      )}
    >
      {children}
    </kbd>
  );
}
