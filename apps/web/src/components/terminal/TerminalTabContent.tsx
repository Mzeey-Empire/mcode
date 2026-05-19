import { useCallback, useEffect, useState } from "react";
import { TerminalSquare } from "lucide-react";
import { useTerminalStore, TERMINAL_PANEL_DEFAULTS, type TerminalInstance } from "@/stores/terminalStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { getTransport } from "@/transport";
import { Button } from "@/components/ui/button";
import { TerminalToolbar } from "./TerminalToolbar";
import { TerminalList } from "./TerminalList";
import { TerminalView } from "./TerminalView";
import { TerminalKillConfirmDialog } from "./TerminalKillConfirmDialog";

const EMPTY_TERMINALS: readonly TerminalInstance[] = [];

const {
  addTerminal: storeAddTerminal,
  removeTerminal: storeRemoveTerminal,
  removeAllTerminals,
  showTerminalPanel,
  hideTerminalPanel,
} = useTerminalStore.getState();

/** Flattened entry for the persistent terminal pool. */
interface PoolEntry {
  readonly term: TerminalInstance;
  readonly ownerThreadId: string;
}

/**
 * Selector that flattens `terminals` into a stable array of pool entries.
 * Returns the same reference when the underlying `terminals` map has not
 * changed, avoiding unnecessary re-renders of the pool container.
 */
let _prevTerminals: Record<string, readonly TerminalInstance[]> | null = null;
let _cachedPool: readonly PoolEntry[] = [];
function selectPool(s: { terminals: Record<string, readonly TerminalInstance[]> }): readonly PoolEntry[] {
  if (s.terminals === _prevTerminals) return _cachedPool;
  _prevTerminals = s.terminals;
  const entries: PoolEntry[] = [];
  for (const [tid, instances] of Object.entries(s.terminals)) {
    for (const term of instances) {
      entries.push({ term, ownerThreadId: tid });
    }
  }
  _cachedPool = entries;
  return entries;
}

/** Props for {@link TerminalTabContent}. */
interface TerminalTabContentProps {
  /** The thread whose terminals to display. */
  readonly threadId: string;
  /** Whether the terminal tab is the active (visible) tab in the right panel. */
  readonly visible: boolean;
}

/**
 * Terminal content rendered inside the right panel's "terminal" tab.
 *
 * All xterm instances from every thread are rendered here in a single
 * persistent pool so they never remount on thread switches. Only the
 * active thread's active terminal is visible; the rest are hidden via
 * CSS `display:none`. This preserves scrollback, cursor position, and
 * WebGL state across thread switches with zero flicker.
 */
export function TerminalTabContent({ threadId, visible }: TerminalTabContentProps) {
  const panelState = useTerminalStore((s) =>
    s.terminalPanelByThread[threadId] ?? TERMINAL_PANEL_DEFAULTS,
  );
  const { activeTerminalId } = panelState;

  const terminals = useTerminalStore(
    (s) => (s.terminals[threadId] ?? EMPTY_TERMINALS),
  );

  // Persistent pool: flatten ALL terminals from ALL threads so xterm
  // instances are mounted once and never destroyed on thread switch.
  // Uses a module-scoped memoized selector to avoid re-creating the
  // array on every unrelated store update (e.g. panel height changes).
  const pool = useTerminalStore(selectPool);

  const splitMode = useTerminalStore((s) => s.splitMode);
  const confirmOnKill = useSettingsStore((s) => s.settings.terminal.confirmOnKill);

  const [pendingKill, setPendingKill] = useState<(() => void) | null>(null);

  // Dismiss pending kill on thread change.
  useEffect(() => {
    setPendingKill(null);
  }, [threadId]);

  // Sync PTY pause/resume with right panel visibility. When the terminal
  // tab becomes visible, resume all PTYs for this thread. When it becomes
  // hidden (tab switch or panel close), pause them.
  useEffect(() => {
    if (visible) {
      showTerminalPanel(threadId);
    } else {
      hideTerminalPanel(threadId);
    }
  }, [visible, threadId]);

  /** Creates a new terminal for the thread. */
  const createTerminal = useCallback(async () => {
    const transport = getTransport();
    const ptyId = await transport.terminalCreate(threadId);
    storeAddTerminal(threadId, ptyId);
  }, [threadId]);

  /** Immediate kill without guard. */
  const doCloseTerminal = useCallback((ptyId: string) => {
    getTransport().terminalKill(ptyId).catch(() => {});
    storeRemoveTerminal(ptyId);
    const remaining = useTerminalStore.getState().terminals[threadId];
    if (!remaining || remaining.length === 0) {
      hideTerminalPanel(threadId);
    }
  }, [threadId]);

  /** Kill with optional confirmation. */
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
          setPendingKill(() => () => doCloseTerminal(ptyId));
        })
        .catch(() => {
          doCloseTerminal(ptyId);
        });
    },
    [confirmOnKill, doCloseTerminal],
  );

  /** Immediate kill-all without guard. */
  const doCloseAllTerminals = useCallback(() => {
    getTransport()
      .terminalKillByThread(threadId)
      .catch((err) => {
        console.error("Failed to kill terminals for thread", threadId, err);
      });
    removeAllTerminals(threadId);
    hideTerminalPanel(threadId);
  }, [threadId]);

  /** Kill-all with optional confirmation. */
  const closeAllTerminals = useCallback(() => {
    if (confirmOnKill === "never" || terminals.length === 0) {
      doCloseAllTerminals();
      return;
    }
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
  }, [confirmOnKill, terminals, activeTerminalId, doCloseAllTerminals]);

  const confirmKill = useCallback(() => {
    pendingKill?.();
    setPendingKill(null);
  }, [pendingKill]);

  const cancelKill = useCallback(() => {
    setPendingKill(null);
  }, []);

  return (
    <>
      <TerminalKillConfirmDialog
        open={pendingKill !== null}
        onConfirm={confirmKill}
        onCancel={cancelKill}
      />

      {terminals.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground">
          <TerminalSquare className="h-10 w-10 opacity-40" />
          <p className="text-sm">No terminals</p>
          <Button variant="outline" size="sm" onClick={createTerminal}>
            New terminal
          </Button>
        </div>
      ) : (
        <>
          {/* Toolbar row */}
          <div className="flex justify-end px-2 py-1 border-b border-border/40">
            <TerminalToolbar
              onAdd={createTerminal}
              onDeleteAll={closeAllTerminals}
            />
          </div>

          {/* Terminal list (left) + terminal views (right) */}
          <div className="relative flex flex-1 overflow-hidden">
            {splitMode && (
              <TerminalList threadId={threadId} onClose={closeTerminal} />
            )}

            {/* Persistent terminal pool: ALL terminals from ALL threads
                are rendered here so xterm instances never remount. Only
                the active thread's active terminal is display:block. */}
            <div className="flex flex-1 flex-col overflow-hidden p-2">
              {pool.map(({ term, ownerThreadId }) => {
                const isActiveThread = ownerThreadId === threadId;
                return (
                  <TerminalView
                    key={term.id}
                    ptyId={term.id}
                    visible={isActiveThread && term.id === activeTerminalId}
                    threadActive={isActiveThread}
                  />
                );
              })}
            </div>
          </div>
        </>
      )}
    </>
  );
}
