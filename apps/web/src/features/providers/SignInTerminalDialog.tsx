import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { TerminalPoolSlot, useHomeTerminalPresented } from "@/features/terminal";
import { closeSignInTerminal } from "./sign-in";

/**
 * Modal that shows the home-scope terminal running a provider sign-in command.
 * It is open exactly while the home scope holds a terminal, and closing it
 * kills that terminal and re-checks provider status.
 */
export function SignInTerminalDialog() {
  const open = useHomeTerminalPresented();
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) void closeSignInTerminal();
      }}
    >
      <DialogContent className="sm:max-w-[720px]">
        <DialogHeader>
          <DialogTitle>Sign in</DialogTitle>
        </DialogHeader>
        <TerminalPoolSlot surface="dialog" className="relative h-[420px] min-w-0 overflow-hidden" />
      </DialogContent>
    </Dialog>
  );
}
