import { useCallback, useRef, useState } from "react";
import { TerminalSquare } from "lucide-react";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useTerminalStore, TERMINAL_PANEL_DEFAULTS, type TerminalInstance } from "@/stores/terminalStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { getTransport } from "@/transport";
import { Button } from "@/components/ui/button";
import { TerminalToolbar } from "./TerminalToolbar";
import { TerminalList } from "./TerminalList";
import { TerminalView } from "./TerminalView";
import { TerminalKillConfirmDialog } from "./TerminalKillConfirmDialog";

const MIN_HEIGHT = 150;
const MAX_HEIGHT_RATIO = 0.7;
const EMPTY_TERMINALS: readonly TerminalInstance[] = [];

// Zustand action refs are stable (same identity for the store's lifetime).
// Destructuring at module scope avoids calling getState() on every render.
const {
  addTerminal: storeAddTerminal,
  removeTerminal: storeRemoveTerminal,
  removeAllTerminals,
  hideTerminalPanel,
  setTerminalPanelHeight,
} = useTerminalStore.getState();

/** Terminal panel that renders per-thread terminal instances with drag-to-resize. */
export function TerminalPanel() {
  const activeThreadId = useWorkspaceStore((s) => s.activeThreadId);

  // Reactive subscriptions
  const panelState = useTerminalStore((s) =>
    activeThreadId
      ? (s.terminalPanelByThread[activeThreadId] ?? TERMINAL_PANEL_DEFAULTS)
      : TERMINAL_PANEL_DEFAULTS,
  );
  const { visible: panelVisible, height: panelHeight, activeTerminalId } = panelState;

  const terminals = useTerminalStore(
    (s) => (activeThreadId ? s.terminals[activeThreadId] : undefined) ?? EMPTY_TERMINALS,
  );
  const splitMode = useTerminalStore((s) => s.splitMode);
  const confirmOnKill = useSettingsStore((s) => s.settings.terminal.confirmOnKill);

  const draggingRef = useRef(false);

  // Pending kill state for the confirmation dialog.
  // `pendingKill` holds the action to run if the user confirms.
  const [pendingKill, setPendingKill] = useState<(() => void) | null>(null);

  /** Handles drag-to-resize from the top edge of the panel. */
  const onDragStart = useCallback(
    (e: React.MouseEvent) => {
      if (!activeThreadId) return;
      e.preventDefault();
      draggingRef.current = true;
      const startY = e.clientY;
      const startHeight = panelHeight;

      const onMouseMove = (moveEvent: MouseEvent) => {
        if (!draggingRef.current) return;
        const delta = startY - moveEvent.clientY;
        const maxHeight = window.innerHeight * MAX_HEIGHT_RATIO;
        const newHeight = Math.max(
          MIN_HEIGHT,
          Math.min(maxHeight, startHeight + delta),
        );
        setTerminalPanelHeight(activeThreadId, newHeight);
      };

      const onMouseUp = () => {
        draggingRef.current = false;
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    },
    [panelHeight, activeThreadId],
  );

  /** Creates a new terminal for the active thread. */
  const createTerminal = useCallback(async () => {
    if (!activeThreadId) return;
    const transport = getTransport();
    const ptyId = await transport.terminalCreate(activeThreadId);
    storeAddTerminal(activeThreadId, ptyId);
  }, [activeThreadId]);

  /** Performs the immediate kill of a single terminal without any guard. */
  const doCloseTerminal = useCallback((ptyId: string) => {
    getTransport().terminalKill(ptyId).catch(() => {});
    storeRemoveTerminal(ptyId);
    // Collapse the panel when the last terminal is removed.
    if (activeThreadId) {
      const remaining = useTerminalStore.getState().terminals[activeThreadId];
      if (!remaining || remaining.length === 0) {
        hideTerminalPanel(activeThreadId);
      }
    }
  }, [activeThreadId]);

  /** Kills and removes a single terminal, prompting first when confirmOnKill requires it. */
  const closeTerminal = useCallback(
    (ptyId: string) => {
      if (confirmOnKill === "never") {
        doCloseTerminal(ptyId);
        return;
      }
      getTransport()
        .terminalHasChildren(ptyId)
        .then(({ hasChildren }) => {
          if (!hasChildren) {
            doCloseTerminal(ptyId);
            return;
          }
          // Store the action in state — React requires functional updater to
          // store a function value without it being called immediately.
          setPendingKill(() => () => doCloseTerminal(ptyId));
        })
        .catch(() => {
          // If the check fails, proceed without confirmation.
          doCloseTerminal(ptyId);
        });
    },
    [confirmOnKill, doCloseTerminal],
  );

  /** Performs the immediate kill of all terminals for the active thread without any guard. */
  const doCloseAllTerminals = useCallback(() => {
    if (!activeThreadId) return;
    getTransport()
      .terminalKillByThread(activeThreadId)
      .catch((err) => {
        console.error(
          "Failed to kill terminals for thread",
          activeThreadId,
          err,
        );
      });
    removeAllTerminals(activeThreadId);
    hideTerminalPanel(activeThreadId);
  }, [activeThreadId]);

  /**
   * Kills and removes all terminals for the active thread, then collapses the
   * panel. Leaving the empty panel open after hitting the bin was confusing —
   * users had to toggle it shut manually (issue #303).
   * When confirmOnKill is enabled, checks if any terminal has children first.
   */
  const closeAllTerminals = useCallback(() => {
    if (!activeThreadId) return;
    if (confirmOnKill === "never" || terminals.length === 0) {
      doCloseAllTerminals();
      return;
    }
    // Check the active terminal (if any) for child processes as a proxy for
    // the whole panel — checking every PTY in parallel would be excessive.
    const targetId = activeTerminalId ?? terminals[0]?.id;
    if (!targetId) {
      doCloseAllTerminals();
      return;
    }
    getTransport()
      .terminalHasChildren(targetId)
      .then(({ hasChildren }) => {
        if (!hasChildren) {
          doCloseAllTerminals();
          return;
        }
        setPendingKill(() => doCloseAllTerminals);
      })
      .catch(() => {
        doCloseAllTerminals();
      });
  }, [activeThreadId, confirmOnKill, terminals, activeTerminalId, doCloseAllTerminals]);

  if (!panelVisible || !activeThreadId) {
    return null;
  }

  return (
    <>
    <TerminalKillConfirmDialog
      open={pendingKill !== null}
      onConfirm={() => {
        pendingKill?.();
        setPendingKill(null);
      }}
      onCancel={() => setPendingKill(null)}
    />
    <div
      style={{ height: panelHeight }}
      className="flex flex-col rounded-lg bg-background shadow-sm overflow-hidden"
    >
      {/* Drag handle */}
      <div
        className="h-1 cursor-row-resize bg-transparent hover:bg-muted-foreground/20"
        onMouseDown={onDragStart}
      />

      {/* Toolbar row */}
      <div className="flex justify-end px-2 py-1">
        <TerminalToolbar
          onAdd={createTerminal}
          onDeleteAll={closeAllTerminals}
        />
      </div>

      {/* Terminal views + optional split list */}
      {terminals.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground">
          <TerminalSquare className="h-10 w-10 opacity-40" />
          <p className="text-sm">No terminals</p>
          <Button variant="outline" size="sm" onClick={createTerminal}>
            New terminal
          </Button>
        </div>
      ) : (
        <div className="relative flex flex-1 overflow-hidden">
          <div className="flex-1 overflow-hidden">
            {terminals.map((term) => (
              <TerminalView
                key={term.id}
                ptyId={term.id}
                visible={term.id === activeTerminalId}
              />
            ))}
          </div>

          {splitMode && (
            <TerminalList threadId={activeThreadId} onClose={closeTerminal} />
          )}
        </div>
      )}
    </div>
    </>
  );
}
