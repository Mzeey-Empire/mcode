import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type ComponentPropsWithoutRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";

/** DESIGN.md's Arrow step, `1.6rem` at the app's 10px root. */
const KEYBOARD_RESIZE_STEP_PX = 16;
/** DESIGN.md's Shift+Arrow step, `4.8rem` at the app's 10px root. */
const KEYBOARD_RESIZE_LARGE_STEP_PX = 48;
const KEYBOARD_RESIZE_KEYS: ReadonlySet<string> = new Set(["ArrowLeft", "ArrowRight", "Home", "End"]);
/** Extra drag distance past minWidth that snaps the panel closed. */
const COLLAPSE_DRAG_PAST_MIN_PX = 64;

/** Ownership source reported when a controlled panel width changes. */
export type ResizablePanelWidthSource = "preserve" | "user";

/** Props for the shared controlled right-panel resize shell. */
export interface ResizableRightPanelProps extends Omit<
  ComponentPropsWithoutRef<"div">,
  "children" | "style"
> {
  children: ReactNode;
  width: number;
  minWidth: number;
  maxWidth: CSSProperties["maxWidth"];
  getMaxWidth: (panel: HTMLDivElement | null) => number;
  defaultWidth: number;
  wideWidth: number;
  separatorLabel: string;
  onWidthChange: (width: number, source: ResizablePanelWidthSource) => void;
  /** Fired when the user drags the separator past minWidth by the snap distance. */
  onCollapseRequest?: () => void;
  resizeEnabled?: boolean;
  className?: string;
  style?: CSSProperties;
  testId?: string;
}

