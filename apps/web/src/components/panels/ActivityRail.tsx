import type {
  FocusEvent as ReactFocusEvent,
  KeyboardEvent as ReactKeyboardEvent,
  ReactElement,
  PointerEvent as ReactPointerEvent,
  ReactNode,
  RefObject,
} from "react";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { Layers, Minus, MousePointer2, Plus, X } from "lucide-react";
import type { SubagentRosterEntry } from "@mcode/contracts/models/subagent-roster";
import { Button } from "@/components/ui/button";
import { ProviderIcon } from "@/components/ui/provider-icon";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { getKeybindingForCommand, keybindingKeycaps } from "@/lib/keybinding-manager";
import { isMac } from "@/lib/platform";
import {
  PANEL_TAB_TYPES,
  shownTabTypes,
  type PanelScope,
  type PanelTabType,
} from "@/lib/panel-tabs";
import {
  isSubagentTabInstance,
  rightPanelOpenTools,
  type RightPanelTool,
  type RightPanelTabInstance,
} from "@/stores/diffStore";
import { cn } from "@/lib/utils";

/** Past this many changed files the Review badge renders "{cap}+" instead of the exact count. */
const CHANGES_COUNT_CAP = 99;

/** Hover-intent delay before the rail reveals labels. */
const RAIL_EXPAND_DELAY_MS = 140;

/** Grace period that keeps the rail open while the pointer moves between rows. */
const RAIL_COLLAPSE_DELAY_MS = 250;

/** Width the expanded rail floats leftward over the body beyond its collapsed footprint. */
export const ACTIVITY_RAIL_FLOATING_OVERLAP_PX = 112;

/** Shared trailing anchor for expanded-rail actions. */
const RAIL_TRAILING_CONTROL_CLASS = "absolute right-0 top-0";

/** Rail glyph size; the icon inherits the row's muted or ink color. */
const RAIL_ICON_SIZE = 16;

const RAIL_ENTRY_CLASS = "relative h-8 w-full overflow-hidden rounded-lg px-2 text-xs transition-colors";

/** The selected entry: selected fill and ink glyph, per DESIGN.md "Vertical tabs". */
const RAIL_ACTIVE_CLASS = "bg-selected text-ink";

const RAIL_IDLE_CLASS = "text-muted hover:bg-hover hover:text-ink";

/** Stable id of the right panel body, which the rail's tabs control. */
export const RIGHT_PANEL_TABPANEL_ID = "right-panel-tabpanel";

/** Stable DOM id of the rail tab for one tab instance, so the panel body can name it. */
export function railTabElementId(instanceId: string): string {
  return `right-panel-tab-${instanceId}`;
}

function RailTooltip({
  content,
  shortcut,
  disabled = false,
  anchor,
  children,
}: {
  content: string;
  shortcut?: readonly string[];
  disabled?: boolean;
  /** Positions the tooltip against this element instead of the trigger. */
  anchor?: RefObject<HTMLElement | null>;
  children: ReactElement;
}) {
  return (
    <Tooltip disabled={disabled}>
      <TooltipTrigger render={children} />
      <TooltipContent side="left" anchor={anchor} shortcut={shortcut}>{content}</TooltipContent>
    </Tooltip>
  );
}

function getPointerReorderDirection(
  item: HTMLDivElement,
  pointerY: number,
): -1 | 1 | null {
  // The store moves tools past the whole subagent group, so measure only neighbors in the item's own lane.
  const siblings = Array.from(
    item.parentElement?.querySelectorAll<HTMLElement>(`:scope > [data-rail-lane="${item.dataset.railLane}"]`) ?? [],
  );
  const index = siblings.indexOf(item);
  const previous = siblings[index - 1];
  const next = siblings[index + 1];
  return previous && pointerY <= previous.getBoundingClientRect().bottom
    ? -1
    : next && pointerY >= next.getBoundingClientRect().top
      ? 1
      : null;
}

