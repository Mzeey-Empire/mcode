import { HOME_TERMINAL_SCOPE_ID, TERMINAL_MAX_PER_SCOPE } from "@mcode/contracts/models/terminal";
import { useDiffStore } from "@/stores/diffStore";
import { useToastStore } from "@/stores/toastStore";
import { useTerminalStore } from "@/features/terminal";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { getTransport } from "@/transport";

/**
 * Scopes with an in-flight terminal creation. Shared module-level guard so
 * concurrent triggers (tab click, the mod+j keybinding, React strict-mode
 * double-invoked effects) spawn at most one terminal per scope.
 */
const creationInFlight = new Map<string, symbol>();

/**
 * Resolve the workspace that owns a terminal scope. The scope is a thread id
 * when a thread is active, or a workspace id for the threadless new-thread
 * shell, so look the scope up as a thread first and fall back to a workspace.
 */
function resolveScopeWorkspace(scopeId: string): {
  workspaceId: string | undefined;
  isThread: boolean;
} {
  const ws = useWorkspaceStore.getState();
  const thread = ws.threads.find((t) => t.id === scopeId);
  if (thread) return { workspaceId: thread.workspace_id, isThread: true };
  if (ws.workspaces.some((w) => w.id === scopeId)) {
    return { workspaceId: scopeId, isThread: false };
  }
  return { workspaceId: undefined, isThread: false };
}

/**
 * The open panel a new terminal tab can join. The panel record is per-thread
 * (or the workspace fallback for the threadless shell), so the thread id is
 * passed only when the scope is a thread. Null when the panel is hidden.
 */
function visiblePanelFor(scopeId: string): { workspaceId: string; panelThreadId: string | undefined } | null {
  const { workspaceId, isThread } = resolveScopeWorkspace(scopeId);
  if (!workspaceId) return null;
  const panelThreadId = isThread ? scopeId : undefined;
  const diff = useDiffStore.getState();
  if (!diff.getRightPanel(workspaceId, panelThreadId) || !diff.getRightPanelVisible(workspaceId, panelThreadId)) {
    return null;
  }
  return { workspaceId, panelThreadId };
}

type AttachTarget = { readonly workspaceId: string; readonly panelThreadId: string | undefined } | "home";

function attachTargetFor(scopeId: string): AttachTarget | null {
  if (scopeId === HOME_TERMINAL_SCOPE_ID) return "home";
  return visiblePanelFor(scopeId);
}

/**
 * Creates one terminal and makes it the active tab of its scope. Project scopes
 * also focus the right-panel Terminal tool; the home scope shows in the sign-in
 * dialog instead. Creation is serialized per scope so concurrent UI and shortcut
 * requests cannot exceed the session cap.
 *
 * @param scopeId - A thread id, a workspace id for the threadless shell, or the home scope id.
 * @param onAttached - Runs with the new PTY id once its tab is attached.
 */
export function createTerminalForScope(scopeId: string, onAttached?: (ptyId: string) => void): void {
  if (creationInFlight.has(scopeId)) return;
  const existing = useTerminalStore.getState().terminals[scopeId];
  if ((existing?.length ?? 0) >= TERMINAL_MAX_PER_SCOPE) return;

  const attempt = Symbol();
  creationInFlight.set(scopeId, attempt);
  const release = () => {
    if (creationInFlight.get(scopeId) === attempt) creationInFlight.delete(scopeId);
  };
  try {
    const transport = getTransport();
    transport
      .terminalCreate(scopeId)
      .then(({ ptyId, shell, ...metadata }) => {
        release();
        try {
          const target = attachTargetFor(scopeId);
          if (!target) {
            transport.terminalKill(ptyId).catch(() => {});
            return;
          }
          const current = useTerminalStore.getState().terminals[scopeId];
          if (current && current.length >= TERMINAL_MAX_PER_SCOPE && !current.some((terminal) => terminal.id === ptyId)) {
            transport.terminalKill(ptyId).catch(() => {});
            return;
          }
          useTerminalStore.getState().addTerminal(scopeId, ptyId, shell, metadata);
          // Hydration may have added this record first, which makes addTerminal a
          // no-op; the new terminal still has to become the tool's active tab.
          useTerminalStore.getState().setActiveTerminal(scopeId, ptyId);
          if (target !== "home") {
            useDiffStore.getState().setRightPanelTab(target.workspaceId, target.panelThreadId, "terminal");
          }
        } catch (error) {
          // The server already spawned the PTY; a failed local attach must not
          // leak it on the host.
          transport.terminalKill(ptyId).catch(() => {});
          throw error;
        }
        onAttached?.(ptyId);
      })
      .catch((error) => {
        release();
        showCreateFailure(error);
      });
  } catch (error) {
    release();
    showCreateFailure(error);
  }
}

function showCreateFailure(error: unknown): void {
  const message =
    error instanceof Error ? error.message : "Could not create terminal";
  useToastStore.getState().show({
    kind: "failed",
    title: "Failed to create terminal",
    meta: message,
  });
}

/** Ensures the Terminal tool has its first PTY-backed record. */
export function ensureTerminalForScope(scopeId: string): void {
  if ((useTerminalStore.getState().terminals[scopeId]?.length ?? 0) === 0) {
    createTerminalForScope(scopeId);
  }
}
