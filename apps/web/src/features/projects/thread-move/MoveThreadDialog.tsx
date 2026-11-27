import { useEffect, useId, useState, type ReactNode } from "react";
import { FolderInput, GitBranch, InboxIcon, RotateCcw, Trash2 } from "lucide-react";
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
import { isNoProjectWorkspace } from "../state/project-workspaces";
import { useWorkspaceStore } from "../state/workspaceStore";
import { closeMoveThreadDialog, useMoveThreadStore } from "./move-thread-store";
import { PreflightFailedNotice } from "./PreflightFailedNotice";
import { useMoveTarget, type MoveTargetState } from "./useMoveTarget";
import { preflightOf, useMovePreflight, type MovePreflightState } from "./useMovePreflight";

/** The global move dialog. It mounts once and opens for the thread {@link openMoveThreadDialog} names. */
export function MoveThreadDialogHost() {
  const threadId = useMoveThreadStore((state) => state.threadId);
  return threadId === null ? null : <MoveThreadDialog key={threadId} threadId={threadId} />;
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

interface MoveFlow {
  readonly picked: Workspace | undefined;
  readonly target: MoveTargetState;
  readonly moving: boolean;
  readonly failure: MoveFailure | null;
  readonly pick: (workspace: Workspace) => void;
  readonly move: () => void;
}

/** The dialog's one choice and the one request it can make, with how that request ended. */
function useMoveFlow(threadId: string): MoveFlow {
  const applyMoved = useWorkspaceStore((state) => state.applyThreadMovedToProject);
  const [pickedId, setPickedId] = useState<string | null>(null);
  const picked = useWorkspaceStore((state) => state.workspaces.find((candidate) => candidate.id === pickedId && candidate.kind === "project"));
  const target = useMoveTarget(picked);
  const [moving, setMoving] = useState(false);
  const [failure, setFailure] = useState<MoveFailure | null>(null);

  const pick = (workspace: Workspace) => {
    setPickedId(workspace.id);
    setFailure(null);
  };

  const move = async () => {
    if (!picked || !target.request) return;
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

  return { picked, target, moving, failure, pick, move: () => void move() };
}

function MoveThreadDialog({ threadId }: { threadId: string }) {
  const thread = useWorkspaceStore((state) => state.threads.find((candidate) => candidate.id === threadId));
  const threadInNoProject = useWorkspaceStore((state) => isNoProjectWorkspace(state.workspaces.find((candidate) => candidate.id === thread?.workspace_id)));
  const flow = useMoveFlow(threadId);
  const preflight = useMovePreflight(threadId);

  // The thread left No project, here or on another client, or was deleted: there is nothing left to move.
  const stale = !thread || !threadInNoProject;
  useEffect(() => {
    if (stale) closeMoveThreadDialog();
  }, [stale]);
  if (stale) return null;
  return <MoveThreadDialogView title={thread.title} flow={flow} preflight={preflight} />;
}

interface MoveThreadDialogViewProps {
  readonly title: string;
  readonly flow: MoveFlow;
  readonly preflight: MovePreflightState;
}

function MoveThreadDialogView({ title, flow, preflight }: MoveThreadDialogViewProps) {
  const headingId = useId();
  const [chooserOpen, setChooserOpen] = useState(false);
  const { picked, moving } = flow;
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !moving) closeMoveThreadDialog(); }}>
      <DialogContent
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
            projectName={picked?.name}
            prefix="Move to"
            suffix=""
            pick={{ selectedWorkspaceId: picked?.id ?? null, onSelect: flow.pick, onOpenChange: setChooserOpen, disabled: moving || flow.failure?.unconfirmed }}
          />
        </DialogHeader>
        <MoveBody flow={flow} preflight={preflight} />
        <MoveFooter flow={flow} preflight={preflight} chooserOpen={chooserOpen} />
      </DialogContent>
    </Dialog>
  );
}

function MoveBody({ flow, preflight }: { flow: MoveFlow; preflight: MovePreflightState }) {
  const { picked, failure } = flow;
  if (!picked && !failure) return null;
  return (
    <div className="grid gap-4">
      {picked ? <MoveTargetRail workspace={picked} target={flow.target} /> : null}
      {picked && preflight.read.status === "failed" ? <PreflightFailedNotice onRetry={preflight.retry} /> : null}
      {failure ? <Notice tone="error" title={failure.unconfirmed ? "Couldn't confirm the move" : "Couldn't move the thread"} detail={failure.detail} more={failure.raw ?? undefined} /> : null}
    </div>
  );
}

function MoveFooter({ flow, preflight, chooserOpen }: { flow: MoveFlow; preflight: MovePreflightState; chooserOpen: boolean }) {
  const { picked, moving, failure } = flow;
  if (failure?.unconfirmed) return <DialogFooter showCloseButton />;
  const retrying = failure !== null && picked !== undefined;
  return (
    <DialogFooter>
      <FilesNote preflight={preflightOf(preflight.read)} picked={picked !== undefined} />
      <Button type="button" variant="outline" disabled={moving} onClick={closeMoveThreadDialog}>Cancel</Button>
      <Button type="button" loading={moving} disabled={picked === undefined || flow.target.request === null || chooserOpen || preflight.read.status !== "ready"} onClick={flow.move}>
        {retrying ? <RotateCcw aria-hidden data-icon="inline-start" /> : <FolderInput aria-hidden data-icon="inline-start" />}
        {moving ? "Moving…" : retrying ? "Try again" : "Move thread"}
      </Button>
    </DialogFooter>
  );
}

function MoveTargetRail({ workspace, target }: { workspace: Workspace; target: MoveTargetState }) {
  return (
    <div data-testid="move-target-rail" className="flex min-w-0 items-center gap-1 rounded-xl bg-page px-2 py-0.5">
      {/* Its menus open downward: the rail sits under the 'Move to' heading, which an upward menu would cover. */}
      <WorkspaceTargetMenu
        mode={target.mode}
        isGitRepo={workspace.is_git_repo}
        folder={basename(workspace.path)}
        unavailable={target.unavailable}
        onModeChange={target.setMode}
        side="bottom"
      />
      {workspace.is_git_repo && target.mode === "direct" ? <LocalBranchLabel workspaceId={workspace.id} /> : null}
      {workspace.is_git_repo && target.mode !== "direct" ? (
        <div className="ml-auto flex min-w-0 items-center gap-1">
          <TargetTriggers selection={target.selection} side="bottom" />
        </div>
      ) : null}
    </div>
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
