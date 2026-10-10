import { createContext, useContext, useMemo, type ReactNode, type Ref } from "react";
import { createPortal } from "react-dom";
import { Maximize2, Minimize2, PanelRight } from "lucide-react";
import { IconButton } from "@/components/ui/button";
import { CollapsedSidebarControls } from "@/components/shell/CanvasHeader";
import { useShellChrome } from "@/components/shell/shell-chrome-context";
import { getKeybindingForCommand, keybindingKeycaps } from "@/lib/keybinding-manager";
import { isMac } from "@/lib/platform";

/** The DOM hosts that row 1's leading slot and row 2 expose to the active tool. */
export interface PanelHeaderElements {
  readonly leading: HTMLElement | null;
  readonly row2: HTMLElement | null;
}

/**
 * Where a tool's header content goes. Tools keep their header state and portal
 * the markup into the shell, so moving a header never moves its state. Outside
 * the shell (standalone renders, the automation dock) the header stays inline.
 */
type PanelHeaderSlotTarget =
  | { readonly kind: "inline" }
  | { readonly kind: "hidden" }
  | ({ readonly kind: "portal" } & PanelHeaderElements);

const PanelHeaderSlotContext = createContext<PanelHeaderSlotTarget>({ kind: "inline" });

/**
 * Gives one tool access to the shell header. Only the active tool portals into
 * it; a mounted but inactive tool (Review and warm Browser surfaces stay
 * mounted) renders no header content at all.
 */
export function PanelHeaderSlotScope({
  active,
  elements,
  children,
}: {
  readonly active: boolean;
  readonly elements: PanelHeaderElements;
  readonly children: ReactNode;
}) {
  const { leading, row2 } = elements;
  const target = useMemo<PanelHeaderSlotTarget>(
    () => (active ? { kind: "portal", leading, row2 } : { kind: "hidden" }),
    [active, leading, row2],
  );
  return <PanelHeaderSlotContext.Provider value={target}>{children}</PanelHeaderSlotContext.Provider>;
}

/** Renders a tool's header content into row 1's leading slot or into row 2. */
export function PanelHeaderSlot({
  slot,
  children,
}: {
  readonly slot: "leading" | "row2";
  readonly children: ReactNode;
}) {
  const target = useContext(PanelHeaderSlotContext);
  if (target.kind === "inline") return children;
  if (target.kind === "hidden") return null;
  const host = slot === "leading" ? target.leading : target.row2;
  return host ? createPortal(children, host) : null;
}

/**
 * Row-1 title for tools without tabs or a picker: selected fill, fades past 320.
 * `headingLevel` keeps the tool's heading in the outline after it moves here.
 */
export function PanelTitlePill({
  id,
  icon,
  headingLevel,
  children,
}: {
  readonly id?: string;
  readonly icon?: ReactNode;
  readonly headingLevel?: 1 | 2;
  readonly children: ReactNode;
}) {
  return (
    <span
      data-testid="panel-title-pill"
      className="flex h-8 min-w-0 max-w-80 items-center gap-2 rounded-control bg-selected px-3 text-sm font-medium text-ink"
    >
      {icon}
      <span
        id={id}
        role={headingLevel ? "heading" : undefined}
        aria-level={headingLevel}
        className="text-fade min-w-0"
      >
        {children}
      </span>
    </span>
  );
}

interface PanelHeaderProps {
  readonly maximized: boolean;
  readonly leadingRef: Ref<HTMLDivElement>;
  readonly row2Ref: Ref<HTMLDivElement>;
  readonly onToggleMaximized: () => void;
  readonly onTogglePanel: () => void;
}

/**
 * The right panel's two-row header. Row 1 (48) shares the window caption
 * overlay: its right padding clears the caption buttons that hang over it, and
 * its empty space drags the window. Row 2 (40) exists only while the active
 * tool puts controls in it, so a tool without controls gets no blank strip.
 */
export function PanelHeader({
  maximized,
  leadingRef,
  row2Ref,
  onToggleMaximized,
  onTogglePanel,
}: PanelHeaderProps) {
  const { sidebarDocked } = useShellChrome();
  const panelShortcut = keybindingKeycaps(
    getKeybindingForCommand("rightPanel.toggle")?.key ?? "mod+alt+b",
    isMac,
  );
  return (
    <>
      <div
        data-panel-header-row-1=""
        data-testid="panel-header-row-1"
        className="window-drag flex h-row-comfortable shrink-0 items-center gap-2 pl-2 select-none"
      >
        {maximized && !sidebarDocked ? <CollapsedSidebarControls /> : null}
        <div ref={leadingRef} data-testid="panel-header-leading" className="flex h-full min-w-0 flex-1 items-center gap-2" />
        <IconButton
          shape="round"
          aria-label={maximized ? "Restore" : "Expand"}
          data-testid="panel-header-expand"
          data-preview-design-keep-open="true"
          onClick={onToggleMaximized}
        >
          {maximized ? <Minimize2 /> : <Maximize2 />}
        </IconButton>
        <IconButton
          shape="round"
          aria-label="Close panel"
          tooltipShortcut={panelShortcut}
          data-testid="panel-header-toggle"
          data-preview-design-keep-open="true"
          onClick={onTogglePanel}
        >
          <PanelRight />
        </IconButton>
      </div>
      <div
        ref={row2Ref}
        data-testid="panel-header-row-2"
        className="flex h-10 shrink-0 items-center gap-2 px-2 empty:hidden"
      />
    </>
  );
}
