import { PendingActionApproval, TerminalPoolSlot, TerminalTabContent } from "@/features/terminal";
import { cn } from "@/lib/utils";

interface TerminalToolProps {
  readonly active: boolean;
  readonly workspaceId: string;
  readonly threadId: string | null;
  /** The thread id, or the workspace id for the threadless shell. */
  readonly scopeId: string | null;
}

/**
 * The Terminal tool: one row-1 tab per terminal record (shells and Project
 * Action runs) with a round + capped at the server's per-scope limit, and row-2
 * controls for the active record. The body stays mounted so the pooled xterm
 * keeps its slot for every record, action runs included. See ADR-0026.
 */
export function TerminalTool({ active, workspaceId, threadId, scopeId }: TerminalToolProps) {
  return (
    <div
      className={cn(
        "absolute inset-0 z-(--layer-base) flex min-h-0 flex-row overflow-hidden",
        !active && "pointer-events-none opacity-0",
      )}
      inert={!active ? true : undefined}
    >
      {active && scopeId ? (
        <TerminalTabContent key={scopeId} workspaceId={workspaceId} threadId={threadId} scopeId={scopeId} />
      ) : null}
      <TerminalPoolSlot className="relative min-h-0 min-w-0 flex-1 overflow-hidden" />
      {active && scopeId ? <PendingActionApproval workspaceId={workspaceId} threadId={threadId} scopeId={scopeId} /> : null}
    </div>
  );
}
