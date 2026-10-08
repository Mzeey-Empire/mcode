import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { sanitizeCustomBranchInput, trimTrailingBranchChars } from "@/lib/branch-name";
import { getTransport, type Thread } from "@/transport";
import { GitBranch } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

interface CreateThreadBranchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  thread: Thread;
  title: string;
  description: string;
  submitLabel: string;
  onCreated: (branch: string) => void;
}

function branchCreationErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err || "Unknown error");
}

function updateThreadToNamedBranch(threadId: string, branch: string): void {
  useWorkspaceStore.setState((state) => ({
    threads: state.threads.map((candidate) =>
      candidate.id === threadId
        ? {
          ...candidate,
          branch,
          checkout_state: "named" as const,
          pr_number: null,
          pr_status: null,
        }
        : candidate,
    ),
    prUrlsByThreadId: Object.fromEntries(
      Object.entries(state.prUrlsByThreadId).filter(([candidateId]) => candidateId !== threadId),
    ),
    checksById: Object.fromEntries(
      Object.entries(state.checksById).filter(([candidateId]) => candidateId !== threadId),
    ) as typeof state.checksById,
    worktreesLoadedForWorkspace: null,
  }));
}

/** Branch naming dialog shared by both branch entry points. */
export function CreateThreadBranchDialog(props: CreateThreadBranchDialogProps) {
  if (!props.open) return null;
  return <CreateThreadBranchDialogSession {...props} />;
}

function CreateThreadBranchDialogSession({
  open,
  onOpenChange,
  thread,
  title,
  description,
  submitLabel,
  onCreated,
}: CreateThreadBranchDialogProps) {
  const [branchName, setBranchName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const branchInputRef = useRef<HTMLInputElement>(null);
  const finalBranchName = trimTrailingBranchChars(branchName.trim());
  const errorId = "create-thread-branch-error";

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      branchInputRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  const handleSubmit = useCallback(async () => {
    const name = finalBranchName;
    if (!name || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await getTransport().createBranch(thread.workspace_id, name, thread.id);
      const nextBranch = result.branch || name;
      updateThreadToNamedBranch(thread.id, nextBranch);
      onOpenChange(false);
      onCreated(nextBranch);
    } catch (err) {
      setError(branchCreationErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }, [finalBranchName, onCreated, onOpenChange, submitting, thread.id, thread.workspace_id]);

  return (
    <Dialog open={open} onOpenChange={submitting ? undefined : onOpenChange}>
      <DialogContent
        className="w-[min(92vw,440px)] gap-0 overflow-hidden p-0"
        showCloseButton={!submitting}
      >
        <div className="flex items-center gap-3 border-b border-border/50 py-4 pl-5 pr-12">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-hover/40">
            <GitBranch className="size-3.5 text-muted" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <DialogTitle className="text-sm font-medium leading-none">
              {title}
            </DialogTitle>
            <DialogDescription className="mt-1 max-w-[36ch] text-pretty text-xs leading-5 text-muted">
              {description}
            </DialogDescription>
          </div>
        </div>

        <div className="px-5 py-4">
          <div className="space-y-1.5">
            <label htmlFor="create-thread-branch" className="text-xs text-muted">
              Branch name
            </label>
            <Input
              ref={branchInputRef}
              id="create-thread-branch"
              value={branchName}
              onChange={(event) => {
                setBranchName(sanitizeCustomBranchInput(event.target.value));
                setError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void handleSubmit();
                }
              }}
              disabled={submitting}
              placeholder="feat/my-change"
              aria-invalid={error ? "true" : undefined}
              aria-describedby={error ? errorId : undefined}
              className="font-mono"
            />
          </div>

          {error ? (
            <div
              id={errorId}
              role="alert"
              className="mt-3 break-words rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive"
            >
              {error}
            </div>
          ) : null}
        </div>

        <DialogFooter className="m-0 flex-row justify-end gap-2 rounded-none border-t border-border/30 bg-transparent px-5 py-3.5">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button
            onClick={() => void handleSubmit()}
            disabled={submitting || !finalBranchName}
            className="min-w-[7rem] gap-1.5"
          >
            {submitting ? <Spinner size={14} className="text-current" /> : null}
            {submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface ThreadOverviewBranchCreation {
  threadId: string;
  open: boolean;
  branch: string | null;
  baseBranch: string | null;
}

/** Tracks branch creation while the overview popover is closed. */
export function useThreadOverviewBranchCreation(threadId: string) {
  const [creation, setCreation] = useState<ThreadOverviewBranchCreation>({
    threadId,
    open: false,
    branch: null,
    baseBranch: null,
  });
  const current = creation.threadId === threadId
    ? creation
    : { threadId, open: false, branch: null, baseBranch: null };
  const setOpen = useCallback((open: boolean) => {
    setCreation((previous) => ({
      ...(previous.threadId === threadId
        ? previous
        : { threadId, branch: null, baseBranch: null }),
      open,
    }));
  }, [threadId]);
  const complete = useCallback((branch: string, baseBranch: string | null) => {
    setCreation({ threadId, open: false, branch, baseBranch });
  }, [threadId]);

  return { ...current, setOpen, complete };
}

/**
 * Returns whether a branchless worktree can enter the Create PR naming step.
 */
export function canStartBranchlessCreatePr(
  thread: Pick<Thread, "mode" | "checkout_state">,
): boolean {
  return thread.mode === "worktree" && thread.checkout_state === "branchless";
}
