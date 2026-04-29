import { useMemo } from "react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { useUiStore } from "@/stores/uiStore";
import { getAllCommands } from "@/lib/command-registry";
import {
  getKeybindingForCommand,
  formatKeybinding,
} from "@/lib/keybinding-manager";
import { isMac } from "@/lib/platform";
import { Kbd } from "@/components/palette/Kbd";

/** Single shortcut entry as rendered in the dialog. */
interface ShortcutRow {
  /** Stable react key — derived from command id (or a synthetic id for collapsed rows). */
  key: string;
  /** Human-readable command title. */
  title: string;
  /**
   * Pre-split keybinding pieces, in display order. For combos like "Ctrl+K" this is
   * `["Ctrl", "K"]`; for ranges like the Go-to-thread block it's `[...modifiers, "1", "9"]`.
   */
  pieces: string[];
}

/**
 * Categories render in this order. Anything not listed falls through to
 * alphabetical order at the end. Keeps the dialog visually predictable.
 */
const CATEGORY_ORDER = ["Project", "Thread", "Navigation", "View", "Help"];

/** Strip surrounding whitespace and split a formatted keybinding on the `+` separator. */
function splitCombo(shortcut: string): string[] {
  return shortcut
    .split("+")
    .map((piece) => piece.trim())
    .filter(Boolean);
}

/**
 * Full-screen dialog showing all keyboard shortcuts grouped by category.
 * Accessible via Cmd+? or from the command palette.
 */
