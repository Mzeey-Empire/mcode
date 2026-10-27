import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MeasuringStrategy,
  PointerSensor,
  closestCenter,
  pointerWithin,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
  type KeyboardSensorOptions,
  type PointerSensorOptions,
} from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { VirtualRows } from "@/components/ui/VirtualRows";
import { VirtualViewport, type VirtualHost, type VirtualRow, type ViewportPosition } from "@/components/ui/virtual-viewport";
import { usePreparingRowEntrance } from "@/features/thread-startup";
import { prefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { useWorkspaceStore } from "../state/workspaceStore";
import { selectPreparingThreadIds, selectSidebarFacts } from "../state/thread-index";
import type { SidebarItem } from "./sidebar-model";
import type { SidebarRowContext } from "./sidebar-row-context";
import { ProjectHeader, SortableProjectRow, type DropEdge } from "./SidebarProjectRow";
import { SidebarDraftRow } from "./SidebarDraftRow";
import { SidebarThreadRow } from "./SidebarThreadRow";
import { freezeOrder, useSidebarUiStore } from "./sidebar-ui-store";
import { OLDER_BAR_KEY, OlderBar } from "./OlderBar";
import { reactProfilingEnabled } from "@/performance/ReactPerformanceProfiler";

/** Provisional heights until the ResizeObserver measures; they only shape the first frame. */
const PROVISIONAL_HEIGHT: Record<SidebarItem["kind"], number> = {
  project: 32, draft: 32, thread: 64, "show-more": 28, "older-bar": 32, empty: 0, "end-spacer": 12,
};

const PROJECT_DND_MODIFIERS = [restrictToVerticalAxis];
// The virtual list mounts project droppables only near the viewport, so they must be measured as
// they register rather than once before the drag starts. Rows never displace during a project
// drag; the indicator line marks the landing boundary instead.
const STATIC_SORT_STRATEGY = () => null;
const PROJECT_DND_MEASURING = { droppable: { strategy: MeasuringStrategy.Always } } as const;
// The pointerup that ends a drag still fires click on whatever row it lands on.
const POST_DRAG_CLICK_GRACE_MS = 250;

// pointerWithin a header wins; elsewhere the pointer belongs to the vertically nearest header
// edge, so a drop over thread rows or past the list still lands instead of silently cancelling.
const projectHeaderCollision: CollisionDetection = (args) => {
  const within = pointerWithin(args);
  if (within.length > 0) return within;
  const { pointerCoordinates, droppableRects, droppableContainers } = args;
  if (!pointerCoordinates) return closestCenter(args);
  let nearest: (typeof droppableContainers)[number] | undefined;
  let nearestDistance = Infinity;
  for (const container of droppableContainers) {
    const rect = droppableRects.get(container.id);
    if (!rect) continue;
    const distance = Math.max(rect.top - pointerCoordinates.y, pointerCoordinates.y - rect.bottom, 0);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = container;
    }
  }
  return nearest ? [{ id: nearest.id, data: { droppableContainer: nearest, value: nearestDistance } }] : [];
};

/**
 * Picks which edge of the hovered header the dragged project inserts at. Pointer drags compare
 * the pointer against the header's midpoint; keyboard drags use the travel direction.
 */
function dropEdgeForEvent(event: DragMoveEvent | DragEndEvent): DropEdge | null {
  const over = event.over;
  if (!over || over.id === event.active.id) return null;
  const activator = event.activatorEvent;
  if (!(activator instanceof MouseEvent)) return event.delta.y < 0 ? "top" : "bottom";
  const pointerY = activator.clientY + event.delta.y;
  return pointerY < over.rect.top + over.rect.height / 2 ? "top" : "bottom";
}

function dropIndex(event: DragEndEvent, oldIndex: number, overIndex: number): number {
  const edge = dropEdgeForEvent(event);
  // Keyboard drags keep the sortable convention of taking the over item's index.
  if (edge === null || !(event.activatorEvent instanceof MouseEvent)) return overIndex;
  // The boundary counts positions before the dragged row is removed.
  const boundary = overIndex + (edge === "bottom" ? 1 : 0);
  return boundary > oldIndex ? boundary - 1 : boundary;
}

