import { useEffect, useMemo, useState } from "react";
import type { ThreadMovePreflight } from "@mcode/contracts/ws/methods";
import { useSidebarUiStore } from "../sidebar/sidebar-ui-store";
import { isProjectWorkspace } from "../state/project-workspaces";
import { useWorkspaceStore } from "../state/workspaceStore";
import { closeMoveThreadDialog, type MoveBlock } from "./move-thread-store";
import { fieldMessages, isSubmittable, type FieldMessages, type FieldProblem, type NewProjectValues } from "./new-project-fields";
import type { BusyThread } from "./NewProjectNotices";
import type { NewProjectRun } from "./new-project-run";
import { useMoveBlocks } from "./use-move-block";
import { preflightOf, type MovePreflightRead } from "./useMovePreflight";
import { useNewProjectRun } from "./useNewProjectRun";

/** The other threads that work in the folder, as the dialog tells the user about them. */
export interface FolderSharers {
  readonly count: number;
  readonly titles: readonly string[];
}

export interface NewProjectMove {
  readonly values: NewProjectValues;
  readonly initGit: boolean;
  readonly messages: FieldMessages;
  readonly run: NewProjectRun;
  /** The threads that move along, or null while nothing says there are any. */
  readonly sharers: FolderSharers | null;
  /** One thread in the folder that cannot move yet. The server refuses the move until it stops. */
  readonly busy: BusyThread | null;
  /**
   * Whether the request is worth sending: the folder has been checked, the look for an unfinished move has ended,
   * the form is complete, the client sees no problem, and no thread is busy. Without the check the dialog cannot say
   * which other threads move along.
   */
  readonly canCreate: boolean;
  readonly retryLookup: (() => void) | null;
  /** Threads in the folder, this one included. */
  readonly threadCount: number;
  readonly setValues: (values: NewProjectValues) => void;
  readonly setInitGit: (initGit: boolean) => void;
  readonly create: () => void;
  readonly retryGit: () => void;
  readonly reset: () => void;
}

function sameValues(left: NewProjectValues, right: NewProjectValues): boolean {
  return left.name === right.name && left.location === right.location;
}

/**
 * What the user typed over the server's suggestions. An edit wins, including an edit to nothing. Each field keeps
 * its own edit, so a Name typed before the folder check answers still leaves Location to take its suggestion.
 */
function useNewProjectValues(preflight: ThreadMovePreflight | null): { readonly values: NewProjectValues; readonly setValues: (values: NewProjectValues) => void } {
  const [edits, setEdits] = useState<Partial<NewProjectValues>>({});
  const values: NewProjectValues = {
    name: edits.name ?? preflight?.suggestedName ?? "",
    location: edits.location ?? preflight?.defaultLocation ?? "",
  };
  const setValues = (next: NewProjectValues) => {
    setEdits((previous) => ({
      ...previous,
      ...(next.name === values.name ? {} : { name: next.name }),
      ...(next.location === values.location ? {} : { location: next.location }),
    }));
  };
  return { values, setValues };
}

/** The first thread that has a reason to wait, the open thread before the others it shares the folder with. */
function firstBusy(
  ordered: readonly { readonly id: string; readonly title: string }[],
  blocks: ReadonlyMap<string, MoveBlock>,
  openThreadId: string,
): BusyThread | null {
  for (const thread of ordered) {
    const reason = blocks.get(thread.id);
    if (reason) return { title: thread.title, reason, isOpenThread: thread.id === openThreadId };
  }
  return null;
}

/**
 * The thread that holds the move back. `live` is what the stores say right now and also what disables the button;
 * `busy` adds the server's refusal, which can name a reason the stores cannot see, such as an unawaited command.
 */
function useBusyThread(threadId: string, run: NewProjectRun): { readonly live: BusyThread | null; readonly busy: BusyThread | null } {
  const threads = useWorkspaceStore((state) => state.threads);
  const inFolder = useMemo(() => {
    const open = threads.find((candidate) => candidate.id === threadId);
    if (!open) return [];
    const sharers = threads.filter((candidate) => candidate.id !== threadId && candidate.workspace_id === open.workspace_id && candidate.status !== "deleted");
    return [open, ...sharers];
  }, [threads, threadId]);
  const live = firstBusy(inFolder, useMoveBlocks(inFolder), threadId);
  const refusal = run.kind === "form" && run.refusal?.kind === "busy" ? run.refusal : null;
  const refused = refusal ? threads.find((candidate) => candidate.id === refusal.threadId) : undefined;
  const fromRefusal = refusal && refused ? { title: refused.title, reason: refusal.reason, isOpenThread: refused.id === threadId } : null;
  return { live, busy: live ?? fromRefusal };
}

/** The refusal the server gave for exactly these values, which stops applying the moment either one changes. */
function refusedProblem(run: NewProjectRun, values: NewProjectValues): FieldProblem | null {
  return run.kind === "form" && run.refusal?.kind === "field" && sameValues(run.refusal.values, values) ? run.refusal.problem : null;
}

export function useNewProjectMove(threadId: string, read: MovePreflightRead): NewProjectMove {
  const preflight = preflightOf(read);
  const { run, lookedUp, retryLookup, create, retryGit, reset } = useNewProjectRun(threadId);
  const { values, setValues } = useNewProjectValues(preflight);
  const [initGit, setInitGit] = useState(false);
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const projectNames = useMemo(() => workspaces.filter(isProjectWorkspace).map((workspace) => workspace.name), [workspaces]);
  const { live, busy } = useBusyThread(threadId, run);
  const sharers = preflight && preflight.otherThreadsInFolder.count > 0 ? preflight.otherThreadsInFolder : null;

  // A failure describes the attempt that failed, so it stops applying once the user changes what was attempted.
  const editValues = (next: NewProjectValues) => {
    if (!sameValues(next, values)) reset();
    setValues(next);
  };

  useEffect(() => {
    if (run.kind === "created" || run.kind === "git-failed") useSidebarUiStore.getState().expandProject(run.workspaceId);
    if (run.kind === "created") closeMoveThreadDialog();
  }, [run]);

  return {
    values,
    initGit,
    messages: fieldMessages(values, projectNames, refusedProblem(run, values)),
    run,
    sharers,
    busy,
    canCreate: read.status === "ready" && lookedUp && (run.kind === "form" || run.kind === "failed") && live === null && isSubmittable(values, projectNames),
    retryLookup,
    threadCount: 1 + (sharers?.count ?? 0),
    setValues: editValues,
    setInitGit,
    create: () => create(values, initGit),
    retryGit,
    reset,
  };
}
