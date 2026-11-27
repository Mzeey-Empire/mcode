import { useEffect, useId, useRef, useState, type ReactNode, type Ref } from "react";
import { FolderInput, FolderPlus, GitBranch, InboxIcon, RotateCcw, Trash2 } from "lucide-react";
import type { ThreadMovePreflight, ThreadMoveResult } from "@mcode/contracts/ws/methods";
import type { Workspace } from "@mcode/contracts/models/workspace";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Notice } from "@/components/ui/notice";
import { ProjectSlotHeading } from "@/features/conversation/messages/chat-view/ProjectSlotHeading";
import { TargetTriggers } from "@/features/conversation/composer/execution/ComposerTargetSelection";
import { WorkspaceTargetMenu } from "@/features/conversation/composer/execution/WorkspaceTargetMenu";
import { newThreadTargetLabel, targetLabelText } from "@/features/conversation/composer/execution/new-thread-target-copy";
import { useDefaultBranchTarget } from "@/features/conversation/composer/execution/targets/useBranchTargets";
import { basename } from "@/lib/path";
import { getTransport } from "@/transport";
import { rpcFailureMessage } from "@/transport/rpc-failure-message";
import { useSidebarUiStore } from "../sidebar/sidebar-ui-store";
import { isNoProjectWorkspace, isProjectWorkspace } from "../state/project-workspaces";
import { useWorkspaceStore } from "../state/workspaceStore";
import { GitFailedDialog } from "./GitFailedDialog";
import { MoveThreadCommand } from "./MoveThreadCommand";
import { CopyProgressBar } from "./CopyProgressBar";
import { NewProjectForm } from "./NewProjectForm";
import { BusyNotice, MoveFailureNotice, ResultUnknownNotice, SharersNotice } from "./NewProjectNotices";
import { closeMoveThreadDialog, useMoveThreadStore } from "./move-thread-store";
import { destinationPath } from "./new-project-fields";
import { endsAtClose, failureIsAboutLocation, followsMove, isPastForm, type NewProjectRun } from "./new-project-run";
import { PreflightFailedNotice } from "./PreflightFailedNotice";
import { useMoveTarget, type MoveTargetState } from "./useMoveTarget";
import { preflightOf, useMovePreflight, type MovePreflightState } from "./useMovePreflight";
import { useNewProjectMove, type NewProjectMove } from "./useNewProjectMove";

/**
 * The global move dialog. It mounts once and opens for the thread {@link openMoveThreadDialog} names. It also
 * mounts the palette entry, so the entry lives and dies with the dialog it opens.
 */
export function MoveThreadDialogHost() {
  const threadId = useMoveThreadStore((state) => state.threadId);
  const projectId = useMoveThreadStore((state) => state.projectId);
  return (
    <>
      <MoveThreadCommand />
      {threadId === null ? null : <MoveThreadDialog key={threadId} threadId={threadId} initialProjectId={projectId} />}
    </>
  );
}

interface MoveFailure {
  readonly detail: string;
  readonly raw: string | null;
  readonly unconfirmed?: true;
  /** Whether trying the same project again can work. A project that is gone must be chosen anew. */
  readonly retryable: boolean;
}

const NOTHING_CHANGED = "Nothing changed: the thread is still in No project.";

function describeRefusal(result: Exclude<ThreadMoveResult, { status: "moved" }>): MoveFailure {
  switch (result.status) {
    case "busy":
      switch (result.reason) {
        case "running":
          return { detail: `This thread is running. ${NOTHING_CHANGED} You can move it once it stops.`, raw: null, retryable: true };
        case "needs-approval":
          return { detail: `This thread needs approval. ${NOTHING_CHANGED} You can move it once you answer it.`, raw: null, retryable: true };
        case "background":
          return { detail: `This thread has work running in the background. ${NOTHING_CHANGED} You can move it once that work stops.`, raw: null, retryable: true };
        default:
          throw new Error(`Unhandled move block reason: ${result.reason satisfies never}`);
      }
    case "destination-missing":
      return { detail: `That project is no longer in Mcode. ${NOTHING_CHANGED} Choose another project.`, raw: null, retryable: false };
    case "not-no-project":
      return { detail: "This thread is no longer in No project, so there is nothing to move.", raw: null, retryable: false };
    case "unconfirmed":
      return { detail: "Check the sidebar to see where the thread is.", raw: result.error, retryable: false, unconfirmed: true };
    case "failed": {
      const why = result.cause === "database-busy" ? "Mcode's database was busy, so nothing changed" : "Nothing changed";
      return {
        detail: `${why}: the thread is still in No project and its files are untouched. Try again in a moment.`,
        raw: result.error,
        retryable: true,
      };
    }
  }
}

