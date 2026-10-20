import type {
  FocusEvent as ReactFocusEvent,
  KeyboardEvent as ReactKeyboardEvent,
  ReactElement,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from "react";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { Layers, MousePointer2, Plus, X } from "lucide-react";
import type { SubagentRosterEntry } from "@mcode/contracts";
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

/** The selected entry: selected fill and ink glyph; `RailActiveEdge` adds the amber bar. */
const RAIL_ACTIVE_CLASS = "bg-selected text-ink";

const RAIL_IDLE_CLASS = "text-muted hover:bg-hover hover:text-ink";

/**
 * The active entry's 2x20 amber bar, 2px outside its body-facing edge. A
 * sibling of the entry rather than a shadow, because the entry clips its
 * label during expansion and outer shadows are not part of the elevation set.
 */
function RailActiveEdge() {
  return (
    <span
      data-testid="rail-active-edge"
      aria-hidden
      className="pointer-events-none absolute top-1/2 -left-[2px] h-[20px] w-[2px] -translate-y-1/2 rounded-[1px] bg-primary"
    />
  );
}

function RailTooltip({
  content,
  disabled = false,
  children,
}: {
  content: string;
  disabled?: boolean;
  children: ReactElement;
}) {
  return (
    <Tooltip disabled={disabled}>
      <TooltipTrigger render={children} />
      <TooltipContent side="left">{content}</TooltipContent>
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
}: {
  instanceId: string;
  lane: "tool" | "subagent";
  children: ReactNode;
  onReorder: (instanceId: string, direction: -1 | 1) => void;
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
          expanded
            ? "absolute right-2 top-1/2 -translate-y-1/2 group-hover:opacity-0"
            : "mt-0.5",
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

/** One rail entry: a select glyph, plus a hover-revealed × to close. */
function RailEntry({
  domId,
  icon,
  label,
  accessibleLabel,
  status,
  active,
  expanded,
  onSelect,
  onClose,
}: {
  domId: string;
  icon: ReactNode;
  label: string;
  accessibleLabel: string;
  status?: ReactNode;
  active: boolean;
  expanded: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  return (
    <div className="group relative w-full">
      {active && <RailActiveEdge />}
      <RailTooltip content={label} disabled={expanded}>
        <Button
          type="button"
          variant="ghost"
          size="compact"
          data-rail-tab={domId}
          data-active={active ? "true" : undefined}
          aria-pressed={active}
          aria-label={accessibleLabel}
          onClick={onSelect}
          className={cn(
            RAIL_ENTRY_CLASS,
            expanded ? "flex-row justify-start gap-2" : "flex-col gap-0",
            active ? RAIL_ACTIVE_CLASS : RAIL_IDLE_CLASS,
          )}
        >
          {icon}
          <span
            aria-hidden
            className={cn(
              "absolute left-8 right-8 text-fade text-left font-medium text-ink transition-[opacity,transform] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:duration-0 motion-reduce:transition-none",
              expanded ? "translate-x-0 opacity-100" : "translate-x-1 opacity-0",
            )}
          >
            {label}
          </span>
          {status}
        </Button>
      </RailTooltip>
      {/* Hover/focus-revealed close. A sibling button (not nested) so the markup
          stays valid and the × is its own focusable, announced control. */}
      <RailTooltip content={`Close ${label}`} disabled={expanded}>
        <Button
          type="button"
          variant="ghost"
          size="icon-compact"
          aria-label={`Close ${label}`}
          data-rail-close
          onClick={onClose}
          className={cn(
            RAIL_TRAILING_CONTROL_CLASS,
            "text-muted opacity-0 transition-opacity motion-reduce:duration-0 motion-reduce:transition-none hover:bg-panel hover:text-ink",
            expanded
              ? "focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
              : "pointer-events-none",
          )}
        >
          <X size={12} />
        </Button>
      </RailTooltip>
    </div>
  );
}

function RailTab({
  id,
  active,
  expanded,
  changesCount,
  changesFresh,
  browserActing,
  onSelect,
  onClose,
}: {
  id: RightPanelTool;
  active: boolean;
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
      status={<RailStatus id={id} active={active} expanded={expanded} changesCount={changesCount} changesFresh={changesFresh} />}
      active={active}
      expanded={expanded}
      onSelect={onSelect}
      onClose={onClose}
    />
  );
}

function RailSubagentTab({
  entryId,
  entry,
  active,
  expanded,
  onSelect,
  onClose,
}: {
  entryId: string;
  entry: SubagentRosterEntry | undefined;
  active: boolean;
  expanded: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  const label = entry?.title ?? "Subagent";
  const running = entry?.status === "running";
  return (
    <RailEntry
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
 * disabled). Only rendered when at least one tab is already open; the empty
 * state's card grid is its own create surface (ADR-0004, issue #611).
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
      <RailTooltip content={`New ${only.label}`} disabled={expanded}>
        <span className="block">
          <Button
            variant="ghost"
            size="compact"
            className="relative h-8 w-full justify-start overflow-hidden rounded-lg px-2 text-muted hover:text-ink"
            aria-label={`New ${only.label}`}
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
              New {only.label}
            </span>
          </Button>
        </span>
      </RailTooltip>
    );
  }

  return (
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
      <RailTooltip content="New tab" disabled={expanded}>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="compact"
              className="relative h-8 w-full justify-start overflow-hidden rounded-lg px-2 text-muted hover:text-ink"
              aria-label="New tab"
            >
              <Plus />
              <span
                aria-hidden
                className={cn(
                  "absolute left-8 right-2 text-fade text-left text-xs font-medium transition-[opacity,transform] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:duration-0 motion-reduce:transition-none",
                  expanded ? "translate-x-0 opacity-100" : "translate-x-1 opacity-0",
                )}
              >
                New tab
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
  return tabInstances.map((instance) => (
    <Fragment key={instance.id}>
      {instance.id === firstSubagentId && <RailDivider />}
      <ReorderableRailItem instanceId={instance.id} lane={isSubagentTabInstance(instance) ? "subagent" : "tool"} onReorder={onReorder}>
        {isSubagentTabInstance(instance) ? (
          <RailSubagentTab
            entryId={instance.entryId}
            entry={subagentEntries?.find((entry) => entry.id === instance.entryId)}
            active={instance.id === activeTabId}
            expanded={expanded}
            onSelect={() => onSelect(instance.id)}
            onClose={() => onClose(instance.id)}
          />
        ) : (
          <RailTab
            id={instance.type}
            active={instance.id === activeTabId}
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
      {/* The add control only appears once a tab is open; with none open the
          empty-state card grid is the create surface. */}
      {openTabs.length > 0 && (
        <RailAddControl
          scope={scope}
          openTabs={openTabs}
          expanded={expanded}
          onCreate={onCreate}
        />
      )}
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
      className="relative z-(--layer-floating-panel) w-(--container-right-rail) flex-none"
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
      {/* Anchored to the window edge, so hover expansion grows leftward over the body. */}
      <div
        data-testid="activity-rail-surface"
        className={cn(
          "absolute top-row-comfortable right-0 bottom-0 flex flex-col items-stretch gap-1 overflow-hidden bg-page p-2 transition-[width,border-radius] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:duration-0 motion-reduce:transition-none",
          // The caption strip above never widens, so only the expanded surface has a free top-left corner to round.
          expanded ? "w-(--container-right-rail-expanded) rounded-tl-xl" : "w-(--container-right-rail)",
        )}
      >
      {/* Eight subagent tabs below the tools outgrow a short window. The bleed
          padding keeps the active bar and running dot outside the scroll clip. */}
      <div data-testid="activity-rail-tabs" className="-mx-2 -my-1 flex min-h-0 shrink flex-col items-stretch gap-1 overflow-y-auto px-2 py-1 [scrollbar-width:none]">
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
  const focusWithinRef = useRef(false);
  // The rail grows leftward from the window edge, so expanding mid-press slides
  // the entry out from under the pointer and the click lands elsewhere.
  const pointerPressedRef = useRef(false);

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
    if (expanded || expandTimerRef.current !== null) return;
    expandTimerRef.current = setTimeout(() => {
      expandTimerRef.current = null;
      if (pointerWithinRef.current && !pointerPressedRef.current) setExpanded(true);
    }, RAIL_EXPAND_DELAY_MS);
  }, [clearCollapseTimer, expanded]);

  const scheduleCollapse = useCallback(() => {
    clearExpandTimer();
    clearCollapseTimer();
    collapseTimerRef.current = setTimeout(() => {
      collapseTimerRef.current = null;
      const focusWithin = railRef.current?.contains(document.activeElement) ?? false;
      focusWithinRef.current = focusWithin;
      if (!pointerWithinRef.current && !focusWithin) setExpanded(false);
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
    scheduleCollapse();
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
    focusWithinRef.current = true;
    clearExpandTimer();
    clearCollapseTimer();
    if (!pointerPressedRef.current) setExpanded(true);
  };

  const onBlurCapture = (event: ReactFocusEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    focusWithinRef.current = false;
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
      onSelect={onSelect}
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
