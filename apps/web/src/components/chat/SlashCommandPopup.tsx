import { useEffect, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn } from "@/lib/utils";
import { Terminal, Zap, Puzzle, Sparkles, RefreshCw } from "lucide-react";
import { NAMESPACE_BADGE_STYLES } from "@/lib/slash-command-styles";
import type { Command } from "./useSlashCommand";

const ITEM_HEIGHT = 44; // px per row
const VISIBLE_ITEMS = 8;
const VIRTUAL_THRESHOLD = 20; // use virtual scroll only above this count
// Footer (Refresh row) intrinsic height: border-t (1px) + py-1 (8px) + icon
// button height (~20px). Used to estimate popup height for the above/below
// placement calculation; the rendered footer remains naturally sized.
const FOOTER_HEIGHT = 28;

/** Props for the {@link SlashCommandPopup} component. */
interface SlashCommandPopupProps {
  isOpen: boolean;
  isLoading: boolean;
  items: Command[];
  selectedIndex: number;
  anchorRect: DOMRect | null;
  error: Error | null;
  onSelect: (cmd: Command) => void;
  onDismiss: () => void;
  onRetry: () => void;
}

/**
 * Floating popup that lists slash command suggestions anchored to the
 * composer editor. Handles keyboard navigation via `selectedIndex`, virtualises
 * long lists past `VIRTUAL_THRESHOLD`, flips above/below the anchor based on
 * available viewport space, and dismisses on outside click. Render priority is
 * error → list → inline loader → empty state.
 */
export function SlashCommandPopup({
  isOpen,
  isLoading,
  items,
  selectedIndex,
  anchorRect,
  error,
  onSelect,
  onDismiss,
  onRetry,
}: SlashCommandPopupProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: items.length > VIRTUAL_THRESHOLD ? items.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ITEM_HEIGHT,
    overscan: 2,
  });

  // Scroll selected item into view
  useEffect(() => {
    if (!isOpen) return;
    if (items.length > VIRTUAL_THRESHOLD) {
      virtualizer.scrollToIndex(selectedIndex, { align: "auto" });
    } else {
      const el = scrollRef.current?.querySelector(`[data-index="${selectedIndex}"]`);
      el?.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex, isOpen, items.length, virtualizer]);

  // Dismiss on outside click
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: MouseEvent) => {
      if (!(e.target as Element).closest("[data-slash-popup]")) {
        onDismiss();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [isOpen, onDismiss]);

  if (!isOpen || !anchorRect) return null;

  // Cap the scrollable list at VISIBLE_ITEMS rows; shorter lists size to
  // their natural content so a popup with two items isn't truncated.
  const listMaxHeight = VISIBLE_ITEMS * ITEM_HEIGHT;

  // Estimate the rendered popup height for the above/below placement
  // decision. Only the list branch renders a footer (Refresh row); error,
  // inline-loading, and empty branches do not. Including FOOTER_HEIGHT in
  // those cases would cause unnecessary above-placement flips.
  const willRenderList = !error && items.length > 0;
  const estimatedHeight =
    Math.min(items.length, VISIBLE_ITEMS) * ITEM_HEIGHT +
    (willRenderList ? FOOTER_HEIGHT : 0);
  const spaceAbove = anchorRect.top;
  const placeAbove = spaceAbove > estimatedHeight + 8;

  const style: React.CSSProperties = {
    position: "fixed",
    left: anchorRect.left,
    width: Math.max(anchorRect.width, 320),
    ...(placeAbove
      ? { bottom: window.innerHeight - anchorRect.top + 4 }
      : { top: anchorRect.bottom + 4 }),
  };

  const useVirtual = items.length > VIRTUAL_THRESHOLD;

  return (
    // role="listbox" is intentionally NOT on this outer wrapper: the
    // Refresh footer button and the ErrorRow's Retry button live inside
    // and would be invalid descendants of a listbox per WAI-ARIA. The
    // role is moved down to the options container only.
    <div
      data-slash-popup
      style={style}
      className={cn(
        "z-50 overflow-hidden rounded-lg border border-border bg-card shadow-lg",
        "animate-in fade-in-0 zoom-in-95 duration-[120ms]",
      )}
    >
      {/*
        Render priority (stale-while-revalidate):
          1. error -> ErrorRow  (unchanged; surfaces transient failures even
             when built-in commands are present, preserving the explicit
             "loading failed" signal validated by the slash-command E2E)
          2. items.length > 0 -> list  (built-ins are always available, so
             this branch wins on cold start, workspace switches, and cache
             invalidations; the loading skeleton is unreachable in normal use)
          3. isLoading -> inline "Loading commands..."  (only hit when a
             filter yields zero matches AND skills are still arriving;
             replaces the 3-row skeleton with a single quiet row)
          4. EmptyState  (no matches, not loading, no error)
      */}
      {error ? (
        <ErrorRow message={error.message} onRetry={onRetry} />
      ) : items.length > 0 ? (
        <>
          <div
            ref={scrollRef}
            role="listbox"
            aria-label="Slash commands"
            aria-activedescendant={items[selectedIndex] ? `slash-cmd-${items[selectedIndex].name}` : undefined}
            style={{ maxHeight: listMaxHeight, overflowY: "auto" }}
          >
            {useVirtual ? (
              <div role="presentation" style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
                {virtualizer.getVirtualItems().map((vi) => (
                  <div
                    key={vi.key}
                    role="presentation"
                    style={{ position: "absolute", top: vi.start, width: "100%", height: vi.size }}
                    data-index={vi.index}
                  >
                    <CommandRow
                      cmd={items[vi.index]}
                      selected={vi.index === selectedIndex}
                      onSelect={onSelect}
                    />
                  </div>
                ))}
              </div>
            ) : (
              items.map((cmd, i) => (
                <div key={cmd.name} role="presentation" data-index={i}>
                  <CommandRow
                    cmd={cmd}
                    selected={i === selectedIndex}
                    onSelect={onSelect}
                  />
                </div>
              ))
            )}
          </div>
          <div className="flex items-center justify-end border-t border-border px-2 py-1">
            <button
              type="button"
              aria-label="Refresh commands"
              // onMouseDown preventDefault keeps editor focus on pointer use;
              // onClick fires on both pointer and keyboard activation (Enter/Space).
              onMouseDown={(e) => e.preventDefault()}
              onClick={onRetry}
              className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <RefreshCw size={12} />
            </button>
          </div>
        </>
      ) : isLoading ? (
        <LoadingInline />
      ) : (
        <EmptyState />
      )}
    </div>
  );
}

