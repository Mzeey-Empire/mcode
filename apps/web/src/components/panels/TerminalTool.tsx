import { useMemo } from "react";
import { Play, Terminal } from "lucide-react";
import { TERMINAL_MAX_PER_SCOPE, type WorkspaceEnvironmentActionRun } from "@mcode/contracts";
import { TERMINAL_PANEL_DEFAULTS, TerminalPoolSlot, useTerminalStore, type TerminalInstance } from "@/features/terminal";
import { resolveActiveTerminalId } from "@/features/terminal/surfaces/resolveActiveTerminalId";
import { ProjectActionTerminalView } from "@/features/projects/environment";
import { useProjectActionStore } from "@/features/projects/environment/state/project-action-store";
import { createTerminalForScope } from "@/lib/ensure-terminal";
import { useDiffStore } from "@/stores/diffStore";
import { useToastStore } from "@/stores/toastStore";
import { getTransport } from "@/transport";
import { cn } from "@/lib/utils";
import { PanelHeaderSlot } from "./shell/PanelHeader";
import { PanelTabStrip, type PanelTabStripItem } from "./shell/PanelTabStrip";

const EMPTY_SCOPE_TERMINALS: readonly TerminalInstance[] = [];
const EMPTY_ACTION_RUNS: Readonly<Record<string, WorkspaceEnvironmentActionRun>> = {};

/** Tooltip on the Terminal tool's disabled + once the scope holds the server's record cap. */
export const TERMINAL_CAP_REASON = `${TERMINAL_MAX_PER_SCOPE} terminals are open. Close one to open another.`;

/**
 * Row-1 tab labels for a scope's terminal records. Shells that share a label get
 * " (n)" ordinals so each tab stays distinguishable; action records take their
 * Project Action's name.
 */
function terminalTabLabels(
  terminals: readonly TerminalInstance[],
  actionRuns: Readonly<Record<string, WorkspaceEnvironmentActionRun>>,
): ReadonlyMap<string, string> {
  const shells = terminals.filter((terminal) => terminal.kind !== "action");
  const occurrences = new Map<string, number>();
  for (const shell of shells) occurrences.set(shell.label, (occurrences.get(shell.label) ?? 0) + 1);
  const seen = new Map<string, number>();
  const labels = new Map<string, string>();
  for (const terminal of terminals) {
    if (terminal.kind === "action") {
      labels.set(terminal.id, actionRuns[terminal.actionId ?? ""]?.actionName ?? "Project Action");
      continue;
    }
    const ordinal = (seen.get(terminal.label) ?? 0) + 1;
    seen.set(terminal.label, ordinal);
    labels.set(terminal.id, occurrences.get(terminal.label)! > 1 ? `${terminal.label} (${ordinal})` : terminal.label);
  }
  return labels;
}

/**
 * Kills one terminal record, then drops it locally. Closing the scope's last
 * record also closes the Terminal tool. On failure the tab stays: the process
 * may still be running, and the user needs to know closing it did not stop it.
 */
function closeTerminalRecord(workspaceId: string, threadId: string | null, scopeId: string, ptyId: string): void {
  getTransport().terminalKill(ptyId).then(
    () => {
      useTerminalStore.getState().removeTerminal(ptyId);
      if ((useTerminalStore.getState().terminals[scopeId]?.length ?? 0) > 0) return;
      useDiffStore.getState().closeRightPanelTab(workspaceId, threadId, "terminal");
    },
    (error: unknown) => {
      useToastStore.getState().show({
        kind: "failed",
        title: "Couldn't close terminal",
        meta: error instanceof Error ? error.message : String(error),
      });
    },
  );
}

