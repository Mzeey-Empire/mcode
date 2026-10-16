import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { CircleCheck, CircleSlash, CircleStop, CircleX, Pencil, Play } from "lucide-react";
import { MoreIcon } from "@/components/ui/icon-map";
import type { WorkspaceEnvironmentAction, WorkspaceEnvironmentActionRun } from "@mcode/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { getTransport } from "@/transport";
import { applyActionRun } from "@/features/terminal/state/applyActionRun";
import { useProjectActionStore } from "./state/project-action-store";

const ACTION_RESULT_DISPLAY_MS = 2_000;

interface ProjectActionMenuProps {
  readonly actions: readonly WorkspaceEnvironmentAction[];
  readonly runsByActionId: ReadonlyMap<string, WorkspaceEnvironmentActionRun>;
  readonly onStart: (actionId: string) => Promise<void | WorkspaceEnvironmentActionRun>;
  readonly onFocus: (actionId: string) => void;
  readonly onEdit: () => void;
  readonly loadError?: string | null;
}

interface ProjectActionActivation {
  readonly actionId: string;
  readonly focus: boolean;
  handled: boolean;
}

interface ProjectActionPointerActivation extends ProjectActionActivation {
  readonly pointerId: number;
  released: boolean;
}

interface ProjectActionMenuRow {
  readonly actionId: string;
  readonly actionName: string;
  readonly configured: boolean;
}

const EMPTY_ACTION_RUNS: Readonly<Record<string, WorkspaceEnvironmentActionRun>> = {};

/** Renders Project Actions beside Project settings. */
export function ProjectActionMenu({ actions, runsByActionId, onStart, onFocus, onEdit, loadError = null }: ProjectActionMenuProps) {
  const [open, setOpen] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const pointerActivation = useRef<ProjectActionPointerActivation | null>(null);
  const keyboardActivation = useRef<ProjectActionActivation | null>(null);
  const configuredActionIds = useMemo(() => new Set(actions.map((action) => action.id)), [actions]);
  const rows = useMemo<readonly ProjectActionMenuRow[]>(() => [
    ...actions.map((action) => ({ actionId: action.id, actionName: action.name, configured: true })),
    ...[...runsByActionId.values()]
      .filter((run) => !configuredActionIds.has(run.actionId) && run.status !== "awaiting-approval")
      .map((run) => ({ actionId: run.actionId, actionName: run.actionName, configured: false })),
  ], [actions, configuredActionIds, runsByActionId]);
  const startAction = useCallback((actionId: string) => {
    setStartError(null);
    void onStart(actionId).catch(() => setStartError("Project Action could not start."));
  }, [onStart]);
  const hasActionGroup = rows.length > 0 || Boolean(loadError) || Boolean(startError);
  return (
    <>
      <ProjectActionMenuDropdown
        open={open}
        onOpenChange={setOpen}
        onEdit={onEdit}
        rows={rows}
        runsByActionId={runsByActionId}
        onStart={startAction}
        onFocus={onFocus}
        pointerActivation={pointerActivation}
        keyboardActivation={keyboardActivation}
        hasActionGroup={hasActionGroup}
        loadError={loadError}
        startError={startError}
      />
    </>
  );
}

