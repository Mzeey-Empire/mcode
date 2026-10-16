import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WorkspaceEnvironmentAction, WorkspaceEnvironmentActionRun } from "@mcode/contracts";
import { getTransport } from "@/transport";
import { applyActionRun } from "@/features/terminal/state/applyActionRun";
import { useProjectActionStore } from "../environment/state/project-action-store";

const EMPTY_ACTION_RUNS: Readonly<Record<string, WorkspaceEnvironmentActionRun>> = {};

/** Loads configured Actions and reads retained runs from renderer-owned action state. */
export function useProjectActions(workspaceId: string, threadId: string): {
  readonly actions: readonly WorkspaceEnvironmentAction[];
  readonly runsByActionId: ReadonlyMap<string, WorkspaceEnvironmentActionRun>;
  readonly start: (actionId: string) => Promise<WorkspaceEnvironmentActionRun>;
  readonly loadError: string | null;
  /** False until the Actions of the current thread have been read, so callers can tell "none yet" from "none". */
  readonly loaded: boolean;
} {
  const [actions, setActions] = useState<readonly WorkspaceEnvironmentAction[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const runsByAction = useProjectActionStore((state) => state.runsByThread[threadId] ?? EMPTY_ACTION_RUNS);
  const configurationEpoch = useProjectActionStore((state) =>
    state.configurationEpochByWorkspace[workspaceId] ?? 0,
  );
  const hydrateRuns = useProjectActionStore.getState().hydrateRuns;
  const beginHydration = useProjectActionStore.getState().beginHydration;
  const endHydration = useProjectActionStore.getState().endHydration;
  const generation = useRef(0);
  const runsByActionId = useMemo(
    () => new Map(Object.entries(runsByAction)),
    [runsByAction],
  );

  useEffect(() => {
    const current = generation.current + 1;
    generation.current = current;
    const stateAtRequest = useProjectActionStore.getState();
    const requestEpoch = stateAtRequest.updateEpochByThread[threadId] ?? 0;
    const hydrationGeneration = beginHydration(threadId);
    let active = true;
    // oxlint-disable-next-line react/set-state-in-effect -- A new transport hydration must hide data from the previous Project Action context.
    setActions([]);
    setLoaded(false);
    setLoadError(null);
    void Promise.all([
      getTransport().readWorkspaceEnvironment(workspaceId, threadId),
      getTransport().listWorkspaceActionRuns(threadId),
    ]).then(
      ([environment, runs]) => {
        if (!active || generation.current !== current) return;
        setActions(environment.document.actions);
        setLoaded(true);
        hydrateRuns(threadId, runs, requestEpoch, hydrationGeneration);
      },
      () => {
        if (active && generation.current === current) setLoadError("Project Actions are unavailable.");
      },
    ).finally(() => endHydration(threadId));
    return () => {
      active = false;
    };
  }, [beginHydration, configurationEpoch, endHydration, hydrateRuns, threadId, workspaceId]);

  const start = useCallback(async (actionId: string) => {
    const run = await getTransport().startWorkspaceAction(threadId, actionId);
    applyActionRun(run, { focus: true });
    return run;
  }, [threadId]);

  return { actions, runsByActionId, start, loadError, loaded };
}
