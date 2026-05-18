import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

/** Props for the dialog shown when a nightly user switches back to stable while running a newer version. */
export interface ConfirmChannelDowngradeDialogProps {
  /** Currently running version (e.g. "0.12.0-nightly.20260518.42"). */
  currentVersion: string;
  /** Latest stable available (e.g. "0.11.1"). */
  latestStable: string;
  /** Called when the user cancels — keeps the running nightly. */
  onCancel: () => void;
  /** Called when the user confirms the downgrade. */
  onConfirm: () => void | Promise<void>;
}

/**
 * Confirms switching from Nightly back to Stable while a newer nightly build
 * is installed. Switching requires installing an older version, which
 * electron-updater refuses by default — the user must opt in.
 */
export function ConfirmChannelDowngradeDialog({
  currentVersion,
  latestStable,
  onCancel,
  onConfirm,
}: ConfirmChannelDowngradeDialogProps) {
  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Switch to stable?</DialogTitle>
          <DialogDescription>
            {latestStable === "the latest stable release"
              ? `You're on ${currentVersion} (nightly). Switching will reinstall the latest stable, which may be an older version. Your settings and data are preserved.`
              : `You're on ${currentVersion} (nightly). The latest stable is ${latestStable}. Switching will reinstall an older version. Your settings and data are preserved.`}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Stay on nightly
          </Button>
          <Button onClick={() => void onConfirm()}>Switch and downgrade</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
