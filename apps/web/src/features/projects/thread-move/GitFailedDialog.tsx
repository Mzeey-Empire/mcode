import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Notice } from "@/components/ui/notice";

const PERMISSION_DENIED = /EACCES|EPERM|permission denied/i;

interface GitFailedDialogProps {
  readonly threadTitle: string;
  readonly projectName: string;
  /** Where the project's folder is, as the user would read it. */
  readonly projectPath: string;
  /** What git said, kept behind the notice's disclosure. */
  readonly error: string;
  readonly retrying: boolean;
  readonly onRetry: () => void;
  readonly onDone: () => void;
}

/**
 * Tells the user the project exists and the thread is in it, and that only git setup failed. That is a result to
 * acknowledge, not a question, so it is an alert dialog with Done as the next step and Retry git setup as the option.
 */
export function GitFailedDialog({ threadTitle, projectName, projectPath, error, retrying, onRetry, onDone }: GitFailedDialogProps) {
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onDone(); }}>
      <DialogContent role="alertdialog" className="sm:max-w-[50rem]">
        <DialogHeader className="items-center text-center">
          <DialogTitle className="text-xl tracking-[-0.02em] text-ink">Project created</DialogTitle>
          <DialogDescription className="text-body-small">“{threadTitle}” now runs in the {projectName} project.</DialogDescription>
        </DialogHeader>
        <Notice
          tone="error"
          title="Couldn't start a git repo"
          detail={
            <>
              {PERMISSION_DENIED.test(error) ? "Permission was denied in the project folder. " : ""}
              The project works without git. Check you can write to <span className="font-code break-all">{projectPath}</span>, then retry, or run git init later.
            </>
          }
          more={error}
        />
        <DialogFooter>
          <Button type="button" variant="outline" loading={retrying} onClick={onRetry}>
            <RotateCcw aria-hidden data-icon="inline-start" />
            Retry git setup
          </Button>
          <Button type="button" onClick={onDone}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
