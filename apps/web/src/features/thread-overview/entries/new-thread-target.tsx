import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { PICKER_PANEL_CLASS } from "@/components/ui/picker";
import { Popover, PopoverTrigger } from "@/components/ui/popover";
import { sidePlacement } from "@/components/ui/side-placement";
import { BranchTargetPicker } from "@/features/conversation/composer/execution/BranchTargetPicker";
import { COMPOSER_MODE_OPTIONS, type ComposerMode } from "@/features/conversation/composer/execution/composer-mode";
import { newThreadComposerMode, selectNewThreadMode } from "@/features/conversation/composer/execution/new-thread-mode";
import { StartFromOriginSwitch } from "@/features/conversation/composer/execution/StartFromOriginSwitch";
import { newThreadWorkspaceMeta, type TargetLabel } from "@/features/conversation/composer/execution/new-thread-target-copy";
import { useNewThreadTargetSelection, type TargetPick } from "@/features/conversation/composer/execution/useComposerTargetSelection";
import { WorkspaceModeMenuGroup } from "@/features/conversation/composer/execution/WorkspaceTargetMenu";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { OVERVIEW_ROW_CLASS, OverviewRowIcon } from "@/features/thread-overview/overview-row";
import { OverviewSideMenu } from "@/features/thread-overview/overview-side-menu";
import type { OverviewSubject } from "@/features/thread-overview/overview-subject";
import { basename } from "@/lib/path";
import { cn } from "@/lib/utils";
import type { Workspace } from "@/transport";
import { ChevronDown, GitBranch, GitFork } from "lucide-react";
import { useRef, useState, type ComponentType, type ReactNode } from "react";

interface NewThreadTarget {
  readonly workspace: Workspace;
  readonly mode: ComposerMode;
}

/** The workspace and effective mode a new thread's target rows describe; null before the project loads. */
function useNewThreadTarget(workspaceId: string): NewThreadTarget | null {
  const workspace = useWorkspaceStore((state) => state.workspaces.find((candidate) => candidate.id === workspaceId));
  const newThreadMode = useWorkspaceStore((state) => state.newThreadMode);
  if (!workspace) return null;
  return { workspace, mode: newThreadComposerMode(workspace.is_git_repo, newThreadMode) };
}

interface TargetRowContentProps {
  Icon: ComponentType<{ className?: string }>;
  children: ReactNode;
  /** Absent for a row that opens nothing. */
  open?: boolean;
}

function TargetRowContent({ Icon, children, open }: TargetRowContentProps) {
  return (<>
    <span className="flex min-w-0 items-center gap-2">
      <OverviewRowIcon>
        <Icon />
      </OverviewRowIcon>
      <span className="text-fade">{children}</span>
    </span>
    {open === undefined ? null : (
      <ChevronDown
        size={13}
        aria-hidden
        className={cn("shrink-0 text-muted transition-transform duration-150", open && "rotate-180")}
      />
    )}
  </>);
}

function WorkspaceRowLabel({ label, meta }: { label: string; meta: string | null }) {
  return (<>
    <span className="font-medium text-ink">{label}</span>
    {meta ? <span className="text-muted"> · {meta}</span> : null}
  </>);
}

function TargetLabelText({ label }: { label: TargetLabel }) {
  return (<>
    {label.prefix ? <span className="text-muted">{label.prefix} </span> : null}
    <span className="font-medium text-ink">{label.name}</span>
  </>);
}

interface TargetRowButtonProps {
  testId: string;
  open: boolean;
  children: ReactNode;
}

/** The trigger element a row's menu renders into, with the open fill the side menu points at. */
function rowButton({ testId, open, children }: TargetRowButtonProps) {
  return (
    <Button
      variant="ghost"
      size="compact"
      type="button"
      data-testid={testId}
      className={cn(OVERVIEW_ROW_CLASS, "justify-between", open && "bg-hover text-ink")}
    >
      {children}
    </Button>
  );
}