export function ShortcutHelpDialog() {
  const open = useUiStore((s) => s.shortcutHelpOpen);
  const setOpen = useUiStore((s) => s.setShortcutHelpOpen);

  const grouped = useMemo(() => {
    if (!open) return new Map<string, ShortcutRow[]>();

    const all = getAllCommands();
    // Escape handler is an internal command, not meaningful to surface to users.
    const hidden = new Set(["escape.handle"]);
    const map = new Map<string, ShortcutRow[]>();

    // Collect `thread.goTo1`…`thread.goTo9` separately so we only collapse them
    // into the single "Go to thread (1…9)" row when all nine bindings are
    // uniform — same modifier prefix, numeric tail "1"…"9", same category.
    // Customised or partial bindings fall back to individual rows so the help
    // dialog can't lie about what the user actually typed.
    const goToThreadRe = /^thread\.goTo([1-9])$/;
    const goToThreadCandidates: Array<{
      digit: string;
      title: string;
      category: string;
      pieces: string[];
    }> = [];

    for (const cmd of all) {
      if (hidden.has(cmd.id)) continue;
      const binding = getKeybindingForCommand(cmd.id);
      if (!binding) continue;

      const goToMatch = goToThreadRe.exec(cmd.id);
      if (goToMatch) {
        goToThreadCandidates.push({
          digit: goToMatch[1],
          title: cmd.title,
          category: cmd.category,
          pieces: splitCombo(formatKeybinding(binding.key, isMac)),
        });
        continue;
      }

      const group = map.get(cmd.category) ?? [];
      group.push({
        key: cmd.id,
        title: cmd.title,
        pieces: splitCombo(formatKeybinding(binding.key, isMac)),
      });
      map.set(cmd.category, group);
    }

    if (goToThreadCandidates.length > 0) {
      const first = goToThreadCandidates[0];
      const sharedModifiers = first.pieces.slice(0, -1).join("+");
      const uniform =
        goToThreadCandidates.length === 9 &&
        goToThreadCandidates.every((c, i) => c.digit === String(i + 1)) &&
        goToThreadCandidates.every((c) => c.category === first.category) &&
        goToThreadCandidates.every((c) => c.pieces.length >= 2) &&
        goToThreadCandidates.every(
          (c, i) =>
            c.pieces.slice(0, -1).join("+") === sharedModifiers &&
            c.pieces[c.pieces.length - 1] === String(i + 1),
        );

      if (uniform) {
        const group = map.get(first.category) ?? [];
        group.push({
          key: "thread.goTo.range",
          title: "Go to thread",
          pieces: [...first.pieces.slice(0, -1), "1", "9"],
        });
        map.set(first.category, group);
      } else {
        // Non-uniform bindings — render each one individually so the dialog
        // shows the user's actual configuration.
        for (const c of goToThreadCandidates) {
          const group = map.get(c.category) ?? [];
          group.push({
            key: `thread.goTo${c.digit}`,
            title: c.title,
            pieces: c.pieces,
          });
          map.set(c.category, group);
        }
      }
    }

    // Sort each category alphabetically by title for stability.
    for (const rows of map.values()) {
      rows.sort((a, b) => a.title.localeCompare(b.title));
    }

    return map;
  }, [open]);

  const orderedCategories = useMemo(() => {
    const present = Array.from(grouped.keys());
    const known = CATEGORY_ORDER.filter((c) => present.includes(c));
    const unknown = present.filter((c) => !CATEGORY_ORDER.includes(c)).sort();
    return [...known, ...unknown];
  }, [grouped]);

  const totalCount = useMemo(() => {
    let total = 0;
    for (const rows of grouped.values()) total += rows.length;
    return total;
  }, [grouped]);

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => setOpen(nextOpen)}>
      <DialogContent
        className="flex max-h-[85vh] w-full max-w-xl flex-col gap-0 overflow-hidden p-0 sm:max-w-xl"
        showCloseButton
      >
        {/* Sticky header — editorial label-then-title pattern matching the palette. */}
        <div className="flex flex-col gap-1 border-b border-border/40 px-6 py-5">
          <span className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-muted-foreground/60">
            Reference
          </span>
          <DialogTitle className="font-heading text-lg leading-tight tracking-tight">
            Keyboard shortcuts
          </DialogTitle>
        </div>

        {/* Scrollable body. */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          <div className="flex flex-col gap-7">
            {orderedCategories.map((category) => {
              const rows = grouped.get(category);
              if (!rows || rows.length === 0) return null;
              return (
                <section key={category} className="flex flex-col gap-2.5">
                  <h3 className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-muted-foreground/70">
                    {category}
                  </h3>
                  <ul className="flex flex-col">
                    {rows.map((row) => (
                      <li
                        key={row.key}
                        className="flex items-center justify-between gap-4 border-t border-border/30 py-2.5 first:border-t-0"
                      >
                        <span className="text-sm text-foreground/90">
                          {row.title}
                        </span>
                        <ShortcutPieces row={row} />
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
        </div>

        {/* Footer rail — mirrors the palette's bottom hint area. */}
        <div className="flex items-center justify-between border-t border-border/40 px-6 py-3">
          <span className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-muted-foreground/60">
            {totalCount === 0 ? "No shortcuts" : `${totalCount} shortcuts`}
          </span>
          <span className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground/70">
            <Kbd>Esc</Kbd>
            <span>to close</span>
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Renders the right-aligned key combo for a row. Each `piece` becomes its own
 * `Kbd` chip, separated by a hairline `+` (or `…` for the gap before the
 * final piece when the row is the collapsed Go-to-thread range).
 */
function ShortcutPieces({ row }: { row: ShortcutRow }) {
  const isRange = row.key === "thread.goTo.range";
  return (
    <span className="flex items-center gap-1">
      {row.pieces.map((piece, idx) => {
        const isLast = idx === row.pieces.length - 1;
        const separator = isRange && idx === row.pieces.length - 2 ? "\u2026" : "+";
        return (
          <span key={`${piece}-${idx}`} className="flex items-center gap-1">
            <Kbd>{piece}</Kbd>
            {!isLast && (
              <span
                aria-hidden
                className="text-[11px] leading-none text-muted-foreground/40"
              >
                {separator}
              </span>
            )}
          </span>
        );
      })}
    </span>
  );
}
