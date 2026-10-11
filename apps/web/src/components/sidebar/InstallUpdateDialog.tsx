import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { runningAgentsSentence } from "@/features/updates/update-button-state";

/** Props for {@link InstallUpdateDialog}. */
interface InstallUpdateDialogProps {
  /** Full version being installed, nightly suffix included. */
  readonly version: string;
  /** Agents running when Install was clicked; null when the count could not be read. */
  readonly runningAgents: number | null;
  /** Installs now, stopping running agents. */
  readonly onRestartNow: () => void;
  /** Arms install for when the agents finish. */
  readonly onInstallWhenIdle: () => void;
  /** Closes without installing. */
  readonly onCancel: () => void;
}

/** Asks whether to restart now or wait, when Install is clicked with agents running (state 7). */
export function InstallUpdateDialog({ version, runningAgents, onRestartNow, onInstallWhenIdle, onCancel }: InstallUpdateDialogProps) {
  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent showCloseButton={false} className="w-96 gap-4 rounded-[14px] sm:max-w-96">
        <DialogTitle className="text-base leading-6 font-semibold">Install update</DialogTitle>
        <p className="font-mono text-body-small text-ink">{version}</p>
        <DialogDescription className="text-body-small text-muted">
          {runningAgents === null
            ? "Agents may be running. Installing restarts Mcode and stops them."
            : runningAgentsSentence(runningAgents)}
        </DialogDescription>
        <DialogFooter className="mx-0 mb-0 flex-row justify-end gap-2 rounded-none border-t bg-transparent p-0 pt-4">
          <Button variant="ghost" onClick={onRestartNow}>
            Restart now
          </Button>
          <Button onClick={onInstallWhenIdle}>When they finish</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
