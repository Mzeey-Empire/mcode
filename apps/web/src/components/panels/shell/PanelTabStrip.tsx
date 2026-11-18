import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { ChevronDown, Plus, X } from "lucide-react";
import { Button, IconButton } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { createTooltipHandle, Tooltip, TooltipContent, TooltipTrigger, type TooltipHandle } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { PanelToolGlyph } from "./PanelHeader";

/** One tab in a {@link PanelTabStrip}. */
export interface PanelTabStripItem {
  readonly id: string;
  readonly label: string;
  /** A 14px glyph. The close button takes its slot on the active tab, and on any tab with hover or focus. */
  readonly icon: ReactNode;
  /** Spoken after the label, because the icon is often replaced by the close button. */
  readonly status?: string;
  /** Close button name, when closing does more than "Close <label>" implies. */
  readonly closeLabel?: string;
  /** The close button's tooltip. Defaults to "Close tab"; set it when closing ends more than the tab. */
  readonly closeTooltip?: string;
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
  /** Id of the element that shows the active tab's content, announced as each tab's `aria-controls`. */
  readonly panelId?: string;
  /**
   * The tool's rail glyph and name, shown before the tabs. Tab labels name items, so without it a header full of
   * tabs never names the tool, while every single-view tool's title does.
   */
  readonly tool?: { readonly icon: ReactNode; readonly name: string };
}

/**
 * Tool tabs with a pinned add button. Inactive tabs shrink to 9.6rem with a text fade while the active tab keeps
 * its name. Past that, the strip shows only whole tabs around the active one and a labelled "N more" menu lists
 * every tab. When even the tool name, the active tab, and "N more" crowd the add button, the tool name goes (the
 * rail's selected entry still names the tool) and a chevron on the active tab opens the menu. See ADR-0026.
 *
 * A `tablist` with manual activation, because switching a tab mounts a terminal, page, or file:
 * arrows and Home/End move focus, Enter or Space selects, and Delete closes the focused tab.
 */
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
  panelId,
  tool,
}: PanelTabStripProps) {
  const stripRef = useRef<HTMLDivElement>(null);
  const tablistRef = useRef<HTMLDivElement>(null);
  const tabIdPrefix = useId();
  const fit = useTabStripFit(stripRef, tablistRef, items.length, activeId);
  const shown = useShownTabs(items, activeId, fit);
  const hiddenCount = items.length - shown.length;
  const activeShown = shown.some((item) => item.id === activeId);
  const menuOnActiveTab = fit.kind === "active-only" && activeShown && hiddenCount > 0;
  const closeByKey = useRefocusAfterKeyboardClose(tablistRef, items, onClose);
  const rovingId = activeShown ? activeId : (shown[0]?.id ?? null);
  // One tooltip root for every tab's close button, so hovering a tab never mounts a popup of its own.
  const [closeTooltip] = useState(() => createTooltipHandle<string>());
  const overflowMenu = (trigger: OverflowTrigger) => (
    <PanelTabOverflowMenu
      items={items}
      hiddenCount={hiddenCount}
      activeId={activeId}
      label={label}
      trigger={trigger}
      onSelect={onSelect}
    />
  );
  return (
    <div ref={stripRef} data-testid="panel-tab-strip" className="flex min-w-0 flex-1 items-center gap-2">
      {tool ? (
        // The tab list's own name says the same to assistive tech.
        <span aria-hidden data-panel-tool-heading hidden={fit.kind === "active-only" && !fit.toolName} className="flex shrink-0 items-center gap-2">
          <PanelToolGlyph>{tool.icon}</PanelToolGlyph>
          <span className="pr-1 text-sm/5 font-medium text-ink">{tool.name}</span>
        </span>
      ) : null}
      <div
        ref={tablistRef}
        role="tablist"
        aria-label={label}
        onKeyDown={moveTabFocus}
        className="flex min-w-0 items-center gap-1 overflow-hidden"
      >
        {shown.map((item) => (
          <PanelTab
            key={item.id}
            item={item}
            tabId={`${tabIdPrefix}tab-${encodeURIComponent(item.id)}`}
            panelId={panelId}
            active={item.id === activeId}
            focusable={item.id === rovingId}
            closeTooltip={closeTooltip}
            menu={menuOnActiveTab && item.id === activeId ? overflowMenu("chevron") : undefined}
            onSelect={onSelect}
            onClose={onClose}
            onCloseByKey={closeByKey}
          />
        ))}
      </div>
      <Tooltip handle={closeTooltip}>
        {({ payload }) => (payload ? <TooltipContent side="bottom">{payload}</TooltipContent> : null)}
      </Tooltip>
      {hiddenCount > 0 && !menuOnActiveTab ? overflowMenu("labelled") : null}
      <PanelTabAddButton label={addLabel} disabledReason={addDisabledReason} onAdd={onAdd} menu={addMenu} />
    </div>
  );
}

