/**
 * Renders a keyboard shortcut hint in mono small-caps style.
 * Used throughout the palette to display key combinations (e.g. ⌘K, Ctrl+Enter).
 */
export function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="px-1 py-0.5 font-mono text-[10.5px] uppercase tracking-[0.16em] text-muted-foreground/60 border border-border/40 rounded-sm">
      {children}
    </kbd>
  );
}