/** Pointer and keyboard reorder boundary for one top-level rail instance. */
function ReorderableRailItem({
  instanceId,
  lane,
  children,
  onReorder,
  onClose,
}: {
  instanceId: string;
  lane: "tool" | "subagent";
  children: ReactNode;
  onReorder: (instanceId: string, direction: -1 | 1) => void;
  onClose: (instanceId: string) => void;
}) {
  const draggingRef = useRef(false);
  const dragStartYRef = useRef<number | null>(null);
  const suppressClickRef = useRef(false);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest("[data-rail-close]")) return;
    suppressClickRef.current = false;
    draggingRef.current = true;
    dragStartYRef.current = event.clientY;
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    const dragStartY = dragStartYRef.current;
    if (dragStartY === null || Math.abs(event.clientY - dragStartY) < 4) return;
    if (!event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    }
    const direction = getPointerReorderDirection(event.currentTarget, event.clientY);
    if (direction === null) return;
    onReorder(instanceId, direction);
    suppressClickRef.current = true;
  };

  const onPointerUp = () => {
    draggingRef.current = false;
    dragStartYRef.current = null;
  };

  const onPointerCancel = () => {
    draggingRef.current = false;
    dragStartYRef.current = null;
    suppressClickRef.current = false;
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // The close × leaves the tab order so Tab moves from the tablist into the panel; Delete closes instead.
    if (event.key === "Delete" && (event.target as HTMLElement).getAttribute("role") === "tab") {
      event.preventDefault();
      onClose(instanceId);
      return;
    }
    if (!event.altKey || !event.shiftKey) return;
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    event.stopPropagation();
    onReorder(instanceId, event.key === "ArrowUp" ? -1 : 1);
  };

  return (
    <div
      data-rail-instance={instanceId}
      data-rail-lane={lane}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onKeyDown={onKeyDown}
      onClickCapture={(event) => {
        if (!suppressClickRef.current) return;
        suppressClickRef.current = false;
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      {children}
    </div>
  );
}

const RAIL_FOCUS_KEYS = new Set(["ArrowUp", "ArrowDown", "Home", "End"]);

/** Where a focus key lands among `count` tabs from `current` (-1 when focus is outside), wrapping at the ends. */
function nextRailTabIndex(key: string, current: number, count: number): number {
  const last = count - 1;
  if (key === "Home") return 0;
  if (key === "End") return last;
  if (key === "ArrowUp") return current <= 0 ? last : current - 1;
  return current < 0 || current === last ? 0 : current + 1;
}

function hasModifier(event: ReactKeyboardEvent): boolean {
  return event.altKey || event.ctrlKey || event.metaKey || event.shiftKey;
}

/**
 * Roving focus for the vertical tablist. Moving focus never selects a tool,
 * because switching tools mounts work; Enter or Space activates the focused tab.
 */
function onTablistKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
  if (!RAIL_FOCUS_KEYS.has(event.key) || hasModifier(event)) return;
  const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]'));
  if (tabs.length === 0) return;
  const current = tabs.indexOf(document.activeElement as HTMLElement);
  event.preventDefault();
  tabs[nextRailTabIndex(event.key, current, tabs.length)]?.focus();
}

/** Catalog metadata (product label + icon) for an openable tab, by store id. */
function metaForTab(id: RightPanelTool): PanelTabType | undefined {
  return PANEL_TAB_TYPES.find((t) => t.id === id);
}

function railDomId(id: RightPanelTool): string {
  return id === "changes" ? "review" : id;
}

/** The keys of a tab type's shortcut, or undefined when it has no binding. */
function tabKeycaps(type: PanelTabType): readonly string[] | undefined {
  if (!type.commandId) return undefined;
  const binding = getKeybindingForCommand(type.commandId);
  return binding ? keybindingKeycaps(binding.key, isMac) : undefined;
}

/**
 * Accessible name for a rail icon, carrying its glance status as text so screen
 * readers get the signal sighted users read from the count and the freshness
 * color. The visible rail glyph is icon-only, so this is the tab's only name.
 */
function railAccessibleLabel(
  id: RightPanelTool,
  label: string,
  changesCount: number,
  changesFresh: boolean,
): string {
  if (id === "changes") {
    if (changesCount === 0) return label;
    const files = `${changesCount} ${changesCount === 1 ? "file" : "files"} changed`;
    return `${label}, ${files}${changesFresh ? ", new since last viewed" : ""}`;
  }
  return label;
}