// A request that never answered may still have committed, so this cannot promise that nothing changed.
function describeException(error: unknown): MoveFailure {
  return {
    detail: "Mcode could not confirm the move. The thread stays in No project here until Mcode hears that it moved.",
    raw: rpcFailureMessage(error),
    retryable: true,
  };
}

function formatRemovalDate(deadline: string): string {
  return new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" }).format(new Date(deadline));
}

type Destination = "existing" | "new-project";

interface MoveFlow {
  readonly destination: Destination;
  readonly picked: Workspace | undefined;
  readonly target: MoveTargetState;
  readonly moving: boolean;
  readonly failure: MoveFailure | null;
  readonly pick: (workspace: Workspace) => void;
  readonly chooseNewProject: () => void;
  readonly move: () => void;
}

function useMoveFlow(threadId: string, initialProjectId: string | null, newProject: NewProjectMove): MoveFlow {
  const applyMoved = useWorkspaceStore((state) => state.applyThreadMovedToProject);
  const projectCount = useWorkspaceStore((state) => state.workspaces.filter(isProjectWorkspace).length);
  const [pickedId, setPickedId] = useState<string | null>(initialProjectId);
  const [chosen, setChosen] = useState<Destination | null>(null);
  // With no project to choose, the folder becoming one is the only move there is. A move that has begun is that one too.
  const destination: Destination = isPastForm(newProject.run) ? "new-project" : chosen ?? (projectCount === 0 && initialProjectId === null ? "new-project" : "existing");
  const picked = useWorkspaceStore((state) => state.workspaces.find((candidate) => candidate.id === pickedId && candidate.kind === "project"));
  const target = useMoveTarget(picked);
  const [moving, setMoving] = useState(false);
  const [failure, setFailure] = useState<MoveFailure | null>(null);

  const pick = (workspace: Workspace) => {
    setPickedId(workspace.id);
    setChosen("existing");
    setFailure(null);
    newProject.reset();
  };

  const chooseNewProject = () => {
    setChosen("new-project");
    setFailure(null);
  };

  const move = async () => {
    if (destination !== "existing" || !picked || !target.request) return;
    setMoving(true);
    setFailure(null);
    try {
      const result = await getTransport().moveThreadToProject({ threadId, workspaceId: picked.id, target: target.request });
      if (result.status === "moved") {
        applyMoved(result.thread);
        useSidebarUiStore.getState().expandProject(result.thread.workspace_id);
        closeMoveThreadDialog();
        return;
      }
      const refused = describeRefusal(result);
      if (!refused.retryable) setPickedId(null);
      setFailure(refused);
    } catch (error) {
      setFailure(describeException(error));
    }
    setMoving(false);
  };

  return { destination, picked, target, moving, failure, pick, chooseNewProject, move: () => void move() };
}

function MoveThreadDialog({ threadId, initialProjectId }: { threadId: string; initialProjectId: string | null }) {
  const thread = useWorkspaceStore((state) => state.threads.find((candidate) => candidate.id === threadId));
  const threadInNoProject = useWorkspaceStore((state) => isNoProjectWorkspace(state.workspaces.find((candidate) => candidate.id === thread?.workspace_id)));
  const preflight = useMovePreflight(threadId);
  const newProject = useNewProjectMove(threadId, preflight.read);
  const flow = useMoveFlow(threadId, initialProjectId, newProject);

  // The thread left No project, here or on another client, or was deleted: there is nothing left to move. A
  // new-project move turns the thread's workspace into a project before its last frame arrives, so leaving No
  // project only means the move is over once nothing is following it.
  const stale = !thread || (!threadInNoProject && !followsMove(newProject.run));
  useEffect(() => {
    if (stale) closeMoveThreadDialog();
  }, [stale]);
  if (stale) return null;
  const { run } = newProject;
  if (run.kind === "git-failed" || run.kind === "git-started") return <GitFailedAlert threadTitle={thread.title} newProject={newProject} run={run} />;
  const closeOnly = endsAtClose(run) || flow.failure?.unconfirmed === true;
  return <MoveThreadDialogView title={thread.title} flow={flow} preflight={preflight} newProject={newProject} closeOnly={closeOnly} />;
}