/** Stable scroll-position sink; the list only reads positions through anchors. */
function noopViewportPosition(_position: ViewportPosition): void {}

function useSidebarViewport(containerRef: React.RefObject<HTMLDivElement | null>) {
  const controllerRef = useRef<VirtualViewport | null>(null);
  const [hosts, setHosts] = useState<readonly VirtualHost[]>([]);
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const view = new VirtualViewport(container, setHosts, noopViewportPosition, { classPrefix: "project-tree", ariaLabel: "Projects", flowHostId: OLDER_BAR_KEY });
    controllerRef.current = view;
    return () => {
      view.destroy();
      controllerRef.current = null;
    };
  }, [containerRef]);
  return { controllerRef, hosts };
}

interface DropIndicator {
  readonly id: string;
  readonly edge: DropEdge;
}

function sameIndicator(a: DropIndicator | null, b: DropIndicator | null): boolean {
  return a === b || (a !== null && b !== null && a.id === b.id && a.edge === b.edge);
}

// useSensor memoizes on its options object, so inline options would rebuild every sortable's
// listeners on each list render and re-render every memoized project header.
const POINTER_SENSOR_OPTIONS: PointerSensorOptions = { activationConstraint: { distance: 5 } };
const KEYBOARD_SENSOR_OPTIONS: KeyboardSensorOptions = { coordinateGetter: sortableKeyboardCoordinates };

function useProjectDrag(controllerRef: React.RefObject<VirtualViewport | null>) {
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [dropIndicator, setDropIndicator] = useState<DropIndicator | null>(null);
  const suppressClickUntil = useRef(0);
  const sensors = useSensors(
    useSensor(PointerSensor, POINTER_SENSOR_OPTIONS),
    useSensor(KeyboardSensor, KEYBOARD_SENSOR_OPTIONS),
  );
  const endDrag = useCallback(() => {
    setActiveDragId(null);
    setDropIndicator(null);
    suppressClickUntil.current = Date.now() + POST_DRAG_CLICK_GRACE_MS;
  }, []);
  const onDragStart = useCallback((event: DragStartEvent) => setActiveDragId(String(event.active.id)), []);
  // onDragMove, not onDragOver: the edge tracks the pointer within one header, and onDragOver
  // only fires when the over target itself changes.
  const onDragMove = useCallback((event: DragMoveEvent) => {
    const edge = dropEdgeForEvent(event);
    const next = edge !== null && event.over ? { id: String(event.over.id), edge } : null;
    setDropIndicator((previous) => (sameIndicator(previous, next) ? previous : next));
  }, []);
  const onDragEnd = useCallback((event: DragEndEvent) => {
    endDrag();
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const workspaceIds = useWorkspaceStore.getState().workspaces.map((workspace) => workspace.id);
    const oldIndex = workspaceIds.indexOf(String(active.id));
    const overIndex = workspaceIds.indexOf(String(over.id));
    if (oldIndex < 0 || overIndex < 0) return;
    void useWorkspaceStore.getState().reorderWorkspace(String(active.id), dropIndex(event, oldIndex, overIndex));
  }, [endDrag]);
  // Only the list's own scroller may autoscroll, so outer sidebar regions are never pulled.
  const autoScroll = useMemo(() => ({
    canScroll: (element: Element) => controllerRef.current?.viewport === element,
  }), [controllerRef]);
  useLayoutEffect(() => {
    if (!activeDragId) return;
    const previous = document.body.style.cursor;
    document.body.style.cursor = "grabbing";
    return () => {
      document.body.style.cursor = previous;
    };
  }, [activeDragId]);
  const isClickSuppressed = useCallback(() => Date.now() < suppressClickUntil.current, []);
  return { activeDragId, dropIndicator, sensors, autoScroll, onDragStart, onDragMove, onDragEnd, onDragCancel: endDrag, isClickSuppressed };
}

/** Wraps the click handlers a drag release could trigger, so the drop never toggles or navigates. */
function useDragSafeContext(ctx: SidebarRowContext, isClickSuppressed: () => boolean): SidebarRowContext {
  return useMemo(() => ({
    ...ctx,
    onToggleProject: (workspaceId, section) => {
      if (!isClickSuppressed()) ctx.onToggleProject(workspaceId, section);
    },
    onThreadClick: (workspaceId, threadId) => {
      if (!isClickSuppressed()) ctx.onThreadClick(workspaceId, threadId);
    },
  }), [ctx, isClickSuppressed]);
}