/**
 * Compact glance status under a rail icon: Review
 * file count. Returns null for tabs with nothing to report so a calm icon stays
 * a bare glyph. Mirrors the One Lamp Rule: the active icon tints amber while
 * its status text stays legible.
 */
function RailStatus({
  id,
  active,
  expanded,
  changesCount,
  changesFresh,
}: {
  id: RightPanelTool;
  active: boolean;
  expanded: boolean;
  changesCount: number;
  changesFresh: boolean;
}) {
  if (id === "tasks") {
    return null;
  }
  if (id === "changes") {
    if (changesCount === 0) return null;
    const label = changesCount > CHANGES_COUNT_CAP ? `${CHANGES_COUNT_CAP}+` : String(changesCount);
    return (
      <span
        className={cn(
          "font-mono text-xs font-medium leading-none tabular-nums transition-[opacity,transform] motion-reduce:duration-0 motion-reduce:transition-none",
          expanded ? "shrink-0" : "mt-0.5",
          changesFresh
            ? "changes-fresh-ring text-primary"
            : active
              ? "text-current"
              : "text-muted",
        )}
      >
        {label}
      </span>
    );
  }
  return null;
}

/**
 * The expanded rail's label row: the tool name, then its status on the right. A three-key shortcut chip took most
 * of the 104px row and cut "Files" to "F", so the shortcut lives in the row's tooltip instead.
 */
function RailEntryLabel({
  label,
  status,
  expanded,
  active,
}: {
  label: string;
  status?: ReactNode;
  expanded: boolean;
  active: boolean;
}) {
  return (
        <span
          aria-hidden
          className={cn(
            "absolute left-8 flex items-center gap-2 transition-[opacity,transform] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:duration-0 motion-reduce:transition-none",
            // The active entry shows its exit at rest, so its row ends before the exit's slot.
            active ? "right-8" : "right-2",
            expanded ? "translate-x-0 opacity-100" : "translate-x-1 opacity-0",
          )}
        >
          <span className={cn("min-w-0 flex-1 text-fade text-left font-medium text-ink", !active && "group-hover:mr-6")}>{label}</span>
          {/* The trailing status gives way to the hover-revealed close. */}
          {expanded && status ? (
            <span className="flex shrink-0 items-center gap-2 transition-opacity motion-reduce:duration-0 motion-reduce:transition-none group-hover:opacity-0">
              {status}
            </span>
          ) : null}
        </span>
  );
}

/** One rail entry: a select glyph, plus a hover-revealed exit: × to close, or − when the tool only hides. */
function RailEntry({
  instanceId,
  domId,
  icon,
  label,
  accessibleLabel,
  hideLabel,
  status,
  shortcut,
  active,
  focusable,
  expanded,
  onSelect,
  onClose,
}: {
  instanceId: string;
  domId: string;
  icon: ReactNode;
  label: string;
  accessibleLabel: string;
  hideLabel?: string;
  status?: ReactNode;
  shortcut?: readonly string[];
  active: boolean;
  /** The roving tab stop: the active tab, or the first one when none is active. */
  focusable: boolean;
  expanded: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={rowRef} className="group relative w-full">
      {/* The expanded row already shows the name; its tooltip stays only to teach the shortcut. */}
      <RailTooltip content={label} shortcut={shortcut} disabled={expanded && !shortcut?.length}>
        <Button
          type="button"
          variant="ghost"
          size="compact"
          role="tab"
          id={railTabElementId(instanceId)}
          data-rail-tab={domId}
          data-active={active ? "true" : undefined}
          aria-selected={active}
          aria-controls={RIGHT_PANEL_TABPANEL_ID}
          tabIndex={focusable ? 0 : -1}
          aria-label={accessibleLabel}
          onClick={onSelect}
          className={cn(
            RAIL_ENTRY_CLASS,
            expanded ? "flex-row justify-start gap-2" : "flex-col gap-0",
            active ? RAIL_ACTIVE_CLASS : RAIL_IDLE_CLASS,
          )}
        >
          {icon}
          <RailEntryLabel label={label} status={status} expanded={expanded} active={active} />
          {expanded ? null : status}
        </Button>
      </RailTooltip>
      {/* A sibling button (not nested) so the markup stays valid and the exit is its own announced control. */}
      <RailEntryExit label={hideLabel ?? `Close ${label}`} hides={hideLabel !== undefined} active={active} expanded={expanded} row={rowRef} onExit={onClose} />
    </div>
  );
}

