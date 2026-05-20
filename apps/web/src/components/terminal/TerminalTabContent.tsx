import { useCallback, useEffect, useState } from "react";
import { TerminalSquare } from "lucide-react";
import { useTerminalStore, TERMINAL_PANEL_DEFAULTS, type TerminalInstance } from "@/stores/terminalStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { getTransport } from "@/transport";
import { Button } from "@/components/ui/button";
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
  const hasTerminals = terminals.length > 0;

  // Persistent pool: flatten ALL terminals from ALL threads so xterm
  // instances are mounted once and never destroyed on thread switch.
  // Uses a module-scoped memoized selector to avoid re-creating the
  // array on every unrelated store update (e.g. panel height changes).
  const pool = useTerminalStore(selectPool);

  const confirmOnKill = useSettingsStore((s) => s.settings.terminal.confirmOnKill);

  const [pendingKill, setPendingKill] = useState<(() => void) | null>(null);

  // Dismiss pending kill on thread change.
  useEffect(() => {
    setPendingKill(null);
  }, [threadId]);

  // Sync PTY pause/resume with right-panel terminal tab visibility.
  // Only the active workspace thread may stream; all others stay paused.
  useEffect(() => {
    const { terminals } = useTerminalStore.getState();
    const threadIds = Object.keys(terminals);

    if (visible) {
      for (const tid of threadIds) {
        if (tid === threadId) showTerminalPanel(tid);
        else hideTerminalPanel(tid);
      }
    } else {
      for (const tid of threadIds) {
        hideTerminalPanel(tid);
      }
    }

    return () => {
      hideTerminalPanel(threadId);
    };
  }, [visible, threadId]);

  /** Creates a new terminal for the thread. */
  const createTerminal = useCallback(async () => {
    const transport = getTransport();
    const { ptyId, shell } = await transport.terminalCreate(threadId);
    storeAddTerminal(threadId, ptyId, shell);
  }, [threadId]);

  /** Immediate kill without guard. Waits for server RPC before evicting local state. */
  const doCloseTerminal = useCallback(async (ptyId: string) => {
    try {
      await getTransport().terminalKill(ptyId);
      storeRemoveTerminal(ptyId);
      const remaining = useTerminalStore.getState().terminals[threadId];
      if (!remaining || remaining.length === 0) {
        hideTerminalPanel(threadId);
      }
    } catch (err) {
      console.error("[terminal] Failed to kill terminal", ptyId, err);
    }
  }, [threadId]);

  /** Kill with optional confirmation. */
  const closeTerminal = useCallback(
    (ptyId: string) => {
      if (confirmOnKill === "never") {
        void doCloseTerminal(ptyId);
        return;
      }
      getTransport()
        .terminalHasChildren(ptyId)
        .then(({ hasChildren }) => {
          if (!hasChildren) {
            void doCloseTerminal(ptyId);
            return;
          }
          setPendingKill(() => () => {
            void doCloseTerminal(ptyId);
          });
        })
        .catch(() => {
          void doCloseTerminal(ptyId);
        });
    },
    [confirmOnKill, doCloseTerminal],
  );

  /** Immediate kill-all without guard. Waits for server RPC before evicting local state. */
  const doCloseAllTerminals = useCallback(async () => {
    try {
      await getTransport().terminalKillByThread(threadId);
      removeAllTerminals(threadId);
      hideTerminalPanel(threadId);
    } catch (err) {
      console.error("[terminal] Failed to kill terminals for thread", threadId, err);
    }
  }, [threadId]);

  /** Kill-all with optional confirmation. */
  const closeAllTerminals = useCallback(() => {
    if (confirmOnKill === "never" || terminals.length === 0) {
      void doCloseAllTerminals();
      return;
    }
    const transport = getTransport();
    void Promise.all(
      terminals.map((term) =>
        transport
          .terminalHasChildren(term.id)
          .then(({ hasChildren }) => hasChildren)
          .catch(() => true),
      ),
    ).then((results) => {
      if (!results.some(Boolean)) {
        void doCloseAllTerminals();
        return;
      }
      setPendingKill(() => () => {
        void doCloseAllTerminals();
      });
    });
  }, [confirmOnKill, terminals, doCloseAllTerminals]);

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

      <div className="relative flex flex-1 overflow-hidden">
        {hasTerminals && (
          <TerminalList
            threadId={threadId}
            onClose={closeTerminal}
            onAdd={createTerminal}
            onDeleteAll={closeAllTerminals}
          />
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
                visible={visible && isActiveThread && term.id === activeTerminalId}
                threadActive={isActiveThread}
              />
            );
          })}
        </div>

        {!hasTerminals && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-background text-muted-foreground">
            <TerminalSquare className="h-10 w-10 opacity-40" />
            <p className="text-sm">No terminals</p>
            <Button variant="outline" size="sm" onClick={createTerminal}>
              New terminal
            </Button>
          </div>
        )}
      </div>
    </>
  );
}
