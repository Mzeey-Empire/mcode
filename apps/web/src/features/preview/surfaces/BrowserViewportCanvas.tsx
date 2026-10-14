import { useEffect, useRef, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { BROWSER_AUTOMATION_VIEWPORT_CANVAS_PADDING_PX } from "@mcode/contracts";
import { cn } from "@/lib/utils";
import { useViewportDragStore, type ViewportDragEdge } from "../state/viewportDragStore";
import {
  clampViewportSize,
  DEFAULT_VIEWPORT_SIZE,
  MAX_VIEWPORT_CSS_PX,
  MIN_VIEWPORT_CSS_PX,
  ViewportCoordinator,
  type ViewportCoordinatorState,
  type ViewportCanvasBounds,
  type ViewportSize,
} from "../automation/services/viewportCoordinator";
import { useViewportCoordinatorState } from "./useViewportCoordinatorState";

type DragAxis = "width" | "height";
type DragHandlePosition = ViewportDragEdge;

interface DragHandleDetails {
  readonly axis: DragAxis;
  readonly direction: { readonly x: 0 | 1; readonly y: 0 | 1 };
  readonly className: string;
  readonly pillClassName: string;
}

const DRAG_HANDLE_POSITIONS: readonly DragHandlePosition[] = ["right", "bottom"];

const DRAG_HANDLE_DETAILS: Record<DragHandlePosition, DragHandleDetails> = {
  right: {
    axis: "width",
    direction: { x: 1, y: 0 },
    className: "inset-y-8 -right-4 w-4 cursor-ew-resize",
    pillClassName: "h-8 w-1",
  },
  bottom: {
    axis: "height",
    direction: { x: 0, y: 1 },
    className: "inset-x-8 -bottom-4 h-4 cursor-ns-resize",
    pillClassName: "h-1 w-8",
  },
};

/** Props for the responsive Browser viewport canvas and its resize affordances. */
export interface BrowserViewportCanvasProps {
  readonly coordinator?: ViewportCoordinator;
  readonly state?: ViewportCoordinatorState;
  readonly bounds: ViewportCanvasBounds;
  readonly scale: number;
  readonly children: ReactNode;
  readonly className?: string;
  readonly onUserViewportChange?: () => void;
}

const INACTIVE_VIEWPORT_STATE: ViewportCoordinatorState = {
  mode: "regular",
  presentation: "fit",
  confirmed: DEFAULT_VIEWPORT_SIZE,
  userConfirmed: DEFAULT_VIEWPORT_SIZE,
  targetGeneration: 0,
  pending: null,
  pendingReset: null,
  pendingPresentation: null,
  presentationError: null,
  agentActive: false,
};

const PAGE_FRAME_CLASS = "overflow-visible rounded-[0.6rem] bg-background";

interface DragStart {
  readonly x: number;
  readonly y: number;
  readonly size: ViewportSize;
}

interface ViewportResizeHandlers {
  readonly onPointerDown: (event: PointerEvent<HTMLDivElement>) => void;
  readonly onPointerMove: (event: PointerEvent<HTMLDivElement>) => void;
  readonly onPointerUp: (event: PointerEvent<HTMLDivElement>) => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
}

function resizeFromPointer(
  details: DragHandleDetails,
  start: DragStart,
  event: PointerEvent<HTMLDivElement>,
  scale: number,
): ViewportSize {
  const divisor = scale > 0 ? scale : 1;
  const deltaX = ((event.clientX - start.x) / divisor) * details.direction.x;
  const deltaY = ((event.clientY - start.y) / divisor) * details.direction.y;
  return clampViewportSize({
    width: details.direction.x === 0 ? start.size.width : start.size.width + deltaX,
    height: details.direction.y === 0 ? start.size.height : start.size.height + deltaY,
  });
}

function resizeFromKeyboard(
  details: DragHandleDetails,
  size: ViewportSize,
  event: KeyboardEvent<HTMLDivElement>,
): ViewportSize | null {
  const step = event.shiftKey ? 48 : 16;
  const keyDelta = keyboardDelta(event.key, details.direction, step);
  if (!keyDelta) return null;
  return clampViewportSize({ width: size.width + keyDelta.x, height: size.height + keyDelta.y });
}

function keyboardDelta(
  key: string,
  direction: DragHandleDetails["direction"],
  step: number,
): { readonly x: number; readonly y: number } | null {
  const horizontal = key === "ArrowRight" ? direction.x : key === "ArrowLeft" ? -direction.x : 0;
  const vertical = key === "ArrowDown" ? direction.y : key === "ArrowUp" ? -direction.y : 0;
  if (horizontal === 0 && vertical === 0) return null;
  return { x: horizontal * step, y: vertical * step };
}

function useViewportResizeHandlers(
  details: DragHandleDetails,
  position: DragHandlePosition,
  coordinator: ViewportCoordinator,
  state: ViewportCoordinatorState,
  scale: number,
  onUserViewportChange: (() => void) | undefined,
): ViewportResizeHandlers {
  const startRef = useRef<DragStart | null>(null);
  const frameRef = useRef<number | null>(null);
  const pendingSizeRef = useRef<ViewportSize | null>(null);
  const setDragEdge = useViewportDragStore((store) => store.setEdge);

  const requestResize = (size: ViewportSize): void => {
    onUserViewportChange?.();
    coordinator.setMode("responsive");
    void coordinator.requestUserResize(size);
  };

  const flushResize = (): void => {
    const pending = pendingSizeRef.current;
    pendingSizeRef.current = null;
    if (pending) requestResize(pending);
  };

  const cancelScheduledResize = (): void => {
    if (frameRef.current === null) return;
    if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
  };

  useEffect(() => () => {
    cancelScheduledResize();
    if (startRef.current) useViewportDragStore.getState().setEdge(null);
  }, []);

  const scheduleResize = (size: ViewportSize): void => {
    if (typeof requestAnimationFrame !== "function") {
      requestResize(size);
      return;
    }
    pendingSizeRef.current = size;
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      flushResize();
    });
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    event.currentTarget.setPointerCapture?.(event.pointerId);
    startRef.current = { x: event.clientX, y: event.clientY, size: state.confirmed };
    setDragEdge(position);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const start = startRef.current;
    if (!start || !holdsPointerCapture(event)) return;
    scheduleResize(resizeFromPointer(details, start, event, scale));
  };

  const onPointerUp = (event: PointerEvent<HTMLDivElement>): void => {
    startRef.current = null;
    setDragEdge(null);
    cancelScheduledResize();
    flushResize();
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const next = resizeFromKeyboard(details, state.confirmed, event);
    if (!next) return;
    event.preventDefault();
    requestResize(next);
  };

  return { onPointerDown, onPointerMove, onPointerUp, onKeyDown };
}

