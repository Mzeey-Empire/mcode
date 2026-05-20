import { useEffect, useLayoutEffect, useRef } from "react";
import { getTransport } from "@/transport";
import { useTerminalStore } from "@/stores/terminalStore";

/**
 * Pauses/resumes PTYs on workspace thread and terminal-tab visibility changes.
 * Resume is deferred so scroll restore can run before output bursts.
 */
export function useTerminalPtyLifecycle(
  activeThreadId: string | null,
  terminalTabVisible: boolean,
): void {
  const prevThreadIdRef = useRef(activeThreadId);

  useLayoutEffect(() => {
    const prev = prevThreadIdRef.current;
    if (prev && prev !== activeThreadId) {
      const transport = getTransport();
      const ptys = useTerminalStore.getState().terminals[prev];
      if (ptys) {
        for (const t of ptys) {
          transport.terminalPause(t.id).catch(() => {});
        }
      }
    }
    prevThreadIdRef.current = activeThreadId;
  }, [activeThreadId]);

  useEffect(() => {
    const transport = getTransport();
    let cancelled = false;
    let generation = 0;

    const setThreadPaused = (tid: string, paused: boolean) => {
      const ptys = useTerminalStore.getState().terminals[tid];
      if (!ptys) return;
      for (const t of ptys) {
        const call = paused
          ? transport.terminalPause(t.id)
          : transport.terminalResume(t.id);
        call.catch(() => {});
      }
    };

    const runDeferredResume = () => {
      generation += 1;
      const gen = generation;
      const schedule = (depth: number, fn: () => void) => {
        if (depth <= 0) {
          fn();
          return;
        }
        requestAnimationFrame(() => {
          if (cancelled || gen !== generation) return;
          schedule(depth - 1, fn);
        });
      };
      schedule(4, () => {
        if (cancelled || gen !== generation) return;
        const tid = activeThreadId;
        if (!tid) return;
        const latest = useTerminalStore.getState().terminals;
        for (const threadId of Object.keys(latest)) {
          setThreadPaused(threadId, threadId !== tid);
        }
      });
    };

    if (!terminalTabVisible || !activeThreadId) {
      for (const tid of Object.keys(useTerminalStore.getState().terminals)) {
        setThreadPaused(tid, true);
      }
      return () => {
        cancelled = true;
        generation += 1;
      };
    }

    runDeferredResume();

    return () => {
      cancelled = true;
      generation += 1;
      if (activeThreadId) {
        setThreadPaused(activeThreadId, true);
      }
    };
  }, [terminalTabVisible, activeThreadId]);
}
