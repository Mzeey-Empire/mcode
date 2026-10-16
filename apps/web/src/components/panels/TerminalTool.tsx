import { TerminalPoolSlot, TerminalTabContent, useScopeTerminals } from "@/features/terminal";
import { ProjectActionTerminalView } from "@/features/projects/environment";
import { cn } from "@/lib/utils";

function activeActionId(terminals: ReturnType<typeof useScopeTerminals>["terminals"], activeId: string | null): string | null {
  const record = terminals.find((terminal) => terminal.id === activeId);
  return record?.kind === "action" ? record.actionId ?? null : null;
}

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
 * controls for the active shell. The body stays mounted so the pooled xterm keeps
 * its slot; an action record overlays its transcript view instead. See ADR-0026.
 */
export function TerminalTool({ active, workspaceId, threadId, scopeId }: TerminalToolProps) {
  const { terminals, activeId } = useScopeTerminals(scopeId);
  const actionId = activeActionId(terminals, activeId);
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
      {active && threadId && actionId ? <ActionRecordOverlay threadId={threadId} actionId={actionId} /> : null}
    </div>
  );
}

/** Covers the pooled xterm with the Project Action's own transcript view. */
function ActionRecordOverlay({ threadId, actionId }: { readonly threadId: string; readonly actionId: string }) {
  return (
    <div className="absolute inset-0 flex min-h-0 flex-col bg-background">
      <ProjectActionTerminalView key={`${threadId}:${actionId}`} threadId={threadId} actionId={actionId} />
    </div>
  );
}
