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

/**
 * Whether the latest live phase on this thread had delegated work but no own-turn activity.
 * Retains the result while idle on the same thread.
 */
export function useDelegatedOnlyPhase(threadId: string | null | undefined, ownLive: boolean, delegating: boolean): boolean {
  const live = ownLive || delegating;
  const delegatedOnly = delegating && !ownLive;
  const [last, setLast] = useState({ threadId, delegatedOnly });
  if (live && (last.threadId !== threadId || last.delegatedOnly !== delegatedOnly)) setLast({ threadId, delegatedOnly });
  if (live) return delegatedOnly;
  return last.threadId === threadId && last.delegatedOnly;
}
