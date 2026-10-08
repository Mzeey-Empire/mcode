import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type WheelEvent,
  type RefObject,
} from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatusMark, type StatusMarkState } from "@/components/ui/status-mark";
import { overviewResponsivePaddingPx } from "@/lib/composer-layout";
import { SwipeVelocity } from "@/lib/swipe-velocity";
import { layoutToastStack, mergeToastPresence, type ToastPresence } from "@/lib/toast-presence";
import { cn } from "@/lib/utils";
import { useToastStore, type Toast, type ToastKind } from "@/stores/toastStore";

/** 8px under the 48px conversation header. */
const LANE_TOP_PX = 56;
const EXIT_MS = 240;
const REDUCED_EXIT_MS = 120;
const SWIPE_EXIT_MS = 160;
const SWIPE_DISMISS_FRACTION = 0.35;
const FLICK_PX_PER_MS = 0.5;
/** A pause in trackpad scroll this long ends the swipe. */
const WHEEL_GESTURE_END_MS = 120;
/** Pointer travel below this is a click, not a swipe. */
const DRAG_SLOP_PX = 4;

const KIND_STYLE: Record<ToastKind, { mark: StatusMarkState; label: string; tone: string; role: "status" | "alert" }> = {
  finished: { mark: "success", label: "Finished", tone: "text-success", role: "status" },
  "needs-you": { mark: "attention", label: "Needs you", tone: "text-primary", role: "alert" },
  failed: { mark: "error", label: "Failed", tone: "text-error", role: "alert" },
  info: { mark: "info", label: "Info", tone: "text-muted", role: "status" },
};

const prefersReducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

interface LaneColumn {
  readonly left: number;
  readonly top: number;
  readonly width: number;
}

function measureColumn(element: HTMLElement | null, reserveOverview: boolean): LaneColumn {
  if (!element) return { left: 0, top: 0, width: window.innerWidth };
  const rect = element.getBoundingClientRect();
  const reserve = reserveOverview ? overviewResponsivePaddingPx(rect.width) : 0;
  return { left: rect.left, top: rect.top, width: rect.width - reserve };
}

const sameColumn = (a: LaneColumn | null, b: LaneColumn) =>
  a?.left === b.left && a.top === b.top && a.width === b.width;

/** Tracks the box the lane centres on: the conversation column, or the main surface outside chat. */
function useLaneColumn(
  anchor: HTMLElement | null,
  fallbackRef: RefObject<HTMLElement | null>,
  reserveOverview: boolean,
): LaneColumn | null {
  const [column, setColumn] = useState<LaneColumn | null>(null);
  useLayoutEffect(() => {
    const element = anchor ?? fallbackRef.current;
    const update = () => {
      const next = measureColumn(element, reserveOverview);
      setColumn((current) => (sameColumn(current, next) ? current : next));
    };
    update();
    const observer = new ResizeObserver(update);
    if (element) observer.observe(element);
    window.addEventListener("resize", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [anchor, fallbackRef, reserveOverview]);
  return column;
}

/** Keeps toasts that left the store on screen until their exit animation ends. */
function useToastPresence(heights: ReadonlyMap<string, number>) {
  const toasts = useToastStore((state) => state.toasts);
  const [presence, setPresence] = useState(() => ({
    source: toasts,
    entries: toasts.map((toast): ToastPresence => ({ toast, exiting: false, offset: 0 })),
  }));
  let entries = presence.entries;
  if (presence.source !== toasts) {
    entries = mergeToastPresence(presence.entries, toasts, layoutToastStack(presence.entries, heights));
    setPresence({ source: toasts, entries });
  }
  const remove = useCallback((id: string) => {
    setPresence((current) => ({ ...current, entries: current.entries.filter((entry) => entry.toast.id !== id) }));
  }, []);
  return { entries, remove };
}

/** Props for {@link ToastLane}. */
export interface ToastLaneProps {
  /** The main surface. Null when it is not mounted, for example while the right panel is maximized. */
  anchor: HTMLElement | null;
  /** Where the lane centres when `anchor` is null. */
  fallbackRef: RefObject<HTMLElement | null>;
  /** Whether the conversation column gives up its right edge to the Overview. */
  reserveOverview: boolean;
}

/**
 * The app's one toast lane: up to three toasts, newest on top, centred on the
 * conversation column under its header. Toasts never take focus.
 */
export function ToastLane({ anchor, fallbackRef, reserveOverview }: ToastLaneProps) {
  const column = useLaneColumn(anchor, fallbackRef, reserveOverview);
  const [heights, setHeights] = useState<ReadonlyMap<string, number>>(() => new Map());
  const { entries, remove } = useToastPresence(heights);
  const offsets = layoutToastStack(entries, heights);

  const reportHeight = useCallback((id: string, height: number) => {
    setHeights((current) => (current.get(id) === height ? current : new Map(current).set(id, height)));
  }, []);
  const removeExited = useCallback((id: string) => {
    remove(id);
    setHeights((current) => {
      const next = new Map(current);
      next.delete(id);
      return next;
    });
  }, [remove]);

  if (!column) return null;
  return (
    <section
      aria-label="Notifications"
      className="pointer-events-none fixed z-(--layer-toast) w-85 -translate-x-1/2"
      style={{ top: column.top + LANE_TOP_PX, left: column.left + column.width / 2 }}
    >
      {entries.map((entry) => (
        <ToastCard
          key={entry.toast.id}
          entry={entry}
          offset={entry.exiting ? entry.offset : offsets.get(entry.toast.id) ?? 0}
          onHeight={reportHeight}
          onExited={removeExited}
        />
      ))}
    </section>
  );
}

interface ToastCardProps {
  entry: ToastPresence;
  offset: number;
  onHeight: (id: string, height: number) => void;
  onExited: (id: string) => void;
}

function useReportedHeight(id: string, onHeight: ToastCardProps["onHeight"]) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const report = () => onHeight(id, element.offsetHeight);
    report();
    const observer = new ResizeObserver(report);
    observer.observe(element);
    return () => observer.disconnect();
  }, [id, onHeight]);
  return ref;
}