function CommandRow({
  cmd,
  selected,
  onSelect,
}: {
  cmd: Command;
  selected: boolean;
  onSelect: (cmd: Command) => void;
}) {
  return (
    <button
      type="button"
      id={`slash-cmd-${cmd.name}`}
      role="option"
      aria-selected={selected}
      onMouseDown={(e) => {
        e.preventDefault(); // prevent textarea blur
        onSelect(cmd);
      }}
      className={cn(
        "flex w-full items-center gap-3 px-3 py-2 text-left transition-colors",
        selected
          ? "bg-accent"
          : "hover:bg-accent/50",
      )}
    >
      {/* Icon column */}
      <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center text-muted-foreground">
        {cmd.namespace === "mcode" ? (
          <Zap size={12} />
        ) : cmd.namespace === "plugin" ? (
          <Puzzle size={12} />
        ) : cmd.namespace === "skill" ? (
          <Sparkles size={12} />
        ) : (
          <Terminal size={12} />
        )}
      </span>

      {/* Name + description */}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium text-foreground">
          /{cmd.name}
        </span>
        <span className="truncate text-xs text-muted-foreground">
          {cmd.description}
        </span>
      </span>

      {/* Namespace badge */}
      <span
        className={cn(
          "ml-auto flex-shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium",
          NAMESPACE_BADGE_STYLES[cmd.namespace],
        )}
      >
        {cmd.namespace}
      </span>
    </button>
  );
}

/**
 * Single-row "Loading commands..." indicator. Replaces the previous 3-row
 * skeleton-shimmer block. The skeleton was visually noisy and triggered on
 * every cold start, workspace switch, and cache-invalidation push; with the
 * stale-while-revalidate render order in this component plus the eager
 * prefetch in `useSlashCommand`, this branch should only be reachable when
 * the user has typed a filter that excludes every cached built-in AND a
 * skill load is still in flight -- an exceedingly rare combination.
 */
function LoadingInline() {
  return (
    <div
      aria-busy="true"
      aria-live="polite"
      role="status"
      className="flex items-center gap-3 px-3 py-2"
    >
      <span className="flex h-5 w-5 flex-shrink-0" />
      <span className="text-sm text-muted-foreground">Loading commands...</span>
    </div>
  );
}

function EmptyState() {
  return (
    <div aria-live="polite" role="status" className="flex items-center gap-3 px-3 py-2">
      <span className="flex h-5 w-5 flex-shrink-0" /> {/* icon placeholder */}
      <span className="text-sm text-muted-foreground">No commands match</span>
    </div>
  );
}

function ErrorRow({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="alert" className="flex items-center gap-2 px-3 py-2 text-xs text-destructive">
      <span className="flex-1 truncate">Couldn't load commands: {message}</span>
      <button
        type="button"
        // Same pattern as the footer Refresh button: preventDefault on
        // mousedown to retain editor focus, action on click for keyboard a11y.
        onMouseDown={(e) => e.preventDefault()}
        onClick={onRetry}
        className="rounded px-2 py-0.5 text-foreground hover:bg-accent"
      >
        Retry
      </button>
    </div>
  );
}