/** A rail entry's hover- or focus-revealed way out: × closes the tool, − only hides it. */
function RailEntryExit({
  label,
  hides,
  active,
  expanded,
  row,
  onExit,
}: {
  label: string;
  hides: boolean;
  active: boolean;
  expanded: boolean;
  /** The entry's row. The exit sits at the row's trailing end, so a tooltip beside the exit would cover the row's name. */
  row: RefObject<HTMLDivElement | null>;
  onExit: () => void;
}) {
  return (
    // The exit cannot be pressed while the rail is collapsed, so its tooltip only applies once it expands.
    <RailTooltip content={label} disabled={!expanded} anchor={row}>
      <Button
        type="button"
        variant="ghost"
        size="icon-compact"
        aria-label={label}
        tabIndex={-1}
        data-rail-close
        onClick={onExit}
        className={cn(
          RAIL_TRAILING_CONTROL_CLASS,
          "text-muted opacity-0 transition-opacity motion-reduce:duration-0 motion-reduce:transition-none hover:bg-panel hover:text-ink",
          // As in the header tab strips, the active entry's way out shows at rest once the rail has room for it.
          expanded
            ? active ? "opacity-100" : "group-focus-within:opacity-100 group-hover:opacity-100"
            : "pointer-events-none",
        )}
      >
        {hides ? <Minus size={12} /> : <X size={12} />}
      </Button>
    </RailTooltip>
  );
}

