import { useEffect, useRef } from "react";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Notice } from "@/components/ui/notice";
import { BreakablePath } from "./BreakablePath";

const PERMISSION_DENIED = /EACCES|EPERM|permission denied/i;

/** Where git setup stands: still failing, with what git said, or started by a retry. */
export type GitSetupState =
  | { readonly kind: "failed"; readonly error: string; readonly retrying: boolean }
  | { readonly kind: "started" };

interface GitFailedDialogProps {
  readonly threadTitle: string;
  readonly projectName: string;
  readonly projectPath: string;
  readonly git: GitSetupState;
  readonly onRetry: () => void;
  readonly onDone: () => void;
}

/**
 * Tells the user the project exists and the thread is in it, and that only git setup failed. That is a result to
 * acknowledge, not a question, so it is an alert dialog with Done as the next step and Retry git setup as the option.
 * A retry that works swaps the failure for a success line and leaves Done to close, so the user reads the outcome.
 */
export function GitFailedDialog({ threadTitle, projectName, projectPath, git, onRetry, onDone }: GitFailedDialogProps) {
  const doneRef = useRef<HTMLButtonElement>(null);
  const started = git.kind === "started";
  // The focused Retry button leaves with the failure, and focus would fall out of the dialog with it.
  useEffect(() => {
    if (started) doneRef.current?.focus();
  }, [started]);
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onDone(); }}>
      <DialogContent role="alertdialog" className="sm:max-w-[50rem]">
        <DialogHeader className="items-center text-center">
          <DialogTitle className="text-xl tracking-[-0.02em] text-ink">Project created</DialogTitle>
          {/* A thread title is often a long prompt: it fades on one line, and the rest of the sentence wraps beside or below it. */}
          <DialogDescription className="flex max-w-full flex-wrap justify-center gap-x-1 text-body-small">
            <span className="max-w-full text-fade">“{threadTitle}”</span>{" "}
            <span>now runs in the {projectName} project.</span>
          </DialogDescription>
        </DialogHeader>
        {git.kind === "started" ? <Notice tone="success" title="Git repo started" /> : <GitFailureNotice error={git.error} projectPath={projectPath} />}
        <DialogFooter>
          {git.kind === "failed" ? (
            <Button type="button" variant="outline" loading={git.retrying} onClick={onRetry}>
              <RotateCcw aria-hidden data-icon="inline-start" />
              Retry git setup
            </Button>
          ) : null}
          <Button ref={doneRef} type="button" onClick={onDone}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function GitFailureNotice({ error, projectPath }: { readonly error: string; readonly projectPath: string }) {
  return (
    <Notice
      tone="error"
      title="Couldn't start a git repo"
      detail={
        <>
          {PERMISSION_DENIED.test(error) ? "Permission was denied in the project folder. " : ""}
          The project works without git. Check you can write to <BreakablePath path={projectPath} />, then retry, or run git init later.
        </>
      }
      more={error}
    />
  );
}