interface GitFailedAlertProps {
  readonly threadTitle: string;
  readonly newProject: NewProjectMove;
  readonly run: Extract<NewProjectRun, { kind: "git-failed" | "git-started" }>;
}

function GitFailedAlert({ threadTitle, newProject, run }: GitFailedAlertProps) {
  const workspace = useWorkspaceStore((state) => state.workspaces.find((candidate) => candidate.id === run.workspaceId));
  const { values } = newProject;
  // The path the user typed is how they know the folder; a dialog opened on a finished move has only the server's.
  const typedPath = values.name !== "" && values.location.trim() !== "" ? destinationPath(values) : null;
  return (
    <GitFailedDialog
      threadTitle={threadTitle}
      projectName={workspace?.name ?? values.name}
      projectPath={typedPath ?? workspace?.path ?? values.name}
      git={run.kind === "git-started" ? { kind: "started" } : { kind: "failed", error: run.error, retrying: run.retrying }}
      onRetry={newProject.retryGit}
      onDone={closeMoveThreadDialog}
    />
  );
}

interface MoveThreadDialogViewProps {
  readonly title: string;
  readonly flow: MoveFlow;
  readonly preflight: MovePreflightState;
  readonly newProject: NewProjectMove;
  readonly closeOnly: boolean;
}

const NEW_PROJECT_SLOT = "a new project";

type TargetPicker = "workspace" | "target" | "baseBranch";
type TargetPickerOpenChange = (picker: TargetPicker, open: boolean) => void;

function MoveThreadDialogView({ title, flow, preflight, newProject, closeOnly }: MoveThreadDialogViewProps) {
  const headingId = useId();
  const [chooserOpen, setChooserOpen] = useState(false);
  const [openTargetPickers, setOpenTargetPickers] = useState<ReadonlySet<TargetPicker>>(() => new Set());
  const onPickerOpenChange: TargetPickerOpenChange = (picker, open) => {
    setOpenTargetPickers((current) => {
      const next = new Set(current);
      if (open) next.add(picker);
      else next.delete(picker);
      return next;
    });
  };
  const intoNewProject = flow.destination === "new-project";
  const picked = intoNewProject ? undefined : flow.picked;
  const moving = flow.moving || newProject.run.kind === "moving";
  const popupRef = useRef<HTMLDivElement>(null);
  const nameFieldRef = useRef<HTMLInputElement>(null);
  // With no project to pick, the form is the only task. Otherwise focus stays on the dialog itself: the first
  // control is the project slot, and focusing it would draw its ring and open its tooltip over the thread title.
  const initialFocus = () => (intoNewProject && !moving ? nameFieldRef.current : null) ?? popupRef.current ?? false;
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !moving) closeMoveThreadDialog(); }}>
      <DialogContent
        ref={popupRef}
        initialFocus={initialFocus}
        aria-labelledby={headingId}
        aria-busy={moving || undefined}
        closeDisabled={moving}
        className="sm:max-w-[50rem]"
      >
        {/* min-w-0 lets the one-line title fade at the dialog's edge instead of widening the dialog's grid column. */}
        <DialogHeader className="min-w-0 items-center pl-9 text-center">
          <span className="flex max-w-full min-w-0 items-center gap-2 text-body-small text-muted">
            <InboxIcon aria-hidden className="size-3.5 shrink-0" />
            <span className="min-w-0 text-fade">{title}</span>
          </span>
          <ProjectSlotHeading
            as="h2"
            id={headingId}
            projectName={intoNewProject ? NEW_PROJECT_SLOT : picked?.name}
            prefix="Move to"
            suffix=""
            pick={{
              selectedWorkspaceId: picked?.id ?? null,
              onSelect: (workspace) => { setOpenTargetPickers(new Set()); flow.pick(workspace); },
              onOpenChange: setChooserOpen,
              disabled: moving || closeOnly,
              newProject: {
                selected: intoNewProject,
                onSelect: () => { setOpenTargetPickers(new Set()); flow.chooseNewProject(); },
              },
            }}
          />
        </DialogHeader>
        {intoNewProject
          ? <NewProjectBody newProject={newProject} preflight={preflight} moving={moving} nameFieldRef={nameFieldRef} />
          : <ExistingProjectBody picked={picked} flow={flow} preflight={preflight} onPickerOpenChange={onPickerOpenChange} />}
        <MoveFooter flow={flow} preflight={preflight} chooserOpen={chooserOpen} targetPickerOpen={openTargetPickers.size > 0} newProject={newProject} closeOnly={closeOnly} />
      </DialogContent>
    </Dialog>
  );
}

