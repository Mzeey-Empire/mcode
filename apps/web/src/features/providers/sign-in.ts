import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { onPtyExit } from "@/features/terminal/adapters/pty-data-registry";
import { createTerminalForScope } from "@/lib/ensure-terminal";
import { showRightPanelAdaptive } from "@/lib/right-panel-layout";
import { useDiffStore } from "@/stores/diffStore";
import { useProviderStatusStore } from "@/stores/providerStatusStore";
import { useUiStore } from "@/stores/uiStore";
import { getTransport } from "@/transport";

/**
 * Opens a fresh terminal in the right panel and types the provider's sign-in
 * command into it. Status re-checks when that terminal exits. Does nothing
 * without an active project, because terminals are scoped to one.
 */
export function signInToProvider(argv: readonly string[]): void {
  const { activeWorkspaceId: workspaceId, activeThreadId: threadId } = useWorkspaceStore.getState();
  if (!workspaceId) return;
  const ui = useUiStore.getState();
  if (ui.primarySurface !== "chat") ui.setPrimarySurface("chat");
  if (!useDiffStore.getState().getRightPanelVisible(workspaceId, threadId)) {
    showRightPanelAdaptive(workspaceId, threadId);
  }
  useDiffStore.getState().setRightPanelTab(workspaceId, threadId, "terminal");
  createTerminalForScope(threadId ?? workspaceId, (ptyId) => {
    const stopWatching = onPtyExit(ptyId, () => {
      stopWatching();
      void useProviderStatusStore.getState().fetch(true);
    });
    // argv comes from a fixed adapter constant (see ProviderSignIn), so joining it into shell input is safe.
    getTransport()
      .terminalWrite(ptyId, `${argv.join(" ")}\r`)
      .catch((err: unknown) => console.error("[signInToProvider] Failed to type the sign-in command", err));
  });
}
