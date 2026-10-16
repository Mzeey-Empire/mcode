import { useEffect, useId, useRef, useState, type ReactElement, type ReactNode, type WheelEvent } from "react";
import { ChevronLeft, ChevronRight, Plus, X } from "lucide-react";
import { IconButton } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** One tab in a {@link PanelTabStrip}. */
export interface PanelTabStripItem {
  readonly id: string;
  readonly label: string;
  /** A 14px glyph; hovering the tab swaps it for the close button. */
  readonly icon: ReactNode;
  /** Spoken after the label, because the icon is hidden while the tab has focus or hover. */
  readonly status?: string;
}

/** Props for {@link PanelTabStrip}. */
export interface PanelTabStripProps {
  readonly items: readonly PanelTabStripItem[];
  readonly activeId: string | null;
  /** Accessible name for the strip, such as "Terminals". */
  readonly label: string;
  /** Accessible name and tooltip for the + button, such as "New terminal". */
  readonly addLabel: string;
  /** When set, the + button is disabled and this explains why in its tooltip. */
  readonly addDisabledReason?: string;
  readonly onSelect: (id: string) => void;
  readonly onClose: (id: string) => void;
  readonly onAdd: () => void;
  /**
   * Wraps the + button in a menu that opens from it. The button then only opens the menu, so
   * `onAdd` and `addDisabledReason` stop applying and each menu row explains its own limits.
   */
  readonly addMenu?: (trigger: ReactElement) => ReactElement;
  /** Browser tabs shrink to 96px and omit scroll chevrons. Defaults to "default". */
  readonly appearance?: PanelTabStripAppearance;
}

/** Sizing contract for a {@link PanelTabStrip}. */
export type PanelTabStripAppearance = "default" | "browser";

/** Tool tabs with a pinned add button and scrolling overflow. See ADR-0026. */
export function PanelTabStrip({
  items,
  activeId,
  label,
  addLabel,
  addDisabledReason,
  onSelect,
  onClose,
  onAdd,
  addMenu,
  appearance = "default",
}: PanelTabStripProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  useScrollActiveTabIntoView(scrollerRef, activeId);
  const overflow = useHorizontalOverflow(scrollerRef, items);
  const showChevrons = appearance === "default" && (overflow.start || overflow.end);
  return (
    <div data-testid="panel-tab-strip" className="flex min-w-0 flex-1 items-center gap-2">
      <div className="flex min-w-0 items-center">
        {showChevrons ? (
          <PanelTabScrollButton direction="start" disabled={!overflow.start} scrollerRef={scrollerRef} />
        ) : null}
        <div
          ref={scrollerRef}
          role="group"
          aria-label={label}
          data-overflow-start={overflow.start || undefined}
          data-overflow-end={overflow.end || undefined}
          onWheel={scrollVerticalWheelSideways}
          className="scroll-fade-x flex min-w-0 items-center gap-1"
        >
          {items.map((item) => (
            <PanelTab
              key={item.id}
              item={item}
              active={item.id === activeId}
              appearance={appearance}
              onSelect={onSelect}
              onClose={onClose}
            />
          ))}
        </div>
        {showChevrons ? (
          <PanelTabScrollButton direction="end" disabled={!overflow.end} scrollerRef={scrollerRef} />
        ) : null}
      </div>
      <PanelTabAddButton label={addLabel} disabledReason={addDisabledReason} onAdd={onAdd} menu={addMenu} />
    </div>
  );
}

/** Which ends of a horizontal scroller hide content. */
interface HorizontalOverflow {
  readonly start: boolean;
  readonly end: boolean;
}

const NO_OVERFLOW: HorizontalOverflow = { start: false, end: false };

function measureOverflow(scroller: HTMLElement): HorizontalOverflow {
  // Fractional scroll offsets on scaled displays leave up to a pixel of slack.
  const start = scroller.scrollLeft > 1;
  const end = scroller.scrollLeft + scroller.clientWidth < scroller.scrollWidth - 1;
  return { start, end };
}