function useExitTimer(id: string, exiting: boolean, onExited: ToastCardProps["onExited"]) {
  useEffect(() => {
    if (!exiting) return;
    const timer = setTimeout(() => onExited(id), prefersReducedMotion() ? REDUCED_EXIT_MS : EXIT_MS);
    return () => clearTimeout(timer);
  }, [id, exiting, onExited]);
}

function ToastCard({ entry, offset, onHeight, onExited }: ToastCardProps) {
  const { toast, exiting } = entry;
  const { dismiss, pause, resume } = useToastStore.getState();
  const ref = useReportedHeight(toast.id, onHeight);
  const dismissThis = useCallback(() => dismiss(toast.id), [dismiss, toast.id]);
  const swipe = useSwipeToDismiss(dismissThis);
  useExitTimer(toast.id, exiting, onExited);
  const kind = KIND_STYLE[toast.kind];

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    dismiss(toast.id);
  };

  return (
    <div
      ref={ref}
      className="absolute inset-x-0 top-0 transition-transform duration-200 ease-standard motion-reduce:transition-none"
      style={{ transform: `translateY(${offset}px)` }}
    >
      <div className={exiting ? "animate-toast-exit" : "animate-toast-enter"} inert={exiting}>
        <div
          role={kind.role}
          data-toast-kind={toast.kind}
          className="group pointer-events-auto relative flex touch-pan-y items-start gap-3 rounded-dialog bg-selected py-3 pr-2.5 pl-4 shadow-floating transition-colors hover:bg-border"
          style={swipe.style}
          onPointerEnter={() => pause(toast.id)}
          onPointerLeave={() => resume(toast.id)}
          onKeyDown={handleKeyDown}
          {...swipe.handlers}
        >
          <ToastBody toast={toast} onOpen={() => openToast(toast, dismiss)} />
          <Button
            variant="ghost"
            size="icon-inline-sm"
            shape="round"
            aria-label="Dismiss"
            data-toast-close=""
            onClick={() => dismiss(toast.id)}
          >
            <X className="size-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}

/** A throwing `onOpen` skips the dismiss, so the toast stays for another try. */
function openToast(toast: Toast, dismiss: (id: string) => void) {
  toast.onOpen?.();
  dismiss(toast.id);
}

function ToastBody({ toast, onOpen }: { toast: Toast; onOpen: () => void }) {
  const kind = KIND_STYLE[toast.kind];
  const content = (
    <>
      <StatusMark state={kind.mark} label={kind.label} className="mt-0.5" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="block text-label text-ink text-fade">{toast.title}</span>
        {toast.meta ? <ToastMeta meta={toast.meta} tone={kind.tone} /> : null}
      </span>
    </>
  );
  const className = "flex min-w-0 flex-1 items-start gap-3 text-left";
  if (!toast.onOpen) return <div className={className}>{content}</div>;
  // The stretched ::after makes the whole card the open target; the close button follows it in the DOM, so it paints on top.
  return (
    <button
      type="button"
      className={cn(
        className,
        "outline-none after:absolute after:inset-0 after:rounded-dialog focus-visible:after:outline-2 focus-visible:after:outline-offset-2 focus-visible:after:outline-solid focus-visible:after:outline-focus",
      )}
      onClick={onOpen}
    >
      {content}
    </button>
  );
}

/** The label before the first ` · ` takes the kind's colour; the rest is muted. */
function ToastMeta({ meta, tone }: { meta: string; tone: string }) {
  const separator = meta.indexOf(" · ");
  return (
    <span className="block text-caption text-muted text-fade-lines-2">
      {separator > 0 ? <span className={tone}>{meta.slice(0, separator)}</span> : null}
      {separator > 0 ? meta.slice(separator) : meta}
    </span>
  );
}

type SwipePhase = "idle" | "dragging" | "settling" | "flung";

interface SwipeState {
  readonly phase: SwipePhase;
  readonly dx: number;
  readonly width: number;
}

interface WheelGesture {
  dx: number;
  peakPxPerMs: number;
  readonly velocity: SwipeVelocity;
  timer: ReturnType<typeof setTimeout> | null;
}

interface DragStart {
  readonly x: number;
  readonly pointerId: number;
}

const isCloseButton = (target: EventTarget) =>
  target instanceof Element && target.closest("[data-toast-close]") !== null;

function swipeStyle({ phase, dx, width }: SwipeState): CSSProperties | undefined {
  if (phase === "idle") return undefined;
  const ms = phase === "dragging" ? 0 : phase === "flung" ? SWIPE_EXIT_MS : 200;
  return {
    transform: `translateX(${dx}px)`,
    opacity: 1 - Math.min(1, Math.abs(dx) / width),
    transition: `transform ${ms}ms var(--ease-standard), opacity ${ms}ms var(--ease-standard)`,
  };
}

/**
 * Horizontal swipe by pointer drag or sideways trackpad scroll: the card follows
 * and fades with distance. Past 35% of its width, or on a flick, it flies out;
 * otherwise it springs back. Under reduced motion the card stays still and a
 * dismissing swipe plays the normal fade.
 */
function useSwipeToDismiss(onDismiss: () => void) {
  const start = useRef<DragStart | null>(null);
  const dragged = useRef(false);
  const velocity = useRef(new SwipeVelocity());
  const wheel = useRef<WheelGesture>({ dx: 0, peakPxPerMs: 0, velocity: new SwipeVelocity(), timer: null });
  const [swipe, setSwipe] = useState<SwipeState>({ phase: "idle", dx: 0, width: 1 });

  useEffect(() => {
    if (swipe.phase !== "flung") return;
    const timer = setTimeout(onDismiss, SWIPE_EXIT_MS);
    return () => clearTimeout(timer);
  }, [swipe.phase, onDismiss]);

  // Called on unmount and when a pointer drag takes over, so a stale wheel end can't undo the drag.
  const cancelWheel = useCallback(() => {
    const gesture = wheel.current;
    clearTimeout(gesture.timer ?? undefined);
    gesture.timer = null;
    gesture.dx = 0;
    gesture.peakPxPerMs = 0;
  }, []);

  useEffect(() => cancelWheel, [cancelWheel]);

  const follow = (dx: number, width: number) => {
    if (!prefersReducedMotion()) setSwipe({ phase: "dragging", dx, width });
  };

  const release = (dx: number, width: number, pxPerMs: number) => {
    if (Math.abs(dx) <= width * SWIPE_DISMISS_FRACTION && pxPerMs <= FLICK_PX_PER_MS) {
      setSwipe({ phase: "settling", dx: 0, width });
    } else if (prefersReducedMotion()) {
      onDismiss();
    } else {
      setSwipe({ phase: "flung", dx: Math.sign(dx) * width, width });
    }
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || isCloseButton(event.target)) return;
    start.current = { x: event.clientX, pointerId: event.pointerId };
    velocity.current.reset({ x: event.clientX, time: event.timeStamp });
    dragged.current = false;
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const origin = start.current;
    if (!origin || event.pointerId !== origin.pointerId) return;
    velocity.current.track({ x: event.clientX, time: event.timeStamp });
    const dx = event.clientX - origin.x;
    if (!dragged.current && Math.abs(dx) < DRAG_SLOP_PX) return;
    if (!dragged.current) {
      dragged.current = true;
      cancelWheel();
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    follow(dx, event.currentTarget.offsetWidth);
  };

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const origin = start.current;
    start.current = null;
    if (!origin || !dragged.current) return;
    const sample = { x: event.clientX, time: event.timeStamp };
    release(event.clientX - origin.x, event.currentTarget.offsetWidth, velocity.current.pxPerMs(sample));
  };

  const onPointerCancel = () => {
    start.current = null;
    setSwipe((current) => (current.phase === "idle" ? current : { ...current, phase: "settling", dx: 0 }));
  };

  // A trackpad swipe arrives as horizontal wheel deltas with no end event; a short quiet gap ends it.
  // Momentum decays the speed toward the end, so the gesture's peak speed decides a flick.
  const onWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (start.current || swipe.phase === "flung" || Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
    const width = event.currentTarget.offsetWidth;
    const gesture = wheel.current;
    if (gesture.timer === null) gesture.velocity.reset({ x: 0, time: event.timeStamp });
    gesture.dx -= event.deltaX;
    const sample = { x: gesture.dx, time: event.timeStamp };
    gesture.peakPxPerMs = Math.max(gesture.peakPxPerMs, gesture.velocity.pxPerMs(sample));
    gesture.velocity.track(sample);
    follow(gesture.dx, width);
    clearTimeout(gesture.timer ?? undefined);
    gesture.timer = setTimeout(() => {
      const { dx, peakPxPerMs } = gesture;
      cancelWheel();
      release(dx, width, peakPxPerMs);
    }, WHEEL_GESTURE_END_MS);
  };

  // A drag ends with a click on whatever is under the pointer; it must not open the toast.
  const onClickCapture = (event: MouseEvent) => {
    if (!dragged.current) return;
    dragged.current = false;
    event.preventDefault();
    event.stopPropagation();
  };

  return {
    style: swipeStyle(swipe),
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onWheel, onClickCapture },
  };
}
