import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { prefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import type { ModelCause, SidebarItem, SidebarModel } from "./sidebar-model";
import { flyCopy, type FlightTarget } from "./flight-layer";

/** DESIGN.md motion tokens, in milliseconds, and the one ease curve. */
export const MOTION = { fast: 120, standard: 180, overlay: 240, ease: "cubic-bezier(0.2, 0, 0, 1)" } as const;

/** A big clock jump can move many rows; only this many on-screen copies fly, the rest just close. */
export const MAX_OLDER_FLIGHTS = 3;
/** Gap between consecutive Older flights, so the copies read as a sequence. */
export const OLDER_FLIGHT_STAGGER_MS = 90;

type ThreadKey = `thread:${string}`;

/** One planned transition, computed purely from two models and a cause. */
export type SidebarTransition =
  | { readonly type: "close-row"; readonly key: ThreadKey }
  | { readonly type: "fly"; readonly key: ThreadKey; readonly threadId: string; readonly to: FlightTarget; readonly delayMs: number }
  | { readonly type: "rise"; readonly key: ThreadKey };

/** What the planner reads besides the two models. */
export interface MotionContext {
  /** Thread row keys on screen before the change. */
  readonly visibleKeys: ReadonlySet<string>;
  readonly reducedMotion: boolean;
  /** Never flies: it stays listed under the Older bar. */
  readonly selectedThreadId: string | null;
}

type ThreadItem = Extract<SidebarItem, { kind: "thread" }>;

function departedThreads(prev: SidebarModel, next: SidebarModel): ThreadItem[] {
  const nextKeys = new Set(next.items.map((item) => item.key));
  return prev.items.filter((item): item is ThreadItem => item.kind === "thread" && !nextKeys.has(item.key));
}

function completionTransitions(departed: readonly ThreadItem[], prev: SidebarModel, next: SidebarModel, context: MotionContext): SidebarTransition[] {
  const out: SidebarTransition[] = [];
  for (const item of departed) {
    if (!next.completedIds.has(item.threadId) || prev.completedIds.has(item.threadId)) continue;
    out.push({ type: "close-row", key: item.key });
    if (context.visibleKeys.has(item.key)) out.push({ type: "fly", key: item.key, threadId: item.threadId, to: "completed-segment", delayMs: 0 });
  }
  return out;
}

function olderTransitions(departed: readonly ThreadItem[], prev: SidebarModel, next: SidebarModel, context: MotionContext): SidebarTransition[] {
  const out: SidebarTransition[] = [];
  let flights = 0;
  for (const item of departed) {
    if (!next.olderIds.has(item.threadId) || prev.olderIds.has(item.threadId)) continue;
    out.push({ type: "close-row", key: item.key });
    const flies = flights < MAX_OLDER_FLIGHTS && context.visibleKeys.has(item.key) && item.threadId !== context.selectedThreadId;
    if (!flies) continue;
    out.push({ type: "fly", key: item.key, threadId: item.threadId, to: "older-bar", delayMs: flights * OLDER_FLIGHT_STAGGER_MS });
    flights += 1;
  }
  return out;
}

function riseTransitions(prev: SidebarModel, next: SidebarModel): SidebarTransition[] {
  return next.items.flatMap((item): SidebarTransition[] =>
    item.kind === "thread" && prev.olderIds.has(item.threadId) && !next.olderIds.has(item.threadId) ? [{ type: "rise", key: item.key }] : []);
}

/**
 * Plans how the list gets from `prev` to `next`. Hydration, layout changes and reduced motion
 * plan nothing, so their state applies at once.
 * - A row that leaves Active because it completed closes, and flies to the Completed segment
 *   when it was on screen.
 * - Rows that cross into Older all close; the first {@link MAX_OLDER_FLIGHTS} on screen also fly
 *   to the Older bar, staggered. The selected thread never flies.
 * - A push that brings a thread back out of Older plays a short rise.
 */
export function planTransitions(prev: SidebarModel, next: SidebarModel, cause: ModelCause, context: MotionContext): readonly SidebarTransition[] {
  if (context.reducedMotion || cause === "snapshot" || cause === "layout") return [];
  const departed = departedThreads(prev, next);
  return [
    ...completionTransitions(departed, prev, next, context),
    ...olderTransitions(departed, prev, next, context),
    ...(cause === "push" ? riseTransitions(prev, next) : []),
  ];
}

/** What the list renders and the scope bar counts. */
export interface ShownSidebar {
  /** Model items plus rows still closing, kept at their old index until the close finishes. */
  readonly items: readonly SidebarItem[];
  /** The model's count minus copies still flying to the segment, so the number rises on landing. */
  readonly completedCount: number;
  /** Thread ids whose copies are still in the air. */
  readonly flying: ReadonlySet<string>;
  /** Row keys playing their close. */
  readonly closing: ReadonlySet<string>;
  /** Row keys playing their rise back out of Older. */
  readonly arriving: ReadonlySet<string>;
}

/** The DOM the motion layer reads and drives. Tests replace it. */
export interface MotionEnvironment {
  visibleKeys(): ReadonlySet<string>;
  reducedMotion(): boolean;
  /** Flies a copy of the row's title line and resolves when it lands. */
  fly(transition: Extract<SidebarTransition, { type: "fly" }>): Promise<void>;
}

/** How long a closing row stays in the list while it folds away. */
export const CLOSE_MS = MOTION.overlay;

function domVisibleKeys(): ReadonlySet<string> {
  const keys = new Set<string>();
  const list = document.querySelector("[data-testid='thread-list']");
  if (!list) return keys;
  const bounds = list.getBoundingClientRect();
  for (const row of list.querySelectorAll<HTMLElement>("[data-testid='thread-item']")) {
    const rect = row.getBoundingClientRect();
    if (rect.height > 0 && rect.bottom > bounds.top && rect.top < bounds.bottom) keys.add(`thread:${row.dataset.threadId ?? ""}`);
  }
  return keys;
}

const DOM_ENVIRONMENT: MotionEnvironment = {
  visibleKeys: domVisibleKeys,
  reducedMotion: prefersReducedMotion,
  fly: (transition) => flyCopy(transition.threadId, transition.to, { delayMs: transition.delayMs, durationMs: MOTION.overlay, easing: MOTION.ease }),
};

interface ClosingRow {
  readonly item: SidebarItem;
  readonly index: number;
}

interface MotionState {
  readonly model: SidebarModel;
  readonly closing: ReadonlyMap<string, ClosingRow>;
  readonly flying: ReadonlySet<string>;
  /** Threads closing into Older whose batch is still flying; the bar counts them in on landing. */
  readonly olderInbound: ReadonlySet<string>;
  readonly arriving: ReadonlySet<string>;
  /** Transitions planned by the last model change, launched once after it commits. */
  readonly launch: readonly SidebarTransition[];
}

function without<T>(set: ReadonlySet<T>, values: Iterable<T>): ReadonlySet<T> {
  const next = new Set(set);
  for (const value of values) next.delete(value);
  return next;
}

function threadIdOf(item: SidebarItem | undefined): string | null {
  return item?.kind === "thread" ? item.threadId : null;
}

function advance(state: MotionState, model: SidebarModel, plan: readonly SidebarTransition[]): MotionState {
  const closing = new Map(state.closing);
  const flying = new Set(state.flying);
  const olderInbound = new Set(state.olderInbound);
  const arriving = new Set(state.arriving);
  const indexes = new Map(shownItems(state).map((item, index) => [item.key, index]));
  const fliesToOlder = plan.some((transition) => transition.type === "fly" && transition.to === "older-bar");
  for (const transition of plan) {
    if (transition.type === "fly") flying.add(transition.threadId);
    if (transition.type === "rise") arriving.add(transition.key);
    if (transition.type !== "close-row") continue;
    const index = indexes.get(transition.key);
    const item = state.model.items.find((candidate) => candidate.key === transition.key);
    if (item && index !== undefined) closing.set(transition.key, { item, index });
    const threadId = threadIdOf(item);
    if (fliesToOlder && threadId !== null && model.olderIds.has(threadId)) olderInbound.add(threadId);
  }
  return { model, closing, flying, olderInbound, arriving, launch: plan };
}

function withOlderCount(items: readonly SidebarItem[], inbound: ReadonlySet<string>, olderIds: ReadonlySet<string>): readonly SidebarItem[] {
  let landing = 0;
  for (const id of inbound) if (olderIds.has(id)) landing += 1;
  if (landing === 0) return items;
  return items.map((item) => (item.kind === "older-bar" ? { ...item, count: Math.max(0, item.count - landing) } : item));
}

function shownItems(state: MotionState): readonly SidebarItem[] {
  const modelItems = withOlderCount(state.model.items, state.olderInbound, state.model.olderIds);
  if (state.closing.size === 0) return modelItems;
  const items = [...modelItems];
  const present = new Set(items.map((item) => item.key));
  const retained = [...state.closing.values()].filter((row) => !present.has(row.item.key)).sort((a, b) => a.index - b.index);
  // The end spacer stays last, so a closing row never lands below it.
  for (const row of retained) items.splice(Math.min(row.index, Math.max(0, items.length - 1)), 0, row.item);
  return items;
}

function useTimers(): (callback: () => void, ms: number) => void {
  const timers = useRef(new Set<number>());
  useEffect(() => () => {
    for (const timer of timers.current) window.clearTimeout(timer);
  }, []);
  return useRef((callback: () => void, ms: number) => {
    const timer = window.setTimeout(() => {
      timers.current.delete(timer);
      callback();
    }, ms);
    timers.current.add(timer);
  }).current;
}

/**
 * Runs {@link planTransitions} on each model change and merges the visual presence it plans over
 * the model: closing rows stay at their index while they fold, copies fly through the flight
 * layer, and the Completed count rises as each copy lands.
 */
export function useSidebarMotion(model: SidebarModel, cause: ModelCause, selectedThreadId: string | null, environment: MotionEnvironment = DOM_ENVIRONMENT): ShownSidebar {
  const [state, setState] = useState<MotionState>(() => ({ model, closing: new Map(), flying: new Set(), olderInbound: new Set(), arriving: new Set(), launch: [] }));
  const mounted = useRef(true);
  const later = useTimers();
  // Planned during render, from the DOM the previous commit left, so a departing row is measured
  // while it is still on screen and is retained in the same commit that would have removed it.
  if (state.model !== model) {
    const plan = planTransitions(state.model, model, cause, { visibleKeys: environment.visibleKeys(), reducedMotion: environment.reducedMotion(), selectedThreadId });
    setState(advance(state, model, plan));
  }

  // Set on every mount: StrictMode runs the cleanup once before the real mount.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useLayoutEffect(() => {
    const update = (change: (current: MotionState) => MotionState) => {
      if (mounted.current) setState(change);
    };
    const olderFlights: Promise<void>[] = [];
    for (const transition of state.launch) {
      if (transition.type === "close-row") {
        later(() => update((current) => ({ ...current, closing: new Map([...current.closing].filter(([key]) => key !== transition.key)) })), CLOSE_MS);
      } else if (transition.type === "rise") {
        later(() => update((current) => ({ ...current, arriving: without(current.arriving, [transition.key]) })), MOTION.standard);
      } else {
        const landed = environment.fly(transition).then(() => update((current) => ({ ...current, flying: without(current.flying, [transition.threadId]) })));
        if (transition.to === "older-bar") olderFlights.push(landed);
      }
    }
    if (olderFlights.length === 0) return;
    const batch = state.launch.flatMap((transition) => (transition.type === "close-row" ? [transition.key.slice("thread:".length)] : []));
    // Everything the batch moved counts in when its last copy lands.
    void Promise.all(olderFlights).then(() => update((current) => ({ ...current, olderInbound: without(current.olderInbound, batch) })));
  }, [state.launch, environment, later]);

  const items = useMemo(() => shownItems(state), [state]);
  const closing = useMemo(() => new Set(state.closing.keys()), [state.closing]);
  let landing = 0;
  for (const id of state.flying) if (model.completedIds.has(id)) landing += 1;
  return { items, completedCount: Math.max(0, model.scopeBar.completedCount - landing), flying: state.flying, closing, arriving: state.arriving };
}
