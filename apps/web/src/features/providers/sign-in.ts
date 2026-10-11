import { HOME_TERMINAL_SCOPE_ID } from "@mcode/contracts";
import { useTerminalStore } from "@/features/terminal";
import { createTerminalForScope } from "@/lib/ensure-terminal";
import { useProviderStatusStore } from "@/stores/providerStatusStore";
import { useToastStore } from "@/stores/toastStore";
import { getTransport } from "@/transport";

function typeSignInCommand(ptyId: string, argv: readonly string[]): void {
  // argv comes from a fixed adapter constant (see ProviderSignIn), so joining it into shell input is safe.
  getTransport()
    .terminalWrite(ptyId, `${argv.join(" ")}\r`)
    .catch((err: unknown) => console.error("[signInToProvider] Failed to type the sign-in command", err));
}

function liveHomeTerminalId(): string | null {
  const live = useTerminalStore
    .getState()
    .terminals[HOME_TERMINAL_SCOPE_ID]?.find((terminal) => (terminal.state ?? "running") === "running");
  return live?.id ?? null;
}

/**
 * Opens the sign-in dialog on a home-directory terminal and types the
 * provider's sign-in command into it. Works with or without an open project.
 * A live home terminal is reused, and creation is serialized per scope, so a
 * repeated click never starts a second shell.
 */
export function signInToProvider(argv: readonly string[]): void {
  const existing = liveHomeTerminalId();
  if (existing) {
    useTerminalStore.getState().setActiveTerminal(HOME_TERMINAL_SCOPE_ID, existing);
    typeSignInCommand(existing, argv);
    return;
  }
  createTerminalForScope(HOME_TERMINAL_SCOPE_ID, (ptyId) => typeSignInCommand(ptyId, argv));
}

/**
 * Closes the sign-in dialog by killing every home-scope terminal, then
 * re-checks provider status so a row clears once sign-in succeeded. A record
 * whose kill fails stays, which keeps the dialog open with its shell.
 */
export async function closeSignInTerminal(): Promise<void> {
  const records = useTerminalStore.getState().terminals[HOME_TERMINAL_SCOPE_ID] ?? [];
  await Promise.all(records.map(({ id }) => killHomeTerminal(id)));
  await useProviderStatusStore.getState().fetch(true);
}

async function killHomeTerminal(ptyId: string): Promise<void> {
  try {
    await getTransport().terminalKill(ptyId);
    useTerminalStore.getState().removeTerminal(ptyId);
  } catch (error) {
    useToastStore.getState().show({
      kind: "failed",
      title: "Couldn't close terminal",
      meta: error instanceof Error ? error.message : String(error),
    });
  }
}
