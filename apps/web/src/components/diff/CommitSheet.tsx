import { useEffect, useRef, useState } from "react";
import type { ReviewState } from "@mcode/contracts";
import { X } from "lucide-react";
import { IconButton } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { DIALOG_SURFACE_CLASS } from "@/components/ui/overlay-surface";
import { Notice } from "@/components/ui/notice";
import { Spinner } from "@/components/ui/spinner";
import { SplitButton } from "@/components/ui/split-button";
import { isRequestInFlight, useCommitSheet, type CommitSheetModel } from "@/hooks/useCommitSheet";
import { useReviewState } from "@/hooks/useReviewState";
import { useUncommittedFiles, type UncommittedFiles } from "@/hooks/useUncommittedFiles";
import { cn } from "@/lib/utils";
import { CommitFileList } from "./CommitFileList";
import { CommitMessageBox } from "./CommitMessageBox";
import { CommitOutcomeNotice } from "./CommitOutcomeNotice";

type GitReviewState = Extract<ReviewState, { isGitRepo: true }>;

export interface CommitSheetProps {
  readonly workspaceId: string;
  readonly threadId: string | null;
  /** Review's scope id (thread, else workspace). */
  readonly scopeId: string;
  /** Review's file in view; its folder stays open in a long list. */
  readonly activePath: string | null;
  readonly onClose: () => void;
  readonly className?: string;
}

/**
 * The Commit sheet: pick files, edit the generated message, commit, optionally push.
 * It reads the uncommitted files itself, so it lists the same files whatever view
 * Review shows, and closing it leaves Review as it was.
 */
export function CommitSheet({ workspaceId, threadId, scopeId, activePath, onClose, className }: CommitSheetProps) {
  const reviewState = useReviewStateAcrossRefresh(workspaceId, threadId);
  const uncommitted = useUncommittedFiles(workspaceId, threadId);
  const files = uncommitted.status === "ready" ? uncommitted.files : null;
  const model = useCommitSheet({
    workspaceId,
    threadId,
    scopeId,
    head: reviewState ? reviewState.head : undefined,
    files,
    onDone: onClose,
  });
  const sheet = useRef<HTMLElement>(null);
  useEffect(() => sheet.current?.focus(), []);

  const { submission } = model;
  const inFlight = isRequestInFlight(submission);

  return (
    <section
      ref={sheet}
      role="dialog"
      aria-label="Commit"
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === "Escape" && submission.kind !== "committing" && submission.kind !== "pushing") onClose();
      }}
      className={cn(DIALOG_SURFACE_CLASS, "flex w-[496px] max-w-full flex-col gap-3 p-4 outline-none", className)}
    >
      <SheetHeader branch={reviewState?.branch ?? null} closeDisabled={submission.kind === "committing" || submission.kind === "pushing"} onClose={onClose} />
      <FilesSection uncommitted={uncommitted} model={model} activePath={activePath} locked={inFlight} />
      <CommitMessageBox
        draft={model.draft}
        onChange={model.setDraft}
        generation={model.generation}
        hasSelection={model.selected.length > 0}
        locked={inFlight}
        onRegenerate={model.regenerate}
      />
      <CommitOutcomeNotice submission={submission} onRetry={model.retry} />
      <SheetFooter model={model} branchless={reviewState?.branch === null} />
    </section>
  );
}

function FilesSection({
  uncommitted,
  model,
  activePath,
  locked,
}: {
  readonly uncommitted: UncommittedFiles;
  readonly model: CommitSheetModel;
  readonly activePath: string | null;
  readonly locked: boolean;
}) {
  if (uncommitted.status === "loading") return <Spinner size={16} className="self-center text-muted" />;
  if (uncommitted.status === "failed") {
    return <Notice tone="error" title="Couldn't load the changed files" detail={uncommitted.message} />;
  }
  return (
    <CommitFileList
      files={uncommitted.files}
      choices={model.choices}
      onSetChecked={model.setChecked}
      activePath={activePath}
      locked={locked}
    />
  );
}

function SheetHeader({
  branch,
  closeDisabled,
  onClose,
}: {
  readonly branch: string | null;
  readonly closeDisabled: boolean;
  readonly onClose: () => void;
}) {
  return (
    <div className="flex h-8 items-center gap-2">
      <h2 className="text-body-small font-semibold text-ink">Commit</h2>
      {branch ? (
        <span className="text-fade min-w-0 flex-1 whitespace-nowrap font-mono text-caption text-muted">{branch}</span>
      ) : (
        <span className="flex-1" />
      )}
      <IconButton variant="ghost" aria-label="Close" disabled={closeDisabled} onClick={onClose}>
        <X />
      </IconButton>
    </div>
  );
}

function SheetFooter({ model, branchless }: { readonly model: CommitSheetModel; readonly branchless: boolean }) {
  const { submission } = model;
  return (
    <div className="flex items-center justify-end gap-3">
      {submission.kind === "pushing" ? (
        <span className="flex items-center gap-2 text-caption text-muted">
          <Spinner size={16} className="text-muted" />
          Pushing…
        </span>
      ) : null}
      <SplitButton
        variant="default"
        disabled={!model.canCommit}
        loading={submission.kind === "committing"}
        onClick={() => model.submit(false)}
        menuLabel="More commit actions"
        menu={
          <DropdownMenuItem
            label="Commit and push"
            disabledReason={branchless ? "Create a branch to push" : null}
            onClick={() => model.submit(true)}
          />
        }
      >
        {commitLabel(model.selected.length)}
      </SplitButton>
    </div>
  );
}

function commitLabel(count: number): string {
  return count === 1 ? "Commit 1 file" : `Commit ${count} files`;
}

function useReviewStateAcrossRefresh(workspaceId: string, threadId: string | null): GitReviewState | null {
  const { state } = useReviewState(workspaceId, threadId);
  const [kept, setKept] = useState<GitReviewState | null>(null);
  if (state?.isGitRepo && state !== kept) setKept(state);
  return kept;
}