function ExistingProjectBody({ picked, flow, preflight, onPickerOpenChange }: {
  picked: Workspace | undefined;
  flow: MoveFlow;
  preflight: MovePreflightState;
  onPickerOpenChange: TargetPickerOpenChange;
}) {
  const { failure } = flow;
  if (!picked && !failure) return null;
  return (
    <div className="grid gap-4">
      {picked ? <MoveTargetRail workspace={picked} target={flow.target} locked={flow.moving} onPickerOpenChange={onPickerOpenChange} /> : null}
      {picked && preflight.read.status === "failed" ? <PreflightFailedNotice onRetry={preflight.retry} /> : null}
      {failure ? <Notice tone="error" title={failure.unconfirmed ? "Couldn't confirm the move" : "Couldn't move the thread"} detail={failure.detail} more={failure.raw ?? undefined} /> : null}
    </div>
  );
}

interface NewProjectBodyProps {
  readonly newProject: NewProjectMove;
  readonly preflight: MovePreflightState;
  readonly moving: boolean;
  readonly nameFieldRef: Ref<HTMLInputElement>;
}

/**
 * Where a failed move's notice goes. A failure about the destination is about the Location, so its notice sits under
 * that field; any other failure sits below the form.
 */
function failureNotices(newProject: NewProjectMove): { readonly underLocation: ReactNode; readonly belowForm: ReactNode } {
  const { run, values } = newProject;
  if (run.kind === "result-unknown") return { underLocation: null, belowForm: <ResultUnknownNotice /> };
  if (run.kind !== "failed" && run.kind !== "rollback-pending") return { underLocation: null, belowForm: null };
  const notice = <MoveFailureNotice failure={run} projectName={values.name.trim()} threadCount={newProject.threadCount} />;
  return run.kind === "failed" && failureIsAboutLocation(run) ? { underLocation: notice, belowForm: null } : { underLocation: null, belowForm: notice };
}

/** The other threads the notice lists, or null when it would only repeat the busy notice. */
function sharersToList({ sharers, busy }: NewProjectMove): NonNullable<NewProjectMove["sharers"]> | null {
  // When the only other thread is the busy one, its own notice already says everything the sharers notice would.
  return sharers !== null && !(sharers.count === 1 && busy !== null && !busy.isOpenThread) ? sharers : null;
}

/** What the folder check found: the threads that move along, or that the check failed. */
function FolderCheckNotice({ newProject, preflight }: { newProject: NewProjectMove; preflight: MovePreflightState }) {
  if (newProject.retryLookup) return <PreflightFailedNotice onRetry={newProject.retryLookup} />;
  if (preflight.read.status === "failed") return <PreflightFailedNotice onRetry={preflight.retry} />;
  const sharers = sharersToList(newProject);
  return sharers ? <SharersNotice titles={sharers.titles} count={sharers.count} /> : null;
}

function NewProjectBody({ newProject, preflight, moving, nameFieldRef }: NewProjectBodyProps) {
  const { run, values, busy } = newProject;
  const { underLocation, belowForm } = failureNotices(newProject);
  return (
    <div className="grid gap-4">
      {endsAtClose(run) ? null : (
        <NewProjectForm
          values={values}
          initGit={newProject.initGit}
          messages={newProject.messages}
          nameFieldRef={nameFieldRef}
          locked={moving}
          locationNotice={underLocation}
          onChange={newProject.setValues}
          onInitGitChange={newProject.setInitGit}
        />
      )}
      {run.kind === "moving" && run.copy ? <CopyProgressBar progress={run.copy} /> : null}
      {busy ? <BusyNotice busy={busy} /> : null}
      {belowForm}
      <FolderCheckNotice newProject={newProject} preflight={preflight} />
    </div>
  );
}

interface MoveFooterProps {
  readonly flow: MoveFlow;
  readonly preflight: MovePreflightState;
  readonly chooserOpen: boolean;
  readonly targetPickerOpen: boolean;
  readonly newProject: NewProjectMove;
  readonly closeOnly: boolean;
}

function MoveFooter({ closeOnly, newProject, ...existing }: MoveFooterProps) {
  if (closeOnly) return <DialogFooter showCloseButton />;
  if (existing.flow.destination === "new-project") return <NewProjectFooter newProject={newProject} chooserOpen={existing.chooserOpen} />;
  return <ExistingProjectFooter {...existing} />;
}