function useScopeTerminals(scopeId: string | null): {
  readonly terminals: readonly TerminalInstance[];
  readonly activeId: string | null;
} {
  const terminals = useTerminalStore((state) =>
    scopeId ? state.terminals[scopeId] ?? EMPTY_SCOPE_TERMINALS : EMPTY_SCOPE_TERMINALS,
  );
  const storedActiveId = useTerminalStore((state) =>
    scopeId ? (state.terminalPanelByThread[scopeId] ?? TERMINAL_PANEL_DEFAULTS).activeTerminalId : null,
  );
  const activeId = useMemo(
    () => (scopeId ? resolveActiveTerminalId(scopeId, storedActiveId, { [scopeId]: terminals }) : null),
    [scopeId, storedActiveId, terminals],
  );
  return { terminals, activeId };
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
 * Action runs) with a round + capped at {@link TERMINAL_MAX_PER_SCOPE}. The body
 * stays mounted so the pooled xterm keeps its slot; an action record overlays
 * its transcript view instead. See ADR-0025.
 */
export function TerminalTool({ active, workspaceId, threadId, scopeId }: TerminalToolProps) {
  const { terminals, activeId } = useScopeTerminals(scopeId);
  const activeActionId = actionIdOf(terminals, activeId);
  return (
    <div
      className={cn(
        "absolute inset-0 z-(--layer-base) flex min-h-0 flex-row overflow-hidden",
        !active && "pointer-events-none opacity-0",
      )}
      inert={!active ? true : undefined}
    >
      {active && scopeId ? (
        <TerminalTabStrip
          workspaceId={workspaceId}
          threadId={threadId}
          scopeId={scopeId}
          terminals={terminals}
          activeId={activeId}
        />
      ) : null}
      <TerminalPoolSlot className="relative min-h-0 min-w-0 flex-1 overflow-hidden" />
      {active && threadId && activeActionId ? <ActionRecordOverlay threadId={threadId} actionId={activeActionId} /> : null}
    </div>
  );
}

function actionIdOf(terminals: readonly TerminalInstance[], ptyId: string | null): string | null {
  const record = terminals.find((terminal) => terminal.id === ptyId);
  return record?.kind === "action" ? record.actionId ?? null : null;
}

/** Covers the pooled xterm with the Project Action's own transcript view. */
function ActionRecordOverlay({ threadId, actionId }: { readonly threadId: string; readonly actionId: string }) {
  return (
    <div className="absolute inset-0 flex min-h-0 flex-col bg-background">
      <ProjectActionTerminalView key={`${threadId}:${actionId}`} threadId={threadId} actionId={actionId} />
    </div>
  );
}

function TerminalTabStrip({
  workspaceId,
  threadId,
  scopeId,
  terminals,
  activeId,
}: {
  readonly workspaceId: string;
  readonly threadId: string | null;
  readonly scopeId: string;
  readonly terminals: readonly TerminalInstance[];
  readonly activeId: string | null;
}) {
  const actionRuns = useProjectActionStore((state) =>
    threadId ? state.runsByThread[threadId] ?? EMPTY_ACTION_RUNS : EMPTY_ACTION_RUNS,
  );
  const items = useMemo<readonly PanelTabStripItem[]>(() => {
    const labels = terminalTabLabels(terminals, actionRuns);
    return terminals.map((terminal) => ({
      id: terminal.id,
      label: labels.get(terminal.id) ?? terminal.label,
      icon: terminal.kind === "action" ? <Play aria-hidden /> : <Terminal aria-hidden />,
    }));
  }, [actionRuns, terminals]);
  return (
    <PanelHeaderSlot slot="leading">
      <PanelTabStrip
        items={items}
        activeId={activeId}
        label="Terminals"
        addLabel="New terminal"
        addDisabledReason={terminals.length >= TERMINAL_MAX_PER_SCOPE ? TERMINAL_CAP_REASON : undefined}
        onSelect={(ptyId) => useTerminalStore.getState().setActiveTerminal(scopeId, ptyId)}
        onClose={(ptyId) => closeTerminalRecord(workspaceId, threadId, scopeId, ptyId)}
        onAdd={() => createTerminalForScope(scopeId)}
      />
    </PanelHeaderSlot>
  );
}
