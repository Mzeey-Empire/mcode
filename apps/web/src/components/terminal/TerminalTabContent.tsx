import { useCallback, useEffect, useRef, useState } from "react";
import { useToastStore } from "@/stores/toastStore";
import { TerminalSquare } from "lucide-react";
import { useTerminalStore, type TerminalInstance } from "@/stores/terminalStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { getTransport } from "@/transport";
import { Button } from "@/components/ui/button";
import { TerminalList } from "./TerminalList";
import { TerminalKillConfirmDialog } from "./TerminalKillConfirmDialog";
import { TerminalPoolSlot } from "./TerminalPoolSlotContext";

const EMPTY_TERMINALS: readonly TerminalInstance[] = [];

const {
  addTerminal: storeAddTerminal,
  removeTerminal: storeRemoveTerminal,
  removeAllTerminals,
} = useTerminalStore.getState();

/** Props for {@link TerminalTabContent}. */
interface TerminalTabContentProps {
  /** The thread whose terminals to display. */
  readonly threadId: string;
}

/**
 * Terminal chrome in the right panel (list, empty state, kill dialog).
 * xterm instances are rendered by {@link TerminalPoolHost} into {@link TerminalPoolSlot}.
 */
export function TerminalTabContent({ threadId }: TerminalTabContentProps) {
  const terminals = useTerminalStore(
    (s) => (s.terminals[threadId] ?? EMPTY_TERMINALS),
  );
  const hasTerminals = terminals.length > 0;

  const confirmOnKill = useSettingsStore((s) => s.settings.terminal.confirmOnKill);

  const [pendingKill, setPendingKill] = useState<(() => void) | null>(null);
  /** Bumped on thread change so stale async kill confirmations are ignored. */
  const opGenRef = useRef(0);

  useEffect(() => {
    opGenRef.current += 1;
    setPendingKill(null);
  }, [threadId]);

  /** Creates a new terminal for the thread. */
  const createTerminal = useCallback(async () => {
    try {
      const transport = getTransport();
      const { ptyId, shell } = await transport.terminalCreate(threadId);
      storeAddTerminal(threadId, ptyId, shell);
    } catch (err) {
      console.error("[terminal] Failed to create terminal", err);
      const message =
        err instanceof Error ? err.message : "Could not create terminal";
      useToastStore.getState().show("error", "Failed to create terminal", message);
    }
  }, [threadId]);

  /** Immediate kill without guard. Waits for server RPC before evicting local state. */
  const doCloseTerminal = useCallback(async (ptyId: string) => {
    try {
      await getTransport().terminalKill(ptyId);
      storeRemoveTerminal(ptyId);
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
      const opGen = opGenRef.current;
      getTransport()
        .terminalHasChildren(ptyId)
        .then(({ hasChildren }) => {
          if (opGen !== opGenRef.current) return;
          if (!hasChildren) {
            void doCloseTerminal(ptyId);
            return;
          }
          setPendingKill(() => () => {
            void doCloseTerminal(ptyId);
          });
        })
        .catch(() => {
          if (opGen !== opGenRef.current) return;
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
    const opGen = opGenRef.current;
    void Promise.all(
      terminals.map((term) =>
        transport
          .terminalHasChildren(term.id)
          .then(({ hasChildren }) => hasChildren)
          .catch(() => true),
      ),
    ).then((results) => {
      if (opGen !== opGenRef.current) return;
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

        <TerminalPoolSlot className="relative min-h-0 flex-1 overflow-hidden p-2" />

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
