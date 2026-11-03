/** Frame time a queue drain may use before the rest of its queue waits for the next frame. */
const FRAME_WORK_BUDGET_MS = 4;

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
 * A hidden document paints no frames, so its drain runs on a timer with no deadline: work queued
 * while the window is hidden, such as the end of a turn, must not wait for the window to return.
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

  const schedule = () => {
    if (documentIsHidden()) {
      timer ??= setTimeout(() => {
        timer = null;
        drain(Number.POSITIVE_INFINITY);
      }, 0);
      return;
    }
    frame ??= requestAnimationFrame(() => {
      frame = null;
      drain(performance.now() + FRAME_WORK_BUDGET_MS);
    });
  };

  return { schedule, cancel };
}
