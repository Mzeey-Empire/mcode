import { memo } from "react";
import { Terminal, X, Plus, Trash2, ChevronsLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { useTerminalStore, type TerminalInstance } from "@/stores/terminalStore";
import { cn } from "@/lib/utils";

const EMPTY_TERMINALS: readonly TerminalInstance[] = [];

/** Props for the terminal sidebar. */
interface TerminalListProps {
  readonly threadId: string;
  readonly onClose: (ptyId: string) => void;
  readonly onAdd: () => void;
  readonly onDeleteAll: () => void;
}

// Stable action refs.
const { setActiveTerminal, toggleSplit } = useTerminalStore.getState();

/** Terminal sidebar with shell list, header actions, and collapse toggle. */
export const TerminalList = memo(function TerminalList({
  threadId,
  onClose,
  onAdd,
  onDeleteAll,
}: TerminalListProps) {
  const collapsed = !useTerminalStore((s) => s.splitMode);
  const terminals = useTerminalStore(
    (s) => s.terminals[threadId] ?? EMPTY_TERMINALS,
  );
  const activeTerminalId = useTerminalStore(
    (s) => s.terminalPanelByThread[threadId]?.activeTerminalId ?? null,
  );

  if (collapsed) {
    return (
      <div className="flex w-[38px] flex-shrink-0 flex-col border-r border-border">
        <div className="flex h-[34px] items-center justify-center border-b border-border">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={toggleSplit}
                  className="text-muted-foreground"
                  aria-label="Expand sidebar"
                />
              }
            >
              <ChevronsLeft className="size-3.5 rotate-180" />
            </TooltipTrigger>
            <TooltipContent side="right" className="text-xs">
              Expand sidebar
            </TooltipContent>
          </Tooltip>
        </div>
        <div className="flex flex-1 flex-col items-center gap-0.5 overflow-y-auto py-1">
          {terminals.map((terminal) => {
            const isActive = terminal.id === activeTerminalId;
            return (
              <Tooltip key={terminal.id}>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => setActiveTerminal(threadId, terminal.id)}
                      className={`size-7 ${
                        isActive
                          ? "bg-muted text-foreground"
                          : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                      }`}
                      aria-label={terminal.label}
                    />
                  }
                >
                  <Terminal className="size-3.5" />
                </TooltipTrigger>
                <TooltipContent side="right" className="text-xs">
                  {terminal.label}
                </TooltipContent>
              </Tooltip>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="flex w-[148px] flex-shrink-0 flex-col border-r border-border">
      {/* Header: collapse toggle + actions, left-aligned */}
      <div className="flex h-[34px] items-center gap-0.5 border-b border-border px-1.5">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={toggleSplit}
                className="text-muted-foreground"
                aria-label="Collapse sidebar"
              />
            }
          >
            <ChevronsLeft className="size-3.5" />
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-xs">
            Collapse
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={onAdd}
                className="text-muted-foreground hover:text-foreground"
                aria-label="New terminal"
              />
            }
          >
            <Plus className="size-3.5" />
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-xs">
            New terminal
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={onDeleteAll}
                className="text-muted-foreground hover:text-foreground"
                aria-label="Kill all terminals"
              />
            }
          >
            <Trash2 className="size-3.5" />
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-xs">
            Kill all
          </TooltipContent>
        </Tooltip>
      </div>

      {/* Shell list */}
      <div className="flex-1 overflow-y-auto py-1">
        {terminals.map((terminal) => {
          const isActive = terminal.id === activeTerminalId;
          return (
            <div key={terminal.id} className="group flex items-center pr-1">
              <Button
                type="button"
                variant="ghost"
                className={cn(
                  "h-auto min-w-0 flex-1 justify-start gap-2 rounded-none px-2.5 py-1.5 font-normal",
                  isActive
                    ? "bg-muted/50 text-foreground"
                    : "text-muted-foreground hover:bg-muted/30 hover:text-foreground",
                )}
                onClick={() => setActiveTerminal(threadId, terminal.id)}
                aria-current={isActive ? "true" : undefined}
              >
                <Terminal
                  className={cn(
                    "size-3.5 shrink-0",
                    isActive ? "opacity-70" : "opacity-40",
                  )}
                />
                <span
                  className={cn(
                    "truncate text-xs",
                    isActive && "font-semibold",
                  )}
                >
                  {terminal.label}
                </span>
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="size-4 shrink-0 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-60"
                onClick={() => onClose(terminal.id)}
                aria-label={`Close ${terminal.label}`}
              >
                <X className="size-2.5" />
              </Button>
            </div>
          );
        })}
      </div>
    </div>
  );
});