/** The "N more" button after the tabs, or a chevron inside the active tab when the strip has no room for that. */
type OverflowTrigger = "labelled" | "chevron";

/**
 * Lists every tab while some do not fit. The standalone button counts the hidden ones, because a bare chevron beside
 * the add button read as a profile picker, and a new user could not tell the hidden tabs existed. The chevron form
 * sits inside the active tab, so it reads as switching that tab, and still shows the count.
 */
function PanelTabOverflowMenu({
  items,
  hiddenCount,
  activeId,
  label,
  trigger,
  onSelect,
}: {
  readonly items: readonly PanelTabStripItem[];
  readonly hiddenCount: number;
  readonly activeId: string | null;
  readonly label: string;
  readonly trigger: OverflowTrigger;
  readonly onSelect: (id: string) => void;
}) {
  const name = `All ${label.toLowerCase()}, ${hiddenCount} more`;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          trigger === "chevron" ? (
            <IconButton
              size="inline-sm"
              aria-label={name}
              tooltip={`${hiddenCount} more`}
              // Above the tab's stretched hit area, like the close button. The count keeps two and five tabs from
              // looking alike, and it never shrinks: the tab label fades first.
              className="relative z-(--layer-sticky) size-auto h-6 shrink-0 gap-0.5 px-1.5 text-body-small font-medium tabular-nums"
            >
              <span aria-hidden>{hiddenCount}</span>
              <ChevronDown aria-hidden className="size-3.5" />
            </IconButton>
          ) : (
            <Button
              variant="subtle"
              shape="round"
              aria-label={name}
              data-tab-overflow=""
              className="shrink-0 gap-1 pr-2.5 pl-3 text-body-small font-medium"
            >
              {hiddenCount} more
              <ChevronDown aria-hidden className="size-3.5" />
            </Button>
          )
        }
      />
      <DropdownMenuContent align="end" sideOffset={6}>
        {items.map((item) => (
          <DropdownMenuItem
            key={item.id}
            label={item.label}
            icon={item.icon}
            checked={item.id === activeId}
            onClick={() => onSelect(item.id)}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const TAB_FOCUS_KEYS = new Set(["ArrowLeft", "ArrowRight", "Home", "End"]);

/** Where a focus key lands among `count` tabs from `current` (-1 when focus is outside), wrapping at the ends. */
function nextTabIndex(key: string, current: number, count: number): number {
  const last = count - 1;
  if (key === "Home") return 0;
  if (key === "End") return last;
  if (key === "ArrowLeft") return current <= 0 ? last : current - 1;
  return current < 0 || current === last ? 0 : current + 1;
}

/** Roving focus: moving focus never selects, so passing over a tab does not mount its content. */
function moveTabFocus(event: KeyboardEvent<HTMLDivElement>): void {
  if (!TAB_FOCUS_KEYS.has(event.key) || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]'));
  if (tabs.length === 0) return;
  event.preventDefault();
  tabs[nextTabIndex(event.key, tabs.indexOf(document.activeElement as HTMLElement), tabs.length)]?.focus();
}

/**
 * Closes a tab from the keyboard and, once the strip re-renders without it, puts focus back on
 * the roving tab if the close left focus nowhere. Without this, Delete strands focus on the body.
 */
function useRefocusAfterKeyboardClose(
  tablistRef: React.RefObject<HTMLDivElement | null>,
  items: readonly PanelTabStripItem[],
  onClose: (id: string) => void,
): (id: string) => void {
  const pendingRef = useRef(false);
  useEffect(() => {
    if (!pendingRef.current) return;
    pendingRef.current = false;
    const focused = document.activeElement;
    if (focused && focused !== document.body) return;
    tablistRef.current?.querySelector<HTMLElement>('[role="tab"][tabindex="0"]')?.focus();
  }, [tablistRef, items]);
  return (id) => {
    pendingRef.current = true;
    onClose(id);
  };
}

/** Inactive tabs never shrink below 9.6rem (96px at the 10px root), so each keeps its number and a readable start. */
const INACTIVE_TAB_MIN_PX = 96;
/** Room kept for the "N more" button before it has rendered once. */
const OVERFLOW_TRIGGER_ESTIMATE_PX = 96;

/**
 * How the strip spends its width, roomiest first: every tab; the tool name, the active tab, `inactive` whole tabs
 * around it, and "N more"; or the active tab alone with the menu folded into it, after the tool name while that
 * fits, its own name fading only if it still does not fit.
 */
type TabStripFit =
  | { readonly kind: "all" }
  | { readonly kind: "window"; readonly inactive: number }
  | { readonly kind: "active-only"; readonly toolName: boolean };

const FIT_ALL: TabStripFit = { kind: "all" };

/**
 * Natural widths of the parts that come and go. The tool name and "N more" are hidden in some fits, so their last
 * shown widths stand in; reading 0 for a hidden part would let the strip flip back to a fit that does not fit.
 */
interface HiddenPartWidths {
  heading: number;
  more: number;
}

/** The strip's width left for the tool name, the tabs, and "N more" once the add button is placed. */
function roomBesideAddButton(strip: HTMLElement, tablist: HTMLElement, widths: HiddenPartWidths): number {
  const gap = Number.parseFloat(getComputedStyle(strip).columnGap) || 0;
  let room = strip.clientWidth;
  for (const child of Array.from(strip.children) as HTMLElement[]) {
    if (child === tablist || child.offsetWidth === 0) continue;
    if (child.hasAttribute("data-panel-tool-heading")) widths.heading = child.offsetWidth + gap;
    else if (child.hasAttribute("data-tab-overflow")) widths.more = child.offsetWidth + gap;
    else room -= child.offsetWidth + gap;
  }
  return room;
}

function measureTabStripFit(
  strip: HTMLElement,
  tablist: HTMLElement,
  itemCount: number,
  widths: HiddenPartWidths,
): TabStripFit {
  // No layout yet (jsdom reports 0): show every tab.
  if (strip.clientWidth === 0) return FIT_ALL;
  const room = roomBesideAddButton(strip, tablist, widths) - widths.heading;
  const active = tablist.querySelector<HTMLElement>('[data-active="true"]');
  const activeWidth = active ? naturalWidth(active) : 0;
  const inactiveCount = itemCount - (active ? 1 : 0);
  const step = INACTIVE_TAB_MIN_PX + (Number.parseFloat(getComputedStyle(tablist).columnGap) || 0);
  if (activeWidth + inactiveCount * step <= room) return FIT_ALL;
  const spare = room - widths.more - activeWidth;
  if (spare < 0) return { kind: "active-only", toolName: activeWidth <= room };
  return { kind: "window", inactive: Math.min(inactiveCount, Math.floor(spare / step)) };
}

/** A tab's width with its whole label, even while the label is cut to fit. */
function naturalWidth(tab: HTMLElement): number {
  const label = tab.querySelector<HTMLElement>('[role="tab"]');
  return label ? tab.offsetWidth - label.offsetWidth + label.scrollWidth : tab.offsetWidth;
}

function useTabStripFit(
  stripRef: React.RefObject<HTMLDivElement | null>,
  tablistRef: React.RefObject<HTMLDivElement | null>,
  itemCount: number,
  activeId: string | null,
): TabStripFit {
  const [fit, setFit] = useState<TabStripFit>(FIT_ALL);
  const widthsRef = useRef<HiddenPartWidths>({ heading: 0, more: OVERFLOW_TRIGGER_ESTIMATE_PX });
  useLayoutEffect(() => {
    const strip = stripRef.current;
    const tablist = tablistRef.current;
    if (!strip || !tablist) return;
    const update = () => setFit(measureTabStripFit(strip, tablist, itemCount, widthsRef.current));
    update();
    if (typeof ResizeObserver === "undefined") return;
    // The active tab too: a longer name can leave the tab list's box the same size while it clips more.
    const observer = new ResizeObserver(update);
    observer.observe(strip);
    observer.observe(tablist);
    const active = tablist.querySelector('[data-active="true"]');
    if (active) observer.observe(active);
    return () => observer.disconnect();
  }, [stripRef, tablistRef, itemCount, activeId]);
  return fit;
}

/** The first shown tab: it holds still while the active tab stays in view, and moves just enough to show it. */
function tabWindowStart(count: number, activeIndex: number, size: number, previousStart: number): number {
  const clamp = (start: number) => Math.min(Math.max(start, 0), Math.max(0, count - size));
  if (activeIndex < 0) return clamp(previousStart);
  if (activeIndex < previousStart) return clamp(activeIndex);
  if (activeIndex >= previousStart + size) return clamp(activeIndex - size + 1);
  return clamp(previousStart);
}

/** The run of whole tabs the strip shows: all of them, or as many as fit around the active one. */
function useShownTabs(
  items: readonly PanelTabStripItem[],
  activeId: string | null,
  fit: TabStripFit,
): readonly PanelTabStripItem[] {
  const [start, setStart] = useState(0);
  if (fit.kind === "all") return items;
  const capacity = fit.kind === "window" ? fit.inactive : 0;
  const activeIndex = items.findIndex((item) => item.id === activeId);
  const size = Math.min(items.length, capacity + (activeIndex >= 0 ? 1 : 0));
  const next = tabWindowStart(items.length, activeIndex, size, start);
  if (next !== start) setStart(next);
  return items.slice(next, next + size);
}

function PanelTab({
  item,
  tabId,
  panelId,
  active,
  focusable,
  closeTooltip,
  menu,
  onSelect,
  onClose,
  onCloseByKey,
}: {
  readonly item: PanelTabStripItem;
  readonly tabId: string;
  readonly panelId: string | undefined;
  readonly active: boolean;
  /** The roving tab stop: the active tab, or the first one when none is active. */
  readonly focusable: boolean;
  readonly closeTooltip: TooltipHandle<string>;
  /** The all-tabs menu, shown after the label when the strip has no room for "N more". */
  readonly menu?: ReactNode;
  readonly onSelect: (id: string) => void;
  readonly onClose: (id: string) => void;
  readonly onCloseByKey: (id: string) => void;
}) {
  return (
    <div
      data-panel-tab={item.id}
      data-active={active ? "true" : undefined}
      // The header row drags the window and only buttons opt out. The pill's padding and the gap beside the
      // close button are drag area, so the OS drops hover as the pointer nears the X and the X hides.
      className={cn(
        // The active tab keeps its whole name and inactive tabs stop shrinking at 9.6rem, then the strip shows fewer tabs.
        // Shrinking every tab further to fit (r11) left "1 · po" and "2 · po", which three judges could not read.
        "window-no-drag group/tab relative flex h-8 items-center gap-2 rounded-control pl-2.5 text-sm/5 font-medium transition-[color,background-color]",
        menu ? "pr-1" : "pr-3",
        active
          ? "max-w-[min(24rem,100%)] shrink-0 bg-selected text-ink"
          : "min-w-[9.6rem] flex-[0_1_max-content] text-muted hover:bg-hover hover:text-ink",
      )}
    >
      <span className="relative grid size-3.5 shrink-0 place-items-center [&_svg]:size-3.5">
        <span
          className={cn(
            "grid place-items-center",
            active ? "invisible" : "group-focus-within/tab:invisible group-hover/tab:invisible",
          )}
        >
          {item.icon}
        </span>
        <TooltipTrigger
          handle={closeTooltip}
          payload={item.closeTooltip ?? "Close tab"}
          render={
            <button
              type="button"
              aria-label={item.closeLabel ?? `Close ${item.label}`}
              data-panel-tab-close
              // Delete on the focused tab closes it, so the × stays out of the tab order and Tab leaves the strip.
              tabIndex={-1}
              onClick={() => onClose(item.id)}
              // Above the tab's stretched hit area, so the swap target stays clickable.
              className={cn(
                "absolute inset-0 z-(--layer-sticky) grid place-items-center rounded-sm text-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-focus",
                active ? "visible" : "invisible focus-visible:visible group-focus-within/tab:visible group-hover/tab:visible",
              )}
            >
              <X />
            </button>
          }
        />
      </span>
      <button
        type="button"
        role="tab"
        id={tabId}
        aria-selected={active}
        aria-controls={panelId}
        tabIndex={focusable ? 0 : -1}
        onClick={() => onSelect(item.id)}
        onKeyDown={(event) => {
          if (event.key !== "Delete") return;
          event.preventDefault();
          onCloseByKey(item.id);
        }}
        className="text-fade min-w-0 text-left outline-none after:absolute after:inset-0 after:rounded-control focus-visible:after:outline-2 focus-visible:after:outline-focus"
      >
        {item.label}
        {item.status ? <span className="sr-only">, {item.status}</span> : null}
      </button>
      {menu}
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