/** Provides the shared drag, keyboard, snap, and clamp behavior for right panels. */
export function ResizableRightPanel({
  children,
  width,
  minWidth,
  maxWidth,
  getMaxWidth,
  defaultWidth,
  wideWidth,
  separatorLabel,
  onWidthChange,
  onCollapseRequest,
  resizeEnabled = true,
  className,
  style,
  testId,
  ...panelProps
}: ResizableRightPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const widthRef = useRef(width);
  const draggingRef = useRef(false);
  const dragListenersRef = useRef<{
    move: (event: globalThis.MouseEvent) => void;
    up: () => void;
  } | null>(null);

  useEffect(() => {
    widthRef.current = width;
  }, [width]);

  const clampWidth = useCallback(
    (candidate: number) =>
      Math.max(minWidth, Math.min(candidate, getMaxWidth(panelRef.current))),
    [getMaxWidth, minWidth],
  );

  useEffect(() => {
    if (!resizeEnabled || typeof ResizeObserver === "undefined") return;
    const parent = panelRef.current?.parentElement;
    if (!parent) return;

    const clampToParent = () => {
      const nextWidth = clampWidth(widthRef.current);
      if (nextWidth !== widthRef.current) {
        onWidthChange(nextWidth, "preserve");
      }
    };

    clampToParent();
    let frame: number | null = null;
    const observer = new ResizeObserver(() => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        clampToParent();
      });
    });
    observer.observe(parent);
    return () => {
      observer.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [clampWidth, onWidthChange, resizeEnabled]);

  const stopDragging = useCallback(() => {
    draggingRef.current = false;
    const listeners = dragListenersRef.current;
    if (!listeners) return;
    document.removeEventListener("mousemove", listeners.move);
    document.removeEventListener("mouseup", listeners.up);
    dragListenersRef.current = null;
  }, []);

  useEffect(() => stopDragging, [stopDragging]);

  const handleDragStart = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      stopDragging();
      draggingRef.current = true;
      const startX = event.clientX;
      const startWidth = width;
      const handleMove = (moveEvent: globalThis.MouseEvent) => {
        if (!draggingRef.current) return;
        const candidate = startWidth + startX - moveEvent.clientX;
        if (onCollapseRequest && candidate < minWidth - COLLAPSE_DRAG_PAST_MIN_PX) {
          stopDragging();
          onCollapseRequest();
          return;
        }
        onWidthChange(clampWidth(candidate), "user");
      };
      const handleUp = () => stopDragging();
      dragListenersRef.current = { move: handleMove, up: handleUp };
      document.addEventListener("mousemove", handleMove);
      document.addEventListener("mouseup", handleUp);
    },
    [clampWidth, minWidth, onCollapseRequest, onWidthChange, stopDragging, width],
  );

  const toggleSnapWidth = useCallback(() => {
    const target = width >= wideWidth ? defaultWidth : wideWidth;
    onWidthChange(clampWidth(target), "user");
  }, [clampWidth, defaultWidth, onWidthChange, wideWidth, width]);

  const hintId = useId();
  const [announcement, setAnnouncement] = useState("");
  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        toggleSnapWidth();
        return;
      }
      const target = keyboardResizeTarget(event, width, minWidth, getMaxWidth(panelRef.current));
      if (target === null) return;
      event.preventDefault();
      onWidthChange(clampWidth(target), "user");
    },
    [clampWidth, getMaxWidth, minWidth, onWidthChange, toggleSnapWidth, width],
  );
  // Held arrows repeat keydown, so the width settles on keyup and is announced once there, not per step.
  const handleKeyUp = useCallback((event: ReactKeyboardEvent) => {
    if (!KEYBOARD_RESIZE_KEYS.has(event.key)) return;
    setAnnouncement(`Panel width ${widthRef.current} pixels`);
  }, []);

  return (
    <div
      ref={panelRef}
      {...panelProps}
      data-testid={testId}
      style={resizeEnabled ? { width, minWidth, maxWidth, ...style } : style}
      className={cn("relative min-h-0 min-w-0", className)}
    >
      {resizeEnabled && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={separatorLabel}
          aria-valuemin={minWidth}
          aria-valuemax={getMaxWidth(panelRef.current)}
          aria-valuenow={width}
          aria-valuetext={`${width} pixels wide`}
          aria-describedby={hintId}
          tabIndex={0}
          className="group absolute inset-y-0 left-0 z-(--layer-modal-backdrop) flex w-2 cursor-col-resize items-stretch justify-start focus:outline-none"
          onMouseDown={handleDragStart}
          onDoubleClick={toggleSnapWidth}
          onKeyDown={handleKeyDown}
          onKeyUp={handleKeyUp}
        >
          <span
            aria-hidden
            className="pointer-events-none w-px shrink-0 bg-border/45 transition-colors group-hover:bg-border group-focus-visible:w-0.5 group-focus-visible:bg-focus group-active:w-0.5 group-active:bg-muted/60"
          />
          {/* A focused seam looks like any focus ring, so a keyboard user learns here that it resizes and how.
              It wraps at 28rem: on one line it ran past the window edge of a narrow panel. */}
          <span
            data-testid="panel-resize-hint"
            className="pointer-events-none absolute top-[5.6rem] left-3 z-(--layer-tooltip) hidden w-max max-w-[28rem] items-baseline gap-2 rounded-menu border border-border bg-panel px-3 py-[7px] text-caption text-ink group-focus-visible:inline-flex"
          >
            <span aria-hidden className="shrink-0 font-mono tabular-nums">{width} px</span>
            <span id={hintId} className="text-muted">
              Left and Right arrows resize, Shift for larger steps, Home and End for the limits
            </span>
          </span>
        </div>
      )}
      {resizeEnabled && (
        <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">
          {announcement}
        </span>
      )}
      {children}
    </div>
  );
}

/**
 * Width a resize key asks for. The seam sits on the panel's left edge, so ArrowLeft moves it left and widens the
 * panel. Home and End jump to the minimum and maximum widths.
 */
function keyboardResizeTarget(
  event: Pick<ReactKeyboardEvent, "key" | "shiftKey">,
  width: number,
  minWidth: number,
  maxWidth: number,
): number | null {
  const step = event.shiftKey ? KEYBOARD_RESIZE_LARGE_STEP_PX : KEYBOARD_RESIZE_STEP_PX;
  switch (event.key) {
    case "ArrowLeft":
      return width + step;
    case "ArrowRight":
      return width - step;
    case "Home":
      return minWidth;
    case "End":
      return maxWidth;
    default:
      return null;
  }
}