function holdsPointerCapture(event: PointerEvent<HTMLDivElement>): boolean {
  return !event.currentTarget.hasPointerCapture || event.currentTarget.hasPointerCapture(event.pointerId);
}

function BrowserViewportDragHandle({
  position,
  coordinator,
  state,
  scale,
  onUserViewportChange,
}: {
  readonly position: DragHandlePosition;
  readonly coordinator: ViewportCoordinator;
  readonly state: ViewportCoordinatorState;
  readonly scale: number;
  readonly onUserViewportChange?: () => void;
}) {
  const details = DRAG_HANDLE_DETAILS[position];
  const handlers = useViewportResizeHandlers(details, position, coordinator, state, scale, onUserViewportChange);
  const dragging = useViewportDragStore((store) => store.edge === position);

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-label={`Resize viewport from ${position}`}
      aria-orientation={details.axis === "height" ? "horizontal" : "vertical"}
      aria-valuemin={MIN_VIEWPORT_CSS_PX}
      aria-valuemax={MAX_VIEWPORT_CSS_PX}
      aria-valuenow={state.confirmed[details.axis]}
      data-position={position}
      data-dragging={dragging ? "" : undefined}
      className={cn(
        "group/handle pointer-events-auto absolute z-(--layer-floating-panel) flex touch-none select-none items-center justify-center outline-none focus-visible:ring-2 focus-visible:ring-focus",
        details.className,
      )}
      {...handlers}
      onPointerCancel={handlers.onPointerUp}
    >
      <span
        aria-hidden
        className={cn(
          "rounded-full bg-control-border transition-colors group-hover/handle:bg-muted group-focus-visible/handle:bg-muted",
          dragging && "bg-primary group-hover/handle:bg-primary",
          details.pillClassName,
        )}
      />
    </div>
  );
}

function canvasClassName(
  responsive: boolean,
  presentation: ViewportCoordinatorState["presentation"],
  className: string | undefined,
): string {
  const overflow = presentation === "actual" ? "overflow-auto" : "overflow-hidden";
  return cn("pointer-events-none relative h-full min-h-0", responsive && overflow, className);
}