function ProjectActionMenuDropdown({
  open,
  onOpenChange,
  onEdit,
  rows,
  runsByActionId,
  onStart,
  onFocus,
  pointerActivation,
  keyboardActivation,
  hasActionGroup,
  loadError,
  startError,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onEdit: () => void;
  readonly rows: readonly ProjectActionMenuRow[];
  readonly runsByActionId: ReadonlyMap<string, WorkspaceEnvironmentActionRun>;
  readonly onStart: (actionId: string) => void;
  readonly onFocus: (actionId: string) => void;
  readonly pointerActivation: MutableRefObject<ProjectActionPointerActivation | null>;
  readonly keyboardActivation: MutableRefObject<ProjectActionActivation | null>;
  readonly hasActionGroup: boolean;
  readonly loadError: string | null;
  readonly startError: string | null;
}) {
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-compact"
            aria-label="Project Actions"
            className="text-muted hover:bg-hover/40 hover:text-ink"
          >
            <MoreIcon size={14} aria-hidden />
          </Button>
        }
      />
      <DropdownMenuContent align="end" sideOffset={4} className="min-w-52">
        <DropdownMenuItem label="Edit project actions" icon={<Pencil />} onClick={onEdit} />
        {hasActionGroup ? <DropdownMenuSeparator /> : null}
        {loadError ? <p role="status" className="px-3 py-2 text-caption text-error">{loadError}</p> : null}
        {startError ? <p role="status" className="px-3 py-2 text-caption text-error">{startError}</p> : null}
        {rows.map((row) => (
          <ProjectActionMenuItem
            key={row.actionId}
            row={row}
            run={runsByActionId.get(row.actionId) ?? null}
            onStart={onStart}
            onFocus={onFocus}
            pointerActivation={pointerActivation}
            keyboardActivation={keyboardActivation}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ProjectActionMenuItem({
  row,
  run,
  onStart,
  onFocus,
  pointerActivation,
  keyboardActivation,
}: {
  readonly row: ProjectActionMenuRow;
  readonly run: WorkspaceEnvironmentActionRun | null;
  readonly onStart: (actionId: string) => void;
  readonly onFocus: (actionId: string) => void;
  readonly pointerActivation: MutableRefObject<ProjectActionPointerActivation | null>;
  readonly keyboardActivation: MutableRefObject<ProjectActionActivation | null>;
}) {
  const focusAction = run?.status === "running" || run?.status === "awaiting-approval" || !row.configured;
  return (
    <DropdownMenuItem
      data-testid={`project-action-${row.actionId}`}
      label={row.actionName}
      trailing={<ActionStatus status={run?.status ?? null} finishedAt={run?.finishedAt ?? null} />}
      closeOnClick={false}
      onPointerDown={(event) => recordProjectActionPointerDown(event, row, focusAction, pointerActivation, keyboardActivation)}
      onPointerUp={(event) => recordProjectActionPointerUp(event, row, focusAction, pointerActivation, keyboardActivation)}
      onPointerCancel={(event) => cancelProjectActionPointer(event, pointerActivation)}
      onKeyDown={(event) => recordProjectActionKeyboard(event, row, focusAction, pointerActivation, keyboardActivation)}
      onClick={() => activateProjectAction(row, focusAction, onStart, onFocus, pointerActivation, keyboardActivation)}
    />
  );
}

function recordProjectActionPointerDown(
  event: ReactPointerEvent,
  row: ProjectActionMenuRow,
  focus: boolean,
  pointerActivation: MutableRefObject<ProjectActionPointerActivation | null>,
  keyboardActivation: MutableRefObject<ProjectActionActivation | null>,
): void {
  if (event.button !== 0) return;
  keyboardActivation.current = null;
  pointerActivation.current = { actionId: row.actionId, focus, handled: false, pointerId: event.pointerId, released: false };
}

function recordProjectActionPointerUp(
  event: ReactPointerEvent,
  row: ProjectActionMenuRow,
  focus: boolean,
  pointerActivation: MutableRefObject<ProjectActionPointerActivation | null>,
  keyboardActivation: MutableRefObject<ProjectActionActivation | null>,
): void {
  if (event.button !== 0) return;
  keyboardActivation.current = null;
  const activation = pointerActivation.current;
  if (isCurrentProjectActionPointer(activation, row.actionId, event.pointerId)) {
    activation.released = true;
    return;
  }
  pointerActivation.current = { actionId: row.actionId, focus, handled: false, pointerId: event.pointerId, released: true };
}

function cancelProjectActionPointer(
  event: ReactPointerEvent,
  pointerActivation: MutableRefObject<ProjectActionPointerActivation | null>,
): void {
  if (pointerActivation.current?.pointerId === event.pointerId) pointerActivation.current = null;
}

function recordProjectActionKeyboard(
  event: ReactKeyboardEvent,
  row: ProjectActionMenuRow,
  focus: boolean,
  pointerActivation: MutableRefObject<ProjectActionPointerActivation | null>,
  keyboardActivation: MutableRefObject<ProjectActionActivation | null>,
): void {
  if (event.key !== "Enter" && event.key !== " ") return;
  pointerActivation.current = null;
  keyboardActivation.current = { actionId: row.actionId, focus, handled: false };
}

function activateProjectAction(
  row: ProjectActionMenuRow,
  focusAction: boolean,
  onStart: (actionId: string) => void,
  onFocus: (actionId: string) => void,
  pointerActivation: MutableRefObject<ProjectActionPointerActivation | null>,
  keyboardActivation: MutableRefObject<ProjectActionActivation | null>,
): void {
  if (consumeProjectActionActivation(keyboardActivation.current, row.actionId, onStart, onFocus)) return;
  const pointer = pointerActivation.current;
  if (pointer?.released && consumeProjectActionActivation(pointer, row.actionId, onStart, onFocus)) return;
  if (focusAction) onFocus(row.actionId);
  else onStart(row.actionId);
}

function consumeProjectActionActivation(
  activation: ProjectActionActivation | null,
  actionId: string,
  onStart: (actionId: string) => void,
  onFocus: (actionId: string) => void,
): boolean {
  if (!activation || activation.actionId !== actionId || activation.handled) return false;
  activation.handled = true;
  if (activation.focus) onFocus(actionId);
  else onStart(actionId);
  return true;
}

function isCurrentProjectActionPointer(
  activation: ProjectActionPointerActivation | null,
  actionId: string,
  pointerId: number,
): activation is ProjectActionPointerActivation {
  return activation?.actionId === actionId && activation.pointerId === pointerId;
}

/** Loads configured Actions and reads retained runs from renderer-owned action state. */
export function useProjectActions(workspaceId: string, threadId: string): {
  readonly actions: readonly WorkspaceEnvironmentAction[];
  readonly runsByActionId: ReadonlyMap<string, WorkspaceEnvironmentActionRun>;
  readonly start: (actionId: string) => Promise<WorkspaceEnvironmentActionRun>;
  readonly loadError: string | null;
} {
  const [actions, setActions] = useState<readonly WorkspaceEnvironmentAction[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
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
    setLoadError(null);
    void Promise.all([
      getTransport().readWorkspaceEnvironment(workspaceId, threadId),
      getTransport().listWorkspaceActionRuns(threadId),
    ]).then(
      ([environment, runs]) => {
        if (!active || generation.current !== current) return;
        setActions(environment.document.actions);
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

  return { actions, runsByActionId, start, loadError };
}

function ActionStatus({
  status,
  finishedAt,
  showIdlePlay = true,
}: {
  readonly status: WorkspaceEnvironmentActionRun["status"] | null;
  readonly finishedAt: string | null;
  readonly showIdlePlay?: boolean;
}) {
  const [showRecentResult, setShowRecentResult] = useState(() => isRecentResult(status, finishedAt));
  useEffect(() => {
    const remaining = resultDisplayRemaining(status, finishedAt);
    // oxlint-disable-next-line react/set-state-in-effect -- This timer synchronizes the transient result indicator with wall-clock time.
    setShowRecentResult(remaining > 0);
    if (remaining === 0) return;
    const timer = window.setTimeout(() => setShowRecentResult(false), remaining);
    return () => window.clearTimeout(timer);
  }, [finishedAt, status]);
  return <ActionStatusIcon status={status} showRecentResult={showRecentResult} showIdlePlay={showIdlePlay} />;
}

function ActionStatusIcon({
  status,
  showRecentResult,
  showIdlePlay,
}: {
  readonly status: WorkspaceEnvironmentActionRun["status"] | null;
  readonly showRecentResult: boolean;
  readonly showIdlePlay: boolean;
}) {
  const statusNode = actionStatusNode(status, showRecentResult);
  return statusNode ?? (showIdlePlay ? <Play className="ml-2 size-3.5 shrink-0 text-muted" aria-label="Play" /> : null);
}

const ACTION_STATUS_NODES: Readonly<Partial<Record<NonNullable<WorkspaceEnvironmentActionRun["status"]>, ReactNode>>> = {
  running: <span role="status" aria-label="Running" className="ml-2 flex shrink-0 text-muted"><Spinner size={12} aria-hidden className="motion-reduce:animate-none" /></span>,
  "awaiting-approval": <Badge role="status" aria-label="Approval required" variant="secondary" size="compact" className="ml-2 shrink-0">Approval</Badge>,
  completed: <span role="status" aria-label="Completed" className="ml-2 flex shrink-0"><CircleCheck className="size-3.5 text-[var(--diff-add-strong)]" aria-hidden /></span>,
  failed: <span role="status" aria-label="Failed" className="ml-2 flex shrink-0"><CircleX className="size-3.5 text-[var(--diff-remove)]" aria-hidden /></span>,
  interrupted: <span role="status" aria-label="Interrupted" className="ml-2 flex shrink-0 text-muted"><CircleStop className="size-3.5" aria-hidden /></span>,
  unavailable: <span role="status" aria-label="Unavailable" className="ml-2 flex shrink-0 text-muted"><CircleSlash className="size-3.5" aria-hidden /></span>,
};

function actionStatusNode(
  status: WorkspaceEnvironmentActionRun["status"] | null,
  showRecentResult: boolean,
): ReactNode | null {
  if (isExpiredActionResult(status, showRecentResult)) return null;
  return status ? ACTION_STATUS_NODES[status] ?? null : null;
}

function isExpiredActionResult(
  status: WorkspaceEnvironmentActionRun["status"] | null,
  showRecentResult: boolean,
): boolean {
  return (status === "completed" || status === "failed") && !showRecentResult;
}

function isRecentResult(status: WorkspaceEnvironmentActionRun["status"] | null, finishedAt: string | null): boolean {
  return resultDisplayRemaining(status, finishedAt) > 0;
}

function resultDisplayRemaining(status: WorkspaceEnvironmentActionRun["status"] | null, finishedAt: string | null): number {
  if ((status !== "completed" && status !== "failed") || finishedAt === null) return 0;
  return Math.max(0, new Date(finishedAt).getTime() + ACTION_RESULT_DISPLAY_MS - Date.now());
}
