import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { MENU_LIST_CLASS, MENU_ROW_CLASS, MENU_ROW_DISABLED_CLASS, MENU_SEPARATOR_CLASS, MenuRowBody } from "./menu-row";
import { POPOVER_SURFACE_CLASS } from "./overlay-surface";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

/** One context menu row: an action that closes the menu, or a divider when `divider` is set. */
export interface ContextMenuItem {
  label: string;
  onClick: () => void;
  icon?: ReactNode;
  destructive?: boolean;
  divider?: boolean;
  /** Shown as a tooltip while the row is disabled. A row with a reason is disabled. */
  disabledReason?: string | null;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
  /**
   * The element the menu was opened on. Scrolling a container that holds it closes the menu, which
   * has no way to follow it. Without an anchor, scrolling never closes the menu.
   */
  anchor?: Element;
}

function ActionRow({ item, onClose }: { item: ContextMenuItem; onClose: () => void }) {
  const disabled = Boolean(item.disabledReason);
  const row = (
    <button
      onClick={(e) => {
        e.stopPropagation();
        if (disabled) return;
        item.onClick();
        onClose();
      }}
      type="button"
      role="menuitem"
      aria-disabled={disabled || undefined}
      data-disabled={disabled ? "" : undefined}
      className={cn(MENU_ROW_CLASS, MENU_ROW_DISABLED_CLASS, !disabled && "hover:bg-hover")}
    >
      <MenuRowBody label={item.label} icon={item.icon} destructive={item.destructive} />
    </button>
  );
  if (!disabled) return row;
  return (
    <Tooltip>
      <TooltipTrigger render={row} />
      <TooltipContent side="right">{item.disabledReason}</TooltipContent>
    </Tooltip>
  );
}

/** Renders a pointer-positioned menu above application layout boundaries. */
export function ContextMenu({ x, y, items, onClose, anchor }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && ref.current?.contains(event.target)) return;
      onClose();
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // Scroll does not bubble, so a capture listener is the only way to hear every scroller. Other
    // scrollers, such as a streaming transcript, move constantly and must not close the menu.
    const handleScroll = (event: Event) => {
      if (anchor && event.target instanceof Node && event.target.contains(anchor)) onClose();
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleEscape);
    document.addEventListener("scroll", handleScroll, { capture: true, passive: true });
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleEscape);
      document.removeEventListener("scroll", handleScroll, { capture: true });
    };
  }, [onClose, anchor]);

  // Adjust position to stay within viewport
  useEffect(() => {
    if (ref.current) {
      const rect = ref.current.getBoundingClientRect();
      if (rect.right > window.innerWidth) {
        ref.current.style.left = `${window.innerWidth - rect.width - 8}px`;
      }
      if (rect.bottom > window.innerHeight) {
        ref.current.style.top = `${window.innerHeight - rect.height - 8}px`;
      }
    }
  }, [x, y]);

  return createPortal(
    <div
      ref={ref}
      style={{ position: "fixed", left: x, top: y, zIndex: "var(--layer-modal)" }}
      role="menu"
      className={cn("min-w-[160px]", MENU_LIST_CLASS, POPOVER_SURFACE_CLASS)}
    >
      {items.map((item, i) =>
        item.divider ? (
          <div
            key={i}
            role="separator"
            className={MENU_SEPARATOR_CLASS}
          />
        ) : (
          <ActionRow key={i} item={item} onClose={onClose} />
        )
      )}
    </div>,
    document.body,
  );
}
