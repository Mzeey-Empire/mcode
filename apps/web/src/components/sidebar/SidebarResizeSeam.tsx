import { useRef, type KeyboardEvent, type PointerEvent } from "react";
import {
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_RESIZE_STEP,
  useSidebarWidthStore,
} from "./sidebarWidthStore";

const KEY_DELTAS: Partial<Record<string, number>> = {
  ArrowLeft: -SIDEBAR_RESIZE_STEP,
  ArrowRight: SIDEBAR_RESIZE_STEP,
};

/**
 * The docked sidebar's right edge: drag or arrow keys resize it, a double-click
 * returns it to the default width. Sits inside the sidebar's positioned frame.
 */
export function SidebarResizeSeam() {
  const width = useSidebarWidthStore((s) => s.width);
  const setWidth = useSidebarWidthStore((s) => s.setWidth);
  const resetWidth = useSidebarWidthStore((s) => s.resetWidth);
  const dragOriginRef = useRef<{ pointerX: number; width: number } | null>(null);

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragOriginRef.current = { pointerX: event.clientX, width };
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const origin = dragOriginRef.current;
    if (!origin) return;
    setWidth(origin.width + event.clientX - origin.pointerX);
  };

  const endDrag = () => {
    dragOriginRef.current = null;
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const delta = KEY_DELTAS[event.key];
    if (delta === undefined) return;
    event.preventDefault();
    setWidth(width + delta);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuemin={SIDEBAR_MIN_WIDTH}
      aria-valuemax={SIDEBAR_MAX_WIDTH}
      aria-valuenow={width}
      tabIndex={0}
      data-testid="sidebar-resize-seam"
      className="group absolute inset-y-0 right-0 z-(--layer-sticky) flex w-2 cursor-col-resize touch-none justify-end focus:outline-none"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={resetWidth}
      onKeyDown={handleKeyDown}
    >
      <span
        aria-hidden
        className="pointer-events-none w-px bg-border/45 transition-colors group-hover:w-0.5 group-hover:bg-focus group-focus-visible:w-0.5 group-focus-visible:bg-focus"
      />
    </div>
  );
}
