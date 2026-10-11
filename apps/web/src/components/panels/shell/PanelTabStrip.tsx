import { useEffect, useId, useRef, type ReactNode } from "react";
import { Plus, X } from "lucide-react";
import { IconButton } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** One tab in a {@link PanelTabStrip}. */
export interface PanelTabStripItem {
  readonly id: string;
  readonly label: string;
  /** A 14px glyph; hovering the tab swaps it for the close button. */
  readonly icon: ReactNode;
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
  /** Trailing content inside one tab, after its label (for example a status glyph). */
  readonly renderAdornment?: (item: PanelTabStripItem) => ReactNode;
}

/**
 * Row-1 tabs for a tool that holds several items (Terminal records, Browser
 * pages), followed by a round + that adds one. The strip scrolls horizontally
 * and fades its right edge while it overflows; the + stays pinned outside the
 * scroller. See ADR-0025.
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
  renderAdornment,
}: PanelTabStripProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  useScrollActiveTabIntoView(scrollerRef, activeId);
  return (
    <div data-testid="panel-tab-strip" className="flex min-w-0 flex-1 items-center gap-2">
      <div
        ref={scrollerRef}
        role="group"
        aria-label={label}
        className="scroll-fade-x flex min-w-0 items-center gap-1"
      >
        {items.map((item) => (
          <PanelTab
            key={item.id}
            item={item}
            active={item.id === activeId}
            onSelect={onSelect}
            onClose={onClose}
            adornment={renderAdornment?.(item)}
          />
        ))}
      </div>
      <PanelTabAddButton label={addLabel} disabledReason={addDisabledReason} onAdd={onAdd} />
    </div>
  );
}

function useScrollActiveTabIntoView(
  scrollerRef: React.RefObject<HTMLDivElement | null>,
  activeId: string | null,
): void {
  useEffect(() => {
    if (!activeId) return;
    const tab = scrollerRef.current?.querySelector<HTMLElement>(
      `[data-panel-tab="${CSS.escape(activeId)}"]`,
    );
    // jsdom has no scrollIntoView; real layouts keep a newly active tab visible.
    tab?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [scrollerRef, activeId]);
}

function PanelTab({
  item,
  active,
  adornment,
  onSelect,
  onClose,
}: {
  readonly item: PanelTabStripItem;
  readonly active: boolean;
  readonly adornment: ReactNode;
  readonly onSelect: (id: string) => void;
  readonly onClose: (id: string) => void;
}) {
  return (
    <div
      data-panel-tab={item.id}
      data-active={active ? "true" : undefined}
      className={cn(
        "group/tab relative flex h-8 max-w-60 shrink-0 items-center gap-2 rounded-control pr-3 pl-2.5 text-sm/5 font-medium transition-colors",
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
      </button>
      {adornment}
    </div>
  );
}

function PanelTabAddButton({
  label,
  disabledReason,
  onAdd,
}: {
  readonly label: string;
  readonly disabledReason: string | undefined;
  readonly onAdd: () => void;
}) {
  const reasonId = useId();
  const disabled = disabledReason !== undefined;
  return (
    <>
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
        onClick={disabled ? undefined : onAdd}
        className="shrink-0 aria-disabled:opacity-50"
      >
        <Plus />
      </IconButton>
      {disabled ? <span id={reasonId} hidden>{disabledReason}</span> : null}
    </>
  );
}
