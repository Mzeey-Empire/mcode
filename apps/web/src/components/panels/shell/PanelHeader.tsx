import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useState, type ReactNode, type Ref } from "react";
import { createPortal } from "react-dom";
import { Maximize2, MessageSquare, Minimize2, PanelRight } from "lucide-react";
import { Button, IconButton } from "@/components/ui/button";
import { CollapsedSidebarControls } from "@/components/shell/CanvasHeader";
import { useShellChrome } from "@/components/shell/shell-chrome-context";
import { getKeybindingForCommand, keybindingKeycaps } from "@/lib/keybinding-manager";
import { isMac } from "@/lib/platform";
import { OverlayGateContext } from "@/components/ui/overlay-gate";

/** The DOM hosts that row 1's leading slot, row 2 and row 3 expose to the active tool. */
export interface PanelHeaderElements {
  readonly leading: HTMLElement | null;
  readonly row2: HTMLElement | null;
  readonly row3: HTMLElement | null;
}

type PanelHeaderSlotName = "leading" | "row2" | "row3";

/**
 * Where a tool's header content goes. Each tool portals into its own detached
 * hosts, and only the active tool's hosts sit in the shell rows. Swapping tools
 * moves DOM nodes, never React trees, so header state (an omnibox draft, an
 * open picker) survives a switch. Outside the shell (standalone renders, the
 * automation dock) the context is null and the header stays inline.
 */
interface PanelHeaderSlotTarget {
  readonly hosts: Readonly<Record<PanelHeaderSlotName, HTMLElement>>;
  /** Marks a slot as used until the returned release runs, so empty rows stay out of the shell. */
  readonly claim: (slot: PanelHeaderSlotName) => () => void;
}

const PanelHeaderSlotContext = createContext<PanelHeaderSlotTarget | null>(null);

function createSlotHost(slot: PanelHeaderSlotName): HTMLElement {
  const host = document.createElement("div");
  // The row's flex layout must reach the tool's own elements.
  host.style.display = "contents";
  host.dataset.panelHeaderSlotHost = slot;
  return host;
}

function attachSlotHost(row: HTMLElement | null, host: HTMLElement): (() => void) | undefined {
  if (!row) return undefined;
  row.append(host);
  return () => host.remove();
}

/**
 * Gives one tool access to the shell header. Only the active tool's content is
 * attached; a mounted but inactive tool (Review and warm Browser surfaces stay
 * mounted) keeps its header alive off-document. A scope is active only while
 * its enclosing scope is, and its popups close while it is inactive.
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
  const scopeActive = useContext(OverlayGateContext) && active;
  const [hosts] = useState(() => ({
    leading: createSlotHost("leading"),
    row2: createSlotHost("row2"),
    row3: createSlotHost("row3"),
  }));
  const [claims, setClaims] = useState<Readonly<Record<PanelHeaderSlotName, number>>>({ leading: 0, row2: 0, row3: 0 });
  const claim = useCallback((slot: PanelHeaderSlotName) => {
    setClaims((current) => ({ ...current, [slot]: current[slot] + 1 }));
    return () => setClaims((current) => ({ ...current, [slot]: current[slot] - 1 }));
  }, []);
  const leadingRow = scopeActive && claims.leading > 0 ? elements.leading : null;
  const row2Row = scopeActive && claims.row2 > 0 ? elements.row2 : null;
  const row3Row = scopeActive && claims.row3 > 0 ? elements.row3 : null;
  useLayoutEffect(() => attachSlotHost(leadingRow, hosts.leading), [leadingRow, hosts]);
  useLayoutEffect(() => attachSlotHost(row2Row, hosts.row2), [row2Row, hosts]);
  useLayoutEffect(() => attachSlotHost(row3Row, hosts.row3), [row3Row, hosts]);
  const target = useMemo<PanelHeaderSlotTarget>(() => ({ hosts, claim }), [hosts, claim]);
  return (
    <OverlayGateContext.Provider value={scopeActive}>
      <PanelHeaderSlotContext.Provider value={target}>{children}</PanelHeaderSlotContext.Provider>
    </OverlayGateContext.Provider>
  );
}

/**
 * Open state for a controlled menu or popover in a tool's header. The scope's
 * overlay gate hides it while the tool is inactive; this also clears the state,
 * so the menu does not pop back open when the tool returns.
 */
export function usePanelHeaderMenuOpen(): readonly [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(false);
  const active = useContext(OverlayGateContext);
  if (open && !active) setOpen(false);
  return [open, setOpen];
}

/** Renders a tool's header content into row 1's leading slot, row 2 or row 3. */
export function PanelHeaderSlot({
  slot,
  children,
}: {
  readonly slot: PanelHeaderSlotName;
  readonly children: ReactNode;
}) {
  const target = useContext(PanelHeaderSlotContext);
  const claim = target?.claim;
  useLayoutEffect(() => claim?.(slot), [claim, slot]);
  if (!target) return children;
  return createPortal(children, target.hosts[slot]);
}

/**
 * Row-1 title for tools without tabs: the tool glyph in its slot, then the title as plain text that fades at the row's edge.
 * Only a tab that can be switched away from gets the selected fill, so a lone title stays text.
 * `headingLevel` keeps the tool's heading in the outline after it moves here.
 */
export function PanelTitle({
  id,
  icon,
  headingLevel,
  children,
}: {
  readonly id?: string;
  readonly icon?: ReactNode;
  readonly headingLevel?: 1 | 2 | 3;
  readonly children: ReactNode;
}) {
  return (
    <>
      {icon ? <PanelToolGlyph>{icon}</PanelToolGlyph> : null}
      <span
        id={id}
        role={headingLevel ? "heading" : undefined}
        aria-level={headingLevel}
        data-testid="panel-title"
        className="text-fade min-w-0 text-sm/5 font-medium text-ink"
      >
        {children}
      </span>
    </>
  );
}