function useHorizontalOverflow(
  scrollerRef: React.RefObject<HTMLDivElement | null>,
  items: readonly PanelTabStripItem[],
): HorizontalOverflow {
  const [overflow, setOverflow] = useState<HorizontalOverflow>(NO_OVERFLOW);
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const update = () => {
      const next = measureOverflow(scroller);
      setOverflow((prev) => (prev.start === next.start && prev.end === next.end ? prev : next));
    };
    update();
    scroller.addEventListener("scroll", update, { passive: true });
    if (typeof ResizeObserver === "undefined") {
      return () => scroller.removeEventListener("scroll", update);
    }
    // Watching the tabs too catches label changes that widen the content without resizing the strip.
    const observer = new ResizeObserver(update);
    observer.observe(scroller);
    for (const tab of scroller.children) observer.observe(tab);
    return () => {
      scroller.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, [scrollerRef, items]);
  return overflow;
}

/** Mouse wheels only scroll vertically, so a plain wheel turn moves the strip sideways. */
function scrollVerticalWheelSideways(event: WheelEvent<HTMLDivElement>): void {
  if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
  event.currentTarget.scrollLeft += event.deltaY;
}

/** A tab's horizontal extent in the scroller's content coordinates. */
interface TabSpan {
  readonly left: number;
  readonly right: number;
}

function tabSpan(scroller: HTMLElement, tab: HTMLElement): TabSpan {
  const origin = scroller.getBoundingClientRect().left - scroller.scrollLeft;
  const rect = tab.getBoundingClientRect();
  return { left: rect.left - origin, right: rect.right - origin };
}

/**
 * The scroll offset closest to `current` that shows the whole span clear of the
 * edge fades (the scroller's scroll-padding), within the scrollable range. A span
 * too wide to clear the fades is fitted to the bare box instead, and one wider than
 * the box shows its start. The browser's own `inline: "nearest"` cannot be used: it
 * leaves a tab wider than the box where it is, so a narrow strip would never move.
 */
function scrollLeftShowing(span: TabSpan, current: number, scroller: HTMLElement): number {
  const fade = Number.parseFloat(getComputedStyle(scroller).scrollPaddingInlineStart) || 0;
  const range = (pad: number) => ({ min: span.right - scroller.clientWidth + pad, max: span.left - pad });
  const padded = range(fade);
  const { min, max } = padded.min <= padded.max ? padded : range(0);
  const wanted = min > max ? max : Math.min(Math.max(current, min), max);
  return Math.min(Math.max(wanted, 0), scroller.scrollWidth - scroller.clientWidth);
}

/** Moves to the nearest tab in `direction` that the scroller's box cuts off. */
function revealNextHiddenTab(scroller: HTMLElement, direction: "start" | "end"): void {
  const current = scroller.scrollLeft;
  const viewEnd = current + scroller.clientWidth;
  const spans = [...scroller.querySelectorAll<HTMLElement>("[data-panel-tab]")].map((tab) => tabSpan(scroller, tab));
  const hidden =
    direction === "end"
      ? spans.filter((span) => span.right > viewEnd + 1)
      : spans.filter((span) => span.left < current - 1).reverse();
  // A tab wider than the strip may already sit as far in as it can; skip to one that moves,
  // and once none does, finish at the edge so the chevron can always reach it.
  const edge = direction === "end" ? scroller.scrollWidth - scroller.clientWidth : 0;
  const next =
    hidden.map((span) => scrollLeftShowing(span, current, scroller)).find((left) => Math.abs(left - current) > 1) ??
    edge;
  scroller.scrollTo({ left: next, behavior: "smooth" });
}

function PanelTabScrollButton({
  direction,
  disabled,
  scrollerRef,
}: {
  readonly direction: "start" | "end";
  readonly disabled: boolean;
  readonly scrollerRef: React.RefObject<HTMLDivElement | null>;
}) {
  const scroll = () => {
    const scroller = scrollerRef.current;
    if (scroller) revealNextHiddenTab(scroller, direction);
  };
  return (
    <IconButton
      size="inline-sm"
      aria-label={direction === "start" ? "Scroll tabs left" : "Scroll tabs right"}
      disabled={disabled}
      data-testid={`panel-tab-scroll-${direction}`}
      onClick={scroll}
      className="shrink-0"
    >
      {direction === "start" ? <ChevronLeft /> : <ChevronRight />}
    </IconButton>
  );
}

