import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { MENU_LIST_CLASS, MENU_ROW_CLASS, MENU_ROW_DISABLED_CLASS, MenuRowBody } from "./menu-row";
import { POPOVER_SURFACE_CLASS } from "./overlay-surface";
import { Switch } from "./switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

interface ActionMenuItem {
  kind?: "action";
  label: string;
  onClick: () => void;
  icon?: ReactNode;
  destructive?: boolean;
  divider?: boolean;
}

/** A switch row whose toggles keep the menu open. */
export interface SwitchMenuItem {
  kind: "switch";
  label: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  icon?: ReactNode;
  /** Shown as a tooltip while the row is disabled. A row with a reason is disabled. */
  disabledReason?: string | null;
  /** A muted second line, such as why the last toggle did not save. */
  description?: string;
}

/** One context menu row: an action that closes the menu, a divider, or a switch. */
export type ContextMenuItem = ActionMenuItem | SwitchMenuItem;

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

function SwitchRow({ item }: { item: SwitchMenuItem }) {
  const disabled = Boolean(item.disabledReason);
  const row = (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={item.checked}
      aria-disabled={disabled || undefined}
      data-disabled={disabled ? "" : undefined}
      onClick={(event) => {
        event.stopPropagation();
        if (!disabled) item.onCheckedChange(!item.checked);
      }}
      className={cn(MENU_ROW_CLASS, MENU_ROW_DISABLED_CLASS, item.description && "h-auto py-2", !disabled && "hover:bg-hover")}
    >
      <MenuRowBody
        label={item.label}
        description={item.description}
        icon={item.icon}
        trailing={<Switch checked={item.checked} disabled={disabled} readOnly aria-hidden tabIndex={-1} className="pointer-events-none" />}
      />
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
export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && ref.current?.contains(event.target)) return;
      onClose();
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [onClose]);

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
        item.kind === "switch" ? (
          <SwitchRow key={i} item={item} />
        ) : item.divider ? (
          <div
            key={i}
            role="separator"
            className="flex h-[0.9rem] shrink-0 items-center px-2 before:h-px before:flex-1 before:bg-border"
          />
        ) : (
          <button
            key={i}
            onClick={(e) => {
              e.stopPropagation();
              item.onClick();
              onClose();
            }}
            type="button"
            role="menuitem"
            className={cn(MENU_ROW_CLASS, "hover:bg-hover")}
          >
            <MenuRowBody label={item.label} icon={item.icon} destructive={item.destructive} />
          </button>
        )
      )}
    </div>,
    document.body,
  );
}