function RailTab({
  instanceId,
  id,
  active,
  focusable,
  expanded,
  changesCount,
  changesFresh,
  browserActing,
  onSelect,
  onClose,
}: {
  instanceId: string;
  id: RightPanelTool;
  active: boolean;
  focusable: boolean;
  expanded: boolean;
  changesCount: number;
  changesFresh: boolean;
  browserActing: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  const meta = metaForTab(id);
  if (!meta) return null;
  const { icon: Icon, label } = meta;
  return (
    <RailEntry
      instanceId={instanceId}
      domId={railDomId(id)}
      icon={
        id === "preview" && browserActing ? (
          <MousePointer2 data-testid="rail-browser-acting" size={RAIL_ICON_SIZE} className="fill-primary text-primary" />
        ) : (
          <Icon size={RAIL_ICON_SIZE} />
        )
      }
      label={label}
      accessibleLabel={railAccessibleLabel(id, label, changesCount, changesFresh)}
      hideLabel={meta.hideLabel}
      status={<RailStatus id={id} active={active} expanded={expanded} changesCount={changesCount} changesFresh={changesFresh} />}
      shortcut={tabKeycaps(meta)}
      active={active}
      focusable={focusable}
      expanded={expanded}
      onSelect={onSelect}
      onClose={onClose}
    />
  );
}

function RailSubagentTab({
  instanceId,
  entryId,
  entry,
  active,
  focusable,
  expanded,
  onSelect,
  onClose,
}: {
  instanceId: string;
  entryId: string;
  entry: SubagentRosterEntry | undefined;
  active: boolean;
  focusable: boolean;
  expanded: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  const label = entry?.title ?? "Subagent";
  const running = entry?.status === "running";
  return (
    <RailEntry
      instanceId={instanceId}
      domId={`subagent:${entryId}`}
      icon={
        <span className="relative inline-flex shrink-0">
          {entry ? <ProviderIcon provider={entry.provider} size={RAIL_ICON_SIZE} /> : <Layers size={RAIL_ICON_SIZE} />}
          {running && (
            // The ring takes the entry's own fill so the dot reads as cut out of it, active or idle.
            <span
              data-testid="rail-subagent-running"
              aria-hidden
              className={cn(
                "absolute -top-1 -right-1 size-[6px] rounded-full bg-success ring-2",
                active ? "ring-selected" : "ring-background group-hover:ring-hover",
              )}
            />
          )}
        </span>
      }
      label={label}
      accessibleLabel={running ? `${label}, running` : label}
      active={active}
      focusable={focusable}
      expanded={expanded}
      onSelect={onSelect}
      onClose={onClose}
    />
  );
}

function RailDivider() {
  return <div data-testid="rail-subagent-divider" aria-hidden className="mx-auto my-1 h-px w-5 shrink-0 bg-border" />;
}

/**
 * The dynamic add control: hidden when nothing is creatable, opens the one
 * creatable type directly when exactly one remains, otherwise a menu of the
 * shown set (the same set the empty-state grid presents; coming-soon teasers
 * disabled).
 */
function RailAddControl({
  scope,
  openTabs,
  expanded,
  onCreate,
}: {
  scope: PanelScope;
  openTabs: readonly RightPanelTool[];
  expanded: boolean;
  onCreate: (id: RightPanelTool) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const creatable = shownTabTypes(scope, openTabs);

  // Nothing openable hides the control entirely.
  if (creatable.length === 0) return null;

  // Exactly one creatable type opens directly; no pointless menu.
  if (creatable.length === 1) {
    const only = creatable[0];
    return (
      <RailTooltip content={`Open ${only.label}`} disabled={expanded}>
        <span className="block">
          <Button
            variant="ghost"
            size="compact"
            className="relative h-8 w-full justify-start overflow-hidden rounded-lg px-2 text-muted hover:text-ink"
            aria-label={`Open ${only.label}`}
            onClick={() => onCreate(only.id)}
          >
            <Plus />
            <span
              aria-hidden
              className={cn(
                "absolute left-8 right-2 text-fade text-left text-xs font-medium transition-[opacity,transform] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:duration-0 motion-reduce:transition-none",
                expanded ? "translate-x-0 opacity-100" : "translate-x-1 opacity-0",
              )}
            >
              Open {only.label}
            </span>
          </Button>
        </span>
      </RailTooltip>
    );
  }

  return (
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
      <RailTooltip content="Open tool" disabled={expanded}>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="compact"
              className="relative h-8 w-full justify-start overflow-hidden rounded-lg px-2 text-muted hover:text-ink"
              aria-label="Open tool"
            >
              <Plus />
              <span
                aria-hidden
                className={cn(
                  "absolute left-8 right-2 text-fade text-left text-xs font-medium transition-[opacity,transform] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:duration-0 motion-reduce:transition-none",
                  expanded ? "translate-x-0 opacity-100" : "translate-x-1 opacity-0",
                )}
              >
                Open tool
              </span>
            </Button>
          }
        />
      </RailTooltip>
      <DropdownMenuContent side="left" align="start" sideOffset={6} className="min-w-[184px]">
        {creatable.map((type) => (
          <DropdownMenuItem
            key={type.id}
            label={type.label}
            icon={<type.icon />}
            shortcut={tabKeycaps(type)}
            onClick={() => onCreate(type.id)}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface ActivityRailProps {
  readonly tabInstances: readonly RightPanelTabInstance[];
  readonly activeTabId: string | null;
  /** The thread's roster entries, which name and badge its subagent tabs. */
  readonly subagentEntries?: readonly SubagentRosterEntry[];
  readonly scope: PanelScope;
  readonly changesCount: number;
  readonly changesFresh: boolean;
  /** Swaps the Browser entry's glyph for a pointer while the agent acts on one of its pages. */
  readonly browserActing?: boolean;
  onSelect: (instanceId: string) => void;
  onClose: (instanceId: string) => void;
  onReorder: (instanceId: string, direction: -1 | 1) => void;
  onCreate: (id: RightPanelTool) => void;
  /** Publishes the floating state so Browser surfaces exclude the covered edge. */
  readonly onExpandedChange?: (expanded: boolean) => void;
  /** A control for the caption strip when no window caption buttons cover it. */
  readonly captionAction?: ReactNode;
}

interface ActivityRailViewProps extends ActivityRailProps {
  readonly railRef: React.RefObject<HTMLDivElement | null>;
  readonly expanded: boolean;
  onPointerEnter: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerLeave: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerDownCapture: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUpCapture: () => void;
  onFocusCapture: () => void;
  onBlurCapture: (event: ReactFocusEvent<HTMLDivElement>) => void;
}

/** One rail entry per open tool, then each open subagent behind a divider; Terminal records and Browser pages are tabs inside their tool. */
function RailTabInstances({
  tabInstances,
  activeTabId,
  subagentEntries,
  changesCount,
  changesFresh,
  browserActing,
  expanded,
  onSelect,
  onClose,
  onReorder,
}: Pick<
  ActivityRailViewProps,
  | "tabInstances"
  | "activeTabId"
  | "subagentEntries"
  | "changesCount"
  | "changesFresh"
  | "browserActing"
  | "expanded"
  | "onSelect"
  | "onClose"
  | "onReorder"
>) {
  const firstSubagentId = tabInstances.find(isSubagentTabInstance)?.id;
  const rovingId = tabInstances.some((instance) => instance.id === activeTabId)
    ? activeTabId
    : tabInstances[0]?.id;
  return tabInstances.map((instance) => (
    <Fragment key={instance.id}>
      {instance.id === firstSubagentId && <RailDivider />}
      <ReorderableRailItem instanceId={instance.id} lane={isSubagentTabInstance(instance) ? "subagent" : "tool"} onReorder={onReorder} onClose={onClose}>
        {isSubagentTabInstance(instance) ? (
          <RailSubagentTab
            instanceId={instance.id}
            entryId={instance.entryId}
            entry={subagentEntries?.find((entry) => entry.id === instance.entryId)}
            active={instance.id === activeTabId}
            focusable={instance.id === rovingId}
            expanded={expanded}
            onSelect={() => onSelect(instance.id)}
            onClose={() => onClose(instance.id)}
          />
        ) : (
          <RailTab
            instanceId={instance.id}
            id={instance.type}
            active={instance.id === activeTabId}
            focusable={instance.id === rovingId}
            expanded={expanded}
            changesCount={changesCount}
            changesFresh={changesFresh}
            browserActing={browserActing ?? false}
            onSelect={() => onSelect(instance.id)}
            onClose={() => onClose(instance.id)}
          />
        )}
      </ReorderableRailItem>
    </Fragment>
  ));
}

function RailFooter({
  scope,
  tabInstances,
  expanded,
  onCreate,
}: Pick<ActivityRailViewProps, "scope" | "tabInstances" | "expanded" | "onCreate">) {
  const openTabs = rightPanelOpenTools(tabInstances);
  return (
    <>
      {/* Shown beside the empty state's card grid too, so the rail is where a user first meets the add control
          rather than a blank column that fills in later. */}
      <RailAddControl
        scope={scope}
        openTabs={openTabs}
        expanded={expanded}
        onCreate={onCreate}
      />
    </>
  );
}

function ActivityRailView({
  tabInstances,
  activeTabId,
  subagentEntries,
  scope,
  changesCount,
  changesFresh,
  browserActing,
  onSelect,
  onClose,
  onReorder,
  onCreate,
  captionAction,
  railRef,
  expanded,
  onPointerEnter,
  onPointerLeave,
  onPointerDownCapture,
  onPointerUpCapture,
  onFocusCapture,
  onBlurCapture,
}: ActivityRailViewProps) {
  return (
    <div
      ref={railRef}
      data-testid="activity-rail"
      data-expanded={expanded ? "true" : "false"}
      // Last visually but first in the DOM, so Tab reaches the tools before the panel body.
      className="relative z-(--layer-floating-panel) order-last w-(--container-right-rail) flex-none"
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onPointerDownCapture={onPointerDownCapture}
      onPointerUpCapture={onPointerUpCapture}
      onPointerCancelCapture={onPointerUpCapture}
      onFocusCapture={onFocusCapture}
      onBlurCapture={onBlurCapture}
    >
      {/* The top 48 sits under the caption buttons and drags the window. It never
          widens, so the expanded rail cannot cover row 1's panel controls. The
          right padding matches the canvas header's, so a caption action lands
          exactly where the canvas toggle sits while the panel is closed. */}
      <div
        aria-hidden={captionAction ? undefined : true}
        data-testid="activity-rail-caption-strip"
        className="window-drag absolute top-0 right-0 flex h-row-comfortable w-(--container-right-rail) items-center justify-end bg-page pr-[0.8rem]"
      >
        {captionAction}
      </div>
      {/* The body under the expanded rail fades into it, so covered text is not cut off mid-word. */}
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute top-row-comfortable bottom-0 w-6 bg-linear-to-l from-page to-transparent transition-[right,opacity] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:duration-0 motion-reduce:transition-none",
          expanded ? "right-(--container-right-rail-expanded) opacity-100" : "right-(--container-right-rail) opacity-0",
        )}
      />
      {/* Anchored to the window edge, so hover expansion grows leftward over the body. */}
      <div
        data-testid="activity-rail-surface"
        className={cn(
          "absolute top-row-comfortable right-0 bottom-0 flex flex-col items-stretch gap-1 overflow-hidden bg-page p-2 dark:border-l dark:border-border transition-[width,border-radius] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:duration-0 motion-reduce:transition-none",
          // The caption strip above never widens, so only the expanded surface has a free top-left corner to round.
          expanded ? "w-(--container-right-rail-expanded) rounded-tl-xl" : "w-(--container-right-rail)",
        )}
      >
      {/* Eight subagent tabs below the tools outgrow a short window. The bleed
          padding keeps the active bar and running dot outside the scroll clip. */}
      <div
        data-testid="activity-rail-tabs"
        role="tablist"
        aria-label="Panel tools"
        aria-orientation="vertical"
        onKeyDown={onTablistKeyDown}
        className="-mx-2 -my-1 flex min-h-0 shrink flex-col items-stretch gap-1 overflow-y-auto px-2 py-1 [scrollbar-width:none]">
        <RailTabInstances
          tabInstances={tabInstances}
          activeTabId={activeTabId}
          subagentEntries={subagentEntries}
          changesCount={changesCount}
          changesFresh={changesFresh}
          browserActing={browserActing}
          expanded={expanded}
          onSelect={onSelect}
          onClose={onClose}
          onReorder={onReorder}
        />
      </div>
      <RailFooter
        scope={scope}
        tabInstances={tabInstances}
        expanded={expanded}
        onCreate={onCreate}
      />
      </div>
    </div>
  );
}

/**
 * Vertical activity rail on the panel's right edge: one entry per open tool
 * (hover-× close, drag or Alt+Shift+Arrow to reorder whole tools) and an add
 * control once a tool is open (ADR-0026). Panel-level controls live in the
 * panel header, not here.
 */
export function ActivityRail({
  tabInstances,
  activeTabId,
  subagentEntries,
  scope,
  changesCount,
  changesFresh,
  browserActing,
  onSelect,
  onClose,
  onReorder,
  onCreate,
  onExpandedChange,
  captionAction,
}: ActivityRailProps) {
  const [expanded, setExpanded] = useState(false);
  const railRef = useRef<HTMLDivElement>(null);
  const expandTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const collapseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pointerWithinRef = useRef(false);
  // A mouse press focuses the entry it lands on, so only focus that arrived
  // without a press (keyboard) holds the rail open after the pointer leaves.
  const focusFromPointerRef = useRef(false);
  // The rail grows leftward from the window edge, so expanding mid-press slides
  // the entry out from under the pointer and the click lands elsewhere.
  const pointerPressedRef = useRef(false);
  // Set by a pointer pick and cleared when the pointer leaves. The picked tool's header controls sit under the
  // expanded rail, so a rail that stayed open while the pointer headed for them would cover them.
  const expandSuppressedRef = useRef(false);
  // Focus can arrive with no press inside the rail, as when a menu returns it to its trigger; the last input anywhere
  // in the window tells whether a pointer or the keyboard moved it, as :focus-visible does.
  const lastInputWasPointerRef = useRef(false);
  useEffect(() => {
    const onPointer = () => { lastInputWasPointerRef.current = true; };
    const onKey = () => { lastInputWasPointerRef.current = false; };
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, []);

  const clearExpandTimer = useCallback(() => {
    if (expandTimerRef.current === null) return;
    clearTimeout(expandTimerRef.current);
    expandTimerRef.current = null;
  }, []);

  const clearCollapseTimer = useCallback(() => {
    if (collapseTimerRef.current === null) return;
    clearTimeout(collapseTimerRef.current);
    collapseTimerRef.current = null;
  }, []);

  const scheduleExpand = useCallback(() => {
    clearCollapseTimer();
    if (expanded || expandSuppressedRef.current || expandTimerRef.current !== null) return;
    expandTimerRef.current = setTimeout(() => {
      expandTimerRef.current = null;
      if (pointerWithinRef.current && !pointerPressedRef.current && !expandSuppressedRef.current) setExpanded(true);
    }, RAIL_EXPAND_DELAY_MS);
  }, [clearCollapseTimer, expanded]);

  const scheduleCollapse = useCallback(() => {
    clearExpandTimer();
    clearCollapseTimer();
    collapseTimerRef.current = setTimeout(() => {
      collapseTimerRef.current = null;
      const keyboardFocusWithin =
        !focusFromPointerRef.current && (railRef.current?.contains(document.activeElement) ?? false);
      if (!pointerWithinRef.current && !keyboardFocusWithin) setExpanded(false);
    }, RAIL_COLLAPSE_DELAY_MS);
  }, [clearCollapseTimer, clearExpandTimer]);

  useEffect(() => {
    onExpandedChange?.(expanded);
  }, [expanded, onExpandedChange]);

  useEffect(
    () => () => {
      clearExpandTimer();
      clearCollapseTimer();
    },
    [clearCollapseTimer, clearExpandTimer],
  );

  const onPointerEnter = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "touch") return;
    pointerWithinRef.current = true;
    scheduleExpand();
  };

  const onPointerLeave = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "touch") return;
    pointerWithinRef.current = false;
    pointerPressedRef.current = false;
    expandSuppressedRef.current = false;
    scheduleCollapse();
  };

  const selectTool = (instanceId: string) => {
    onSelect(instanceId);
    if (!lastInputWasPointerRef.current) return;
    clearExpandTimer();
    clearCollapseTimer();
    expandSuppressedRef.current = true;
    setExpanded(false);
  };

  const onPointerDownCapture = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "touch") return;
    pointerPressedRef.current = true;
  };

  const onPointerUpCapture = () => {
    pointerPressedRef.current = false;
    if (pointerWithinRef.current) scheduleExpand();
  };

  const onFocusCapture = () => {
    const fromPointer = pointerPressedRef.current || lastInputWasPointerRef.current;
    focusFromPointerRef.current = fromPointer;
    clearExpandTimer();
    clearCollapseTimer();
    if (!fromPointer) setExpanded(true);
    // The add menu hands focus back to its trigger after a pointer pick made outside the rail. Treating that as
    // keyboard focus left the rail expanded over the tool it had just opened.
    else if (!pointerWithinRef.current) scheduleCollapse();
  };

  const onBlurCapture = (event: ReactFocusEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    scheduleCollapse();
  };

  return (
    <ActivityRailView
      tabInstances={tabInstances}
      activeTabId={activeTabId}
      subagentEntries={subagentEntries}
      scope={scope}
      changesCount={changesCount}
      changesFresh={changesFresh}
      browserActing={browserActing}
      onSelect={selectTool}
      onClose={onClose}
      onReorder={onReorder}
      onCreate={onCreate}
      captionAction={captionAction}
      railRef={railRef}
      expanded={expanded}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onPointerDownCapture={onPointerDownCapture}
      onPointerUpCapture={onPointerUpCapture}
      onFocusCapture={onFocusCapture}
      onBlurCapture={onBlurCapture}
    />
  );
}