function useScrollActiveTabIntoView(
  scrollerRef: React.RefObject<HTMLDivElement | null>,
  activeId: string | null,
): void {
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!activeId || !scroller) return;
    const reveal = () => {
      const tab = scroller.querySelector<HTMLElement>(`[data-panel-tab="${CSS.escape(activeId)}"]`);
      if (tab) scroller.scrollLeft = scrollLeftShowing(tabSpan(scroller, tab), scroller.scrollLeft, scroller);
    };
    reveal();
    if (typeof ResizeObserver === "undefined") return;
    // Resizing the panel narrows the strip without changing the active tab.
    const observer = new ResizeObserver(reveal);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [scrollerRef, activeId]);
}

const TAB_SIZING: Readonly<Record<PanelTabStripAppearance, { readonly active: string; readonly inactive: string }>> = {
  default: {
    active: "max-w-[min(24rem,100%)] min-w-0 shrink-0",
    inactive: "max-w-60 min-w-28 shrink",
  },
  browser: {
    active: "max-w-full min-w-0 shrink-0",
    inactive: "min-w-24 flex-[0_1_max-content]",
  },
};

function PanelTab({
  item,
  active,
  appearance,
  onSelect,
  onClose,
}: {
  readonly item: PanelTabStripItem;
  readonly active: boolean;
  readonly appearance: PanelTabStripAppearance;
  readonly onSelect: (id: string) => void;
  readonly onClose: (id: string) => void;
}) {
  return (
    <div
      data-panel-tab={item.id}
      data-active={active ? "true" : undefined}
      className={cn(
        "group/tab relative flex h-8 items-center gap-2 rounded-control pr-3 pl-2.5 text-sm/5 font-medium transition-colors",
        active ? TAB_SIZING[appearance].active : TAB_SIZING[appearance].inactive,
        active ? "bg-selected text-ink" : "text-muted hover:bg-hover hover:text-ink",
      )}
    >
      <span className="relative grid size-3.5 shrink-0 place-items-center [&_svg]:size-3.5">
        <span className="grid place-items-center group-focus-within/tab:invisible group-hover/tab:invisible">
          {item.icon}
        </span>
        <button
          type="button"
          aria-label={`Close ${item.label}`}
          data-panel-tab-close
          onClick={() => onClose(item.id)}
          // Above the select button's stretched hit area, so the swap target stays clickable.
          className="invisible absolute inset-0 z-(--layer-sticky) grid place-items-center rounded-sm text-muted hover:text-ink focus-visible:visible focus-visible:outline-2 focus-visible:outline-focus group-focus-within/tab:visible group-hover/tab:visible"
        >
          <X />
        </button>
      </span>
      <button
        type="button"
        aria-pressed={active}
        onClick={() => onSelect(item.id)}
        className="text-fade min-w-0 text-left outline-none after:absolute after:inset-0 after:rounded-control focus-visible:after:outline-2 focus-visible:after:outline-focus"
      >
        {item.label}
        {item.status ? <span className="sr-only">, {item.status}</span> : null}
      </button>
    </div>
  );
}

function PanelTabAddButton({
  label,
  disabledReason,
  onAdd,
  menu,
}: {
  readonly label: string;
  readonly disabledReason: string | undefined;
  readonly onAdd: () => void;
  readonly menu: ((trigger: ReactElement) => ReactElement) | undefined;
}) {
  const reasonId = useId();
  const disabled = menu === undefined && disabledReason !== undefined;
  const button = (
    <IconButton
      shape="round"
      aria-label={label}
      tooltip={disabledReason ?? label}
      aria-describedby={disabled ? reasonId : undefined}
      // Stay hoverable while disabled so the tooltip can say why. The tooltip
      // trigger drops Base UI's aria-disabled, so it is set here directly.
      disabled={disabled}
      focusableWhenDisabled
      aria-disabled={disabled || undefined}
      data-testid="panel-tab-add"
      onClick={menu || disabled ? undefined : onAdd}
      className="shrink-0 aria-disabled:opacity-50"
    >
      <Plus />
    </IconButton>
  );
  return (
    <>
      {menu ? menu(button) : button}
      {disabled ? <span id={reasonId} hidden>{disabledReason}</span> : null}
    </>
  );
}