function WorkspaceRow({ target }: { target: NewThreadTarget }) {
  const [open, setOpen] = useState(false);
  const rowRef = useRef<HTMLButtonElement>(null);
  const { workspace, mode } = target;
  const folder = basename(workspace.path);
  const selectedWorktree = useWorkspaceStore((state) => state.selectedWorktree);
  const { Icon, label } = COMPOSER_MODE_OPTIONS[mode];
  const content = <WorkspaceRowLabel label={label} meta={newThreadWorkspaceMeta(mode, folder, selectedWorktree)} />;
  if (!workspace.is_git_repo) {
    return (
      <div data-testid="overview-target-workspace" className={cn(OVERVIEW_ROW_CLASS, "flex items-center")}>
        <TargetRowContent Icon={Icon}>{content}</TargetRowContent>
      </div>
    );
  }
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        ref={rowRef}
        render={rowButton({
          testId: "overview-target-workspace",
          open,
          children: <TargetRowContent Icon={Icon} open={open}>{content}</TargetRowContent>,
        })}
      />
      {/* A menu rather than OverviewSideMenu's popover, so the rows keep menu keyboard behavior; the placement is the same. */}
      <DropdownMenuContent {...sidePlacement(rowRef)} className="w-[28.8rem]">
        <WorkspaceModeMenuGroup
          mode={mode}
          folder={folder}
          onModeChange={(next) => selectNewThreadMode(workspace.id, next)}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function BranchRow({ pick, workspaceId, testId }: { pick: TargetPick; workspaceId: string; testId: string }) {
  const [open, setOpen] = useState(false);
  const rowRef = useRef<HTMLButtonElement>(null);
  const Icon = pick.list === "worktrees" ? GitFork : GitBranch;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        ref={rowRef}
        render={rowButton({
          testId,
          open,
          children: <TargetRowContent Icon={Icon} open={open}><TargetLabelText label={pick.label} /></TargetRowContent>,
        })}
      />
      <OverviewSideMenu rowRef={rowRef} className={PICKER_PANEL_CLASS}>
        <BranchTargetPicker
          workspaceId={workspaceId}
          list={pick.list}
          value={pick.value}
          footer={pick.origin ? <StartFromOriginSwitch origin={pick.origin} /> : undefined}
          onSelect={(picked) => {
            pick.select(picked);
            setOpen(false);
          }}
        />
      </OverviewSideMenu>
    </Popover>
  );
}

function BranchRows({ target }: { target: NewThreadTarget }) {
  const { workspace, mode } = target;
  const selection = useNewThreadTargetSelection(workspace.id, mode);
  return (<>
    <BranchRow pick={selection.target} workspaceId={workspace.id} testId="overview-target-branch" />
    {selection.baseBranch
      ? <BranchRow pick={selection.baseBranch} workspaceId={workspace.id} testId="overview-target-base-branch" />
      : null}
  </>);
}

function WorkspaceEntry({ workspaceId }: { workspaceId: string }) {
  const target = useNewThreadTarget(workspaceId);
  return target ? <WorkspaceRow target={target} /> : null;
}

function BranchEntry({ workspaceId }: { workspaceId: string }) {
  const target = useNewThreadTarget(workspaceId);
  // A project that is not a git repo runs in its folder as it is, so there is no branch to pick.
  return target?.workspace.is_git_repo ? <BranchRows target={target} /> : null;
}

/** Where a new thread runs: New worktree, Existing worktree or Local, with the menu that switches it. */
export function TargetWorkspaceEntryBlock({ subject }: { subject: OverviewSubject }) {
  return subject.kind === "new-thread" ? <WorkspaceEntry workspaceId={subject.workspaceId} /> : null;
}

/** The branch, pull request or worktree a new thread starts from, with the picker that changes it. */
export function TargetBranchEntryBlock({ subject }: { subject: OverviewSubject }) {
  return subject.kind === "new-thread" ? <BranchEntry workspaceId={subject.workspaceId} /> : null;
}
