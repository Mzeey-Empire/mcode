import { useEffect, useState } from "react";

/**
 * How long the status line's exit animation plays before it stops rendering.
 * Matches the `narrative-indicator-out` keyframes duration in index.css.
 */
export const STATUS_LINE_EXIT_MS = 240;

/**
 * True for {@link STATUS_LINE_EXIT_MS} after the status line stops being live, so its
 * row stays in the list long enough to fade instead of vanishing in one frame.
 * Switching threads never starts an exit: the line belonged to the other thread.
 */
export function useStatusLineExit(threadId: string | null | undefined, live: boolean): boolean {
  const [previous, setPrevious] = useState({ threadId, live });
  const [exiting, setExiting] = useState(false);
  if (previous.threadId !== threadId || previous.live !== live) {
    setPrevious({ threadId, live });
    setExiting(previous.threadId === threadId && previous.live && !live);
  }

  useEffect(() => {
    if (!exiting) return;
    const timer = setTimeout(() => setExiting(false), STATUS_LINE_EXIT_MS);
    return () => clearTimeout(timer);
  }, [exiting]);

  return exiting;
}
