import { memo } from "react";
import { TerminalSquare, X } from "lucide-react";
import { useTerminalStore, type TerminalInstance } from "@/stores/terminalStore";

const EMPTY_TERMINALS: readonly TerminalInstance[] = [];

/** Props for TerminalList: the owning thread and a handler to close a single terminal. */
interface TerminalListProps {
  readonly threadId: string;
  readonly onClose: (ptyId: string) => void;
}

// Stable action ref — avoids a reactive subscription for a function that never changes.
const { setActiveTerminal } = useTerminalStore.getState();

export const TerminalList = memo(function TerminalList({ threadId, onClose }: TerminalListProps) {
  const terminals = useTerminalStore(
    (s) => s.terminals[threadId] ?? EMPTY_TERMINALS,
  );
  const activeTerminalId = useTerminalStore(
    (s) => s.terminalPanelByThread[threadId]?.activeTerminalId ?? null,
  );

  return (
    <div className="w-48 border-r border-border bg-background">
      {terminals.map((terminal) => {
        const isActive = terminal.id === activeTerminalId;

        return (
          <div
            key={terminal.id}
            className="group flex cursor-pointer items-center justify-between px-3 py-1.5 hover:bg-muted"
            onClick={() => setActiveTerminal(threadId, terminal.id)}
          >
            <div className="flex items-center gap-2">
              <TerminalSquare className="size-3.5 text-muted-foreground" />
              <span
                className={`text-xs ${
                  isActive
                    ? "font-bold text-foreground"
                    : "text-muted-foreground"
                }`}
              >
                {terminal.label}
              </span>
            </div>
            <button
              type="button"
              className="invisible text-muted-foreground hover:text-foreground group-hover:visible"
              onClick={(e) => {
                e.stopPropagation();
                onClose(terminal.id);
              }}
              aria-label={`Close ${terminal.label}`}
            >
              <X className="size-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
});