/**
 * The tool's glyph at the start of row 1. Every tool puts it in this one slot, followed by its name and item tabs or
 * by its title, so row 1 keeps one shape as the user moves between tools.
 */
export function PanelToolGlyph({ children }: { readonly children: ReactNode }) {
  return (
    // The tab list or title beside it names the tool, so the glyph is for sighted users only. A narrow panel drops it
    // first, since the rail's selected entry shows the same icon; 208px fits Review's name and view picker without it.
    <span
      aria-hidden
      data-panel-tool-icon
      className="grid size-8 shrink-0 place-items-center text-muted @max-[208px]/panel-title:hidden [&_svg]:size-4"
    >
      {children}
    </span>
  );
}

/** The round Hide panel button, shared by row 1 and the rail's caption strip. */
export function PanelToggleButton({ onClick }: { readonly onClick: () => void }) {
  const panelShortcut = keybindingKeycaps(
    getKeybindingForCommand("rightPanel.toggle")?.key ?? "mod+alt+b",
    isMac,
  );
  return (
    <IconButton
      shape="round"
      aria-label="Hide panel"
      // Matches the rail's exits ("Hide Terminal (shells keep running)"), so hiding never reads as closing.
      tooltip="Hide panel (tools stay open in this thread)"
      tooltipShortcut={panelShortcut}
      data-testid="panel-header-toggle"
      data-preview-design-keep-open="true"
      onClick={onClick}
    >
      <PanelRight />
    </IconButton>
  );
}

/**
 * Row 1's Expand button. While maximized it becomes a labelled Restore, because the conversation is hidden and a
 * bare glyph read as one more panel control; the label makes the way back as plain as narrow posture's Back to chat.
 */
function ExpandControl({
  maximized,
  hasOpenTool,
  onToggleMaximized,
}: {
  readonly maximized: boolean;
  readonly hasOpenTool: boolean;
  readonly onToggleMaximized: () => void;
}) {
  if (maximized) {
    return (
      <Button
        variant="subtle"
        shape="round"
        className="text-body-small font-medium"
        data-testid="panel-header-expand"
        data-preview-design-keep-open="true"
        onClick={onToggleMaximized}
      >
        <Minimize2 aria-hidden />
        Restore
      </Button>
    );
  }
  if (!hasOpenTool) return null;
  return (
    <IconButton
      shape="round"
      aria-label="Expand"
      data-testid="panel-header-expand"
      data-preview-design-keep-open="true"
      onClick={onToggleMaximized}
    >
      <Maximize2 />
    </IconButton>
  );
}

interface PanelHeaderProps {
  readonly maximized: boolean;
  /**
   * The window is too narrow to show the conversation beside the panel, so the layout maximized it. Restore would
   * be maximized again at once; row 1 offers the way back to the conversation instead.
   */
  readonly fullSurface: boolean;
  /** A tool is open. Expanding the empty launcher would only stretch its tool list, so Expand waits for a tool. */
  readonly hasOpenTool: boolean;
  /** Hides the panel, keeping its state, so the conversation shows again. */
  readonly onReturnToChat: () => void;
  readonly leadingRef: Ref<HTMLDivElement>;
  readonly row2Ref: Ref<HTMLDivElement>;
  readonly row3Ref: Ref<HTMLDivElement>;
  readonly onToggleMaximized: () => void;
  /** Row 1's trailing Hide panel button, or null when the rail's caption strip hosts it. */
  readonly panelToggle: ReactNode;
}

/**
 * The right panel's header. Row 1 (48) shares the window caption overlay: its
 * right padding clears the caption buttons that hang over it, and its empty
 * space drags the window. Rows 2 and 3 (40 each) exist only while the active
 * tool puts controls in them, so a tool without controls gets no blank strip.
 * Row 3 sits below row 2 and appears or disappears without moving rows 1 and 2.
 */
export function PanelHeader({
  maximized,
  fullSurface,
  hasOpenTool,
  onReturnToChat,
  leadingRef,
  row2Ref,
  row3Ref,
  onToggleMaximized,
  panelToggle,
}: PanelHeaderProps) {
  const { sidebarDocked } = useShellChrome();
  return (
    <>
      <div
        data-panel-header-row-1=""
        data-testid="panel-header-row-1"
        className="window-drag flex h-row-comfortable shrink-0 items-center gap-2 pl-2 select-none"
      >
        {maximized && !sidebarDocked ? <CollapsedSidebarControls /> : null}
        <div ref={leadingRef} data-testid="panel-header-leading" className="@container/panel-title flex h-full min-w-0 flex-1 items-center gap-2" />
        {fullSurface ? (
          // It hides the panel, so it stands in for the Hide panel button as well as Restore.
          <Button variant="subtle" shape="round" className="text-body-small font-medium" onClick={onReturnToChat}>
            <MessageSquare aria-hidden />
            Back to chat
          </Button>
        ) : (
          <>
            <ExpandControl maximized={maximized} hasOpenTool={hasOpenTool} onToggleMaximized={onToggleMaximized} />
            {panelToggle}
          </>
        )}
      </div>
      <div
        ref={row2Ref}
        data-testid="panel-header-row-2"
        className="flex h-10 shrink-0 items-center gap-2 px-2 empty:hidden"
      />
      <div
        ref={row3Ref}
        data-testid="panel-header-row-3"
        className="flex h-10 shrink-0 items-center gap-2 px-2 empty:hidden"
      />
    </>
  );
}
