/** Frame time a queue drain may use before the rest of its queue waits for the next frame. */
const FRAME_WORK_BUDGET_MS = 4;

/**
 * How long a visible document may go without a frame before its drain stops waiting for one.
 * A minimized or occluded window can report itself visible yet paint about one frame a second.
 */
const FRAME_STALL_MS = 100;

/** Schedules one queue drain at a time and cancels it when the queue drains early. */
export type FramePacer = {
  /** Requests a drain; repeated requests before it runs share one drain. */
  readonly schedule: () => void;
  /** Drops the requested drain, for callers that are about to drain directly. */
  readonly cancel: () => void;
};

function documentIsHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

/**
 * Paces a store queue to painted frames. `drain` receives a `performance.now()` deadline and must
 * stop once it passes, so a deep backlog spreads over a few frames instead of one item per frame.
 * When no frame comes, the drain runs on a timer with no deadline instead: immediately for a hidden
 * document, and after `FRAME_STALL_MS` for a visible one. Nothing paints in either case, and work
 * queued then, such as streamed text or the end of a turn, must not wait for the window to return.
 */
export function createFramePacer(drain: (deadline: number) => void): FramePacer {
  let frame: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const cancel = () => {
    if (frame !== null) cancelAnimationFrame(frame);
    if (timer !== null) clearTimeout(timer);
    frame = null;
    timer = null;
  };

  const run = (deadline: number) => {
    cancel();
    drain(deadline);
  };

  const schedule = () => {
    const hidden = documentIsHidden();
    timer ??= setTimeout(() => run(Number.POSITIVE_INFINITY), hidden ? 0 : FRAME_STALL_MS);
    if (hidden) return;
    frame ??= requestAnimationFrame(() => run(performance.now() + FRAME_WORK_BUDGET_MS));
  };

  return { schedule, cancel };
}