function stageSize(
  state: ViewportCoordinatorState,
  bounds: ViewportCanvasBounds,
  scale: number,
): { readonly width: number; readonly height: number; readonly stageWidth: number; readonly stageHeight: number } {
  const width = Math.round(state.confirmed.width * scale);
  const height = Math.round(state.confirmed.height * scale);
  return {
    width,
    height,
    stageWidth: Math.max(width + BROWSER_AUTOMATION_VIEWPORT_CANVAS_PADDING_PX, Number.isFinite(bounds.width) ? bounds.width : 0),
    stageHeight: Math.max(height + BROWSER_AUTOMATION_VIEWPORT_CANVAS_PADDING_PX, Number.isFinite(bounds.height) ? bounds.height : 0),
  };
}

function stageStyle(
  responsive: boolean,
  size: ReturnType<typeof stageSize>,
): { readonly width: number | string; readonly height: number | string; readonly padding: number } {
  return {
    width: responsive ? size.stageWidth : "100%",
    height: responsive ? size.stageHeight : "100%",
    padding: responsive ? BROWSER_AUTOMATION_VIEWPORT_CANVAS_PADDING_PX / 2 : 0,
  };
}

function viewportCanvasStyle(
  responsive: boolean,
  size: ReturnType<typeof stageSize>,
): { readonly width: number | string; readonly height: number | string } {
  return { width: responsive ? size.width : "100%", height: responsive ? size.height : "100%" };
}

function viewportContentStyle(
  responsive: boolean,
  state: ViewportCoordinatorState,
  scale: number,
): { readonly width: number | string; readonly height: number | string; readonly transform?: string; readonly transformOrigin: "top left" } {
  return {
    width: responsive ? state.confirmed.width : "100%",
    height: responsive ? state.confirmed.height : "100%",
    transform: responsive ? `scale(${scale})` : undefined,
    transformOrigin: "top left",
  };
}

function BrowserViewportResizeHandles({
  responsive,
  coordinator,
  state,
  scale,
  onUserViewportChange,
}: {
  readonly responsive: boolean;
  readonly coordinator: ViewportCoordinator | undefined;
  readonly state: ViewportCoordinatorState;
  readonly scale: number;
  readonly onUserViewportChange: (() => void) | undefined;
}) {
  if (!responsive || !coordinator) return null;
  return DRAG_HANDLE_POSITIONS.map((position) => (
    <BrowserViewportDragHandle
      key={position}
      position={position}
      coordinator={coordinator}
      state={state}
      scale={scale}
      onUserViewportChange={onUserViewportChange}
    />
  ));
}

function BrowserViewportStage({
  coordinator,
  state,
  bounds,
  scale,
  children,
  className,
  onUserViewportChange,
}: Required<Pick<BrowserViewportCanvasProps, "bounds" | "scale" | "children">> & Omit<BrowserViewportCanvasProps, "bounds" | "scale" | "children" | "state"> & { readonly state: ViewportCoordinatorState }) {
  const responsive = state.mode === "responsive";
  const size = stageSize(state, bounds, scale);
  const dragging = useViewportDragStore((store) => store.edge !== null);

  return (
    <div data-testid="browser-viewport-stage" className={canvasClassName(responsive, state.presentation, className)}>
      <div className="flex min-h-full min-w-full items-center justify-center" style={stageStyle(responsive, size)}>
        <div
          data-testid="responsive-viewport-canvas"
          className={cn(
            "relative flex-none",
            responsive && PAGE_FRAME_CLASS,
            responsive && "ring-1",
            responsive && (dragging ? "ring-primary" : "ring-border"),
          )}
          style={viewportCanvasStyle(responsive, size)}
        >
          <div
            className={cn("absolute left-0 top-0 overflow-hidden", responsive && "rounded-[0.6rem]")}
            style={viewportContentStyle(responsive, state, scale)}
          >
            {children}
          </div>
          <BrowserViewportResizeHandles
            responsive={responsive}
            coordinator={coordinator}
            state={state}
            scale={scale}
            onUserViewportChange={onUserViewportChange}
          />
        </div>
      </div>
    </div>
  );
}

/** Render a centered responsive viewport with keyboard and pointer resize handles. */
export function BrowserViewportCanvas({
  coordinator,
  state,
  bounds,
  scale,
  children,
  className,
  onUserViewportChange,
}: BrowserViewportCanvasProps) {
  const resolvedState = state ?? INACTIVE_VIEWPORT_STATE;
  const currentState = useViewportCoordinatorState(coordinator, resolvedState);
  const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1;

  return (
    <BrowserViewportStage
      coordinator={coordinator}
      state={currentState}
      bounds={bounds}
      scale={safeScale}
      className={className}
      onUserViewportChange={onUserViewportChange}
    >
      {children}
    </BrowserViewportStage>
  );
}