function ShowMoreRow({ item }: { item: Extract<SidebarItem, { kind: "show-more" }> }) {
  const toggleShowMore = useSidebarUiStore((state) => state.toggleShowMore);
  const label = item.expanded ? "Show less" : `Show more (${item.hidden})`;
  return (
    <Button variant="ghost" size="compact" onClick={() => toggleShowMore(item.workspaceId)} className="mt-0.5 mb-1 h-auto w-full justify-start rounded-md px-2 py-1 text-caption font-normal text-muted/55 hover:bg-selected/40 hover:text-ink">
      {label}
    </Button>
  );
}

const SidebarRow = memo(function SidebarRow({ item, ctx, dropEdge }: { item: SidebarItem; ctx: SidebarRowContext; dropEdge: DropEdge | null }) {
  switch (item.kind) {
    case "project":
      return item.section === "recent" ? <SortableProjectRow item={item} ctx={ctx} dropEdge={dropEdge} /> : <ProjectHeader item={item} ctx={ctx} />;
    case "draft":
      return <div data-testid="draft-item" data-draft-id={item.draftId}><SidebarDraftRow item={item} ctx={ctx} /></div>;
    case "thread":
      return <div data-testid="thread-item" data-thread-id={item.threadId}><SidebarThreadRow item={item} ctx={ctx} /></div>;
    case "show-more":
      return <ShowMoreRow item={item} />;
    // The Older bar lives in the viewport's sticky flow host, never in a recycled row.
    case "older-bar":
    case "empty":
      return null;
    case "end-spacer":
      return <div aria-hidden className="h-3" />;
  }
});

function toVirtualRows(items: readonly SidebarItem[]): VirtualRow[] {
  return items.map((item) => ({ id: item.key, height: PROVISIONAL_HEIGHT[item.kind] }));
}

/**
 * Publishes the rows and owns the Older bar's open-and-rise: opening the section scrolls once the
 * new rows land so the bar rises to the top with the Older threads below it.
 */
function useOlderRise(controllerRef: React.RefObject<VirtualViewport | null>, items: readonly SidebarItem[], rows: readonly VirtualRow[], flip: boolean) {
  const olderOpen = useSidebarUiStore((state) => state.olderOpen);
  const toggleOlderSection = useSidebarUiStore((state) => state.toggleOlder);
  const riseRef = useRef(false);
  const olderBar = useMemo(() => items.find((item): item is Extract<SidebarItem, { kind: "older-bar" }> => item.kind === "older-bar"), [items]);
  useLayoutEffect(() => {
    const viewport = controllerRef.current;
    if (!viewport) return;
    viewport.setRows(rows, { flip });
    if (reactProfilingEnabled) window.__mcodeReactPerformanceSink?.recordCounter?.("sidebar.setRows");
    if (!riseRef.current) return;
    riseRef.current = false;
    viewport.moveTo({ kind: "target", key: OLDER_BAR_KEY, align: "start" }, !prefersReducedMotion(), { release: true });
  }, [controllerRef, rows, flip]);
  const toggleOlder = useCallback(() => {
    riseRef.current = !olderOpen;
    toggleOlderSection();
  }, [olderOpen, toggleOlderSection]);
  return { olderBar, toggleOlder };
}

/** Thread and draft row keys plus the preparing threads among them, for the first-send entrance. */
function useEntranceKeys(items: readonly SidebarItem[]): { rowKeys: string[]; preparing: string[] } {
  const preparingIds = useWorkspaceStore((state) => selectPreparingThreadIds(state.threads));
  return useMemo(() => {
    const rowKeys: string[] = [];
    const preparing: string[] = [];
    for (const item of items) {
      if (item.kind === "draft") rowKeys.push(`draft:${item.draftId}`);
      if (item.kind !== "thread") continue;
      rowKeys.push(item.threadId);
      if (preparingIds.has(item.threadId)) preparing.push(item.threadId);
    }
    return { rowKeys, preparing };
  }, [items, preparingIds]);
}

