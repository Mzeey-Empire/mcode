import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

/** Props for {@link TerminalKillConfirmDialog}. */
export interface TerminalKillConfirmDialogProps {
  /** Whether the dialog is open. */
  open: boolean;
  /** Called when the user confirms the kill. */
  onConfirm: () => void;
  /** Called when the user cancels or the dialog is dismissed. */
  onCancel: () => void;
}

/**
 * Confirmation dialog shown when `terminal.confirmOnKill` is enabled and
 * the target PTY has live child processes. Presents "Kill anyway" and
 * "Cancel" actions.
 */
export function TerminalKillConfirmDialog({
  open,
  onConfirm,
  onCancel,
}: TerminalKillConfirmDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) onCancel(); }}>
      <DialogContent className="max-w-sm">
        <div className="space-y-3">
          <DialogTitle className="text-sm font-medium">
            Kill terminal?
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            This terminal has running processes. Closing it will forcibly terminate them.
          </DialogDescription>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" size="sm" onClick={onCancel}>
              Cancel
            </Button>
            <Button variant="destructive" size="sm" onClick={onConfirm}>
              Kill anyway
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