function ExistingProjectFooter({ flow, preflight, chooserOpen, targetPickerOpen }: Omit<MoveFooterProps, "newProject" | "closeOnly">) {
  const { picked, moving, failure } = flow;
  const retrying = failure !== null && picked !== undefined;
  return (
    <DialogFooter>
      <FilesNote preflight={preflightOf(preflight.read)} picked={picked !== undefined} />
      <Button type="button" variant="outline" disabled={moving} onClick={closeMoveThreadDialog}>Cancel</Button>
      <Button type="button" loading={moving} disabled={picked === undefined || flow.target.request === null || chooserOpen || targetPickerOpen || preflight.read.status !== "ready"} onClick={flow.move}>
        {retrying ? <RotateCcw aria-hidden data-icon="inline-start" /> : <FolderInput aria-hidden data-icon="inline-start" />}
        {moving ? "Moving…" : retrying ? "Try again" : "Move thread"}
      </Button>
    </DialogFooter>
  );
}

function NewProjectFooter({ newProject, chooserOpen }: { newProject: NewProjectMove; chooserOpen: boolean }) {
  const { run } = newProject;
  const moving = run.kind === "moving";
  const retrying = run.kind === "failed";
  return (
    <DialogFooter>
      <Button type="button" variant="outline" disabled={moving} onClick={closeMoveThreadDialog}>Cancel</Button>
      {/* While it runs the button is busy, not disabled: loading already blocks the click, and disabled would wash it out. */}
      <Button type="button" loading={moving} disabled={!moving && (!newProject.canCreate || chooserOpen)} onClick={newProject.create}>
        {retrying ? <RotateCcw aria-hidden data-icon="inline-start" /> : <FolderPlus aria-hidden data-icon="inline-start" />}
        {moving ? (run.copy ? "Copying files…" : "Moving…") : retrying ? "Try again" : "Create project"}
      </Button>
    </DialogFooter>
  );
}

/**
 * The request captured the target when Move was pressed, so the rail is locked while it runs: a changed rail would
 * name a destination the thread is not going to.
 */
function MoveTargetRail({ workspace, target, locked, onPickerOpenChange }: {
  workspace: Workspace; target: MoveTargetState; locked: boolean; onPickerOpenChange: TargetPickerOpenChange;
}) {
  return (
    <fieldset disabled={locked} data-testid="move-target-rail" className="flex min-w-0 items-center gap-1 rounded-xl bg-page px-2 py-0.5">
      {/* Its menus open downward: the rail sits under the 'Move to' heading, which an upward menu would cover. */}
      <WorkspaceTargetMenu
        mode={target.mode}
        isGitRepo={workspace.is_git_repo}
        folder={basename(workspace.path)}
        unavailable={target.unavailable}
        onModeChange={target.setMode}
        onOpenChange={(open) => onPickerOpenChange("workspace", open)}
        side="bottom"
      />
      {workspace.is_git_repo && target.mode === "direct" ? <LocalBranchLabel workspaceId={workspace.id} /> : null}
      {workspace.is_git_repo && target.mode !== "direct" ? (
        <div className="ml-auto flex min-w-0 items-center gap-1">
          <TargetTriggers selection={target.selection} side="bottom" onOpenChange={onPickerOpenChange} />
        </div>
      ) : null}
    </fieldset>
  );
}

function LocalBranchLabel({ workspaceId }: { workspaceId: string }) {
  const branch = useDefaultBranchTarget({ workspaceId });
  const label = branch ? newThreadTargetLabel({ mode: "direct", branch: branch.name }) : null;
  if (!label) return null;
  return (
    <span className="ml-auto flex min-w-0 items-center gap-2 px-2 font-code text-caption text-muted">
      <GitBranch aria-hidden className="size-3.5 shrink-0" />
      <span className="min-w-0 text-fade">{targetLabelText(label)}</span>
    </span>
  );
}

function FilesNote({ preflight, picked }: { preflight: ThreadMovePreflight | null; picked: boolean }) {
  if (!picked || !preflight?.hasFiles) return null;
  const when: ReactNode = preflight.otherThreadsInFolder.count > 0
    ? "once unused"
    : <span className="text-ink">{formatRemovalDate(preflight.deadline)}</span>;
  return (
    <p className="flex min-w-0 items-center gap-2 text-body-small text-muted sm:mr-auto">
      <Trash2 aria-hidden className="size-3.5 shrink-0" />
      <span className="min-w-0 text-fade">Old files deleted {when}</span>
    </p>
  );
}