interface SidebarListProps {
  readonly items: readonly SidebarItem[];
  readonly ctx: SidebarRowContext;
  /** Rendered over the list when it has nothing to show, such as the empty-projects drop well. */
  readonly overlay?: ReactNode;
  /** Slide rows that moved. True only for live pushes, never for hydration or layout changes. */
  readonly flip?: boolean;
  /** Row keys folding away after they left the model. */
  readonly closing?: ReadonlySet<string>;
  /** Row keys rising back out of Older. */
  readonly arriving?: ReadonlySet<string>;
}

const NO_KEYS: ReadonlySet<string> = new Set();

const freezeOnEnter = () => useSidebarUiStore.getState().freeze(freezeOrder(selectSidebarFacts(useWorkspaceStore.getState().threads), Date.now()));
const unfreezeOnLeave = () => useSidebarUiStore.getState().unfreeze();

/**
 * Renders the derived sidebar items into one virtual list, one virtual row per item. It never
 * filters, sorts or caps: the model already did. Project headers in the recent list drag to
 * reorder projects.
 */
export function SidebarList({ items, ctx, overlay, flip = false, closing = NO_KEYS, arriving = NO_KEYS }: SidebarListProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { controllerRef, hosts } = useSidebarViewport(containerRef);
  const drag = useProjectDrag(controllerRef);
  const rowCtx = useDragSafeContext(ctx, drag.isClickSuppressed);
  const rows = useMemo(() => toVirtualRows(items), [items]);
  const itemsByKey = useMemo(() => new Map<string, SidebarItem>(items.map((item) => [item.key, item])), [items]);
  const sortableIds = useMemo(() => items.flatMap((item) => (item.kind === "project" && item.section === "recent" ? [item.workspaceId] : [])), [items]);
  const entrance = useEntranceKeys(items);
  usePreparingRowEntrance(containerRef, entrance.rowKeys, entrance.preparing);

  const { olderBar, toggleOlder } = useOlderRise(controllerRef, items, rows, flip);

  const { dropIndicator } = drag;
  const renderRow = useCallback((item: SidebarItem): ReactNode => {
    const dropEdge = item.kind === "project" && dropIndicator?.id === item.workspaceId ? dropIndicator.edge : null;
    const isClosing = closing.has(item.key);
    return (
      <div className={cn("px-1.5", isClosing && "sidebar-row-closing", arriving.has(item.key) && "sidebar-row-rise")} inert={isClosing || undefined}>
        <div className={cn(isClosing && "min-h-0 overflow-hidden")}><SidebarRow item={item} ctx={rowCtx} dropEdge={dropEdge} /></div>
      </div>
    );
  }, [rowCtx, dropIndicator, closing, arriving]);

  const dragged = drag.activeDragId === null ? undefined : itemsByKey.get(`project:${drag.activeDragId}`);
  return (
    <div className="relative isolate min-h-0 flex-1" onPointerEnter={freezeOnEnter} onPointerLeave={unfreezeOnLeave}>
      <div ref={containerRef} data-testid="thread-list" className="h-full" />
      <DndContext
        sensors={drag.sensors}
        collisionDetection={projectHeaderCollision}
        modifiers={PROJECT_DND_MODIFIERS}
        measuring={PROJECT_DND_MEASURING}
        autoScroll={drag.autoScroll}
        onDragStart={drag.onDragStart}
        onDragMove={drag.onDragMove}
        onDragEnd={drag.onDragEnd}
        onDragCancel={drag.onDragCancel}
      >
        <SortableContext items={sortableIds} strategy={STATIC_SORT_STRATEGY}>
          <VirtualRows viewport={controllerRef.current} hosts={hosts} items={itemsByKey} renderItem={renderRow} />
        </SortableContext>
        <DragOverlay>
          {dragged?.kind === "project" ? <div className="px-1.5"><ProjectHeader item={dragged} ctx={rowCtx} /></div> : null}
        </DragOverlay>
      </DndContext>
      {olderBar && controllerRef.current && <OlderBar item={olderBar} viewport={controllerRef.current} onToggle={toggleOlder} />}
      {overlay}
    </div>
  );
}
