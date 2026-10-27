import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkspaceEnvironmentActionRun } from "@mcode/contracts/models/workspace-environment";
import { useProjectActionStore } from "@/features/projects/environment/state/project-action-store";
import { applyActionRun } from "@/features/terminal";
import { useToastStore } from "@/stores/toastStore";
import { getTransport } from "@/transport";
import type { ServerTile } from "./browserNewPageModel";

const EMPTY_RUNS: Readonly<Record<string, WorkspaceEnvironmentActionRun>> = {};

/** Shows a failed toast carrying the error message. */
export function showFailure(title: string, error: unknown): void {
  useToastStore.getState().show({ kind: "failed", title, meta: error instanceof Error ? error.message : String(error) });
}

/** Reads this thread's action runs, which the `action.updated` push keeps current. */
export function useThreadActionRuns(threadId: string, enabled: boolean) {
  const runs = useProjectActionStore((state) => (enabled ? state.runsByThread[threadId] : undefined)) ?? EMPTY_RUNS;
  useEffect(() => {
    if (!enabled) return;
    const store = useProjectActionStore.getState();
    const requestEpoch = store.updateEpochByThread[threadId] ?? 0;
    const hydrationGeneration = store.beginHydration(threadId);
    let active = true;
    getTransport()
      .listWorkspaceActionRuns(threadId)
      .then((listed) => {
        if (active) useProjectActionStore.getState().hydrateRuns(threadId, listed, requestEpoch, hydrationGeneration);
      })
      .catch((error: unknown) => {
        if (active) showFailure("Couldn't load project servers", error);
      })
      .finally(() => useProjectActionStore.getState().endHydration(threadId));
    return () => {
      active = false;
    };
  }, [enabled, threadId]);
  return runs;
}

/**
 * Start reruns the action in this thread and opens its page once the new run reports a
 * reachable port. Restart reuses the terminal that is still open. Start makes a new one.
 */
export function useStartServer(tiles: readonly ServerTile[], onOpen: (url: string) => void) {
  const [starting, setStarting] = useState<ReadonlyMap<string, string>>(new Map());
  // Action id to the run that was stopped. The page opens only for a later run.
  const awaitingPage = useRef(new Map<string, string>());

  useEffect(() => {
    for (const tile of tiles) {
      const fromRunId = awaitingPage.current.get(tile.actionId);
      if (fromRunId === undefined || tile.run.runId === fromRunId) continue;
      if (tile.url !== null) {
        awaitingPage.current.delete(tile.actionId);
        onOpen(tile.url);
      } else if (tile.run.status !== "running" && tile.run.status !== "awaiting-approval") {
        awaitingPage.current.delete(tile.actionId);
      }
    }
  }, [onOpen, tiles]);

  const start = useCallback(async (tile: ServerTile) => {
    const { run } = tile;
    awaitingPage.current.set(run.actionId, run.runId);
    setStarting((current) => new Map(current).set(run.actionId, run.runId));
    try {
      const transport = getTransport();
      const next = run.terminalSessionId !== null
        ? await transport.restartWorkspaceAction(run.threadId, run.actionId)
        : await transport.startWorkspaceAction(run.threadId, run.actionId);
      if (next) applyActionRun(next, { focus: false });
    } catch (error) {
      awaitingPage.current.delete(run.actionId);
      showFailure(`Couldn't start ${run.actionName}. Try again.`, error);
    } finally {
      setStarting((current) => {
        const next = new Map(current);
        next.delete(run.actionId);
        return next;
      });
    }
  }, []);

  return { start, isRequesting: (actionId: string) => starting.has(actionId) };
}
